import {
  METADATA_KEY_MAX_CHARS,
  MetadataSettingsError,
  normalizeGoogleBooksKey,
} from "../domain/library/MetadataSettings.js";
import type { GoogleBooksKeyResolution } from "../ports/library-metadata.js";
import type { MetadataConfigStore, StoredMetadataSettings } from "../ports/metadata-settings.js";
import type { SecretBox } from "../ports/llm-settings.js";
import type { Clock, Logger } from "../ports/index.js";

const WRITE_RATE_PER_MIN = 20;
const RATE_WINDOW_MS = 60_000;
const UPDATE_FIELDS = new Set(["lookupEnabled", "googleBooksKey"]);

export interface MetadataSettingsEnv {
  /** `KNOWLIFY_METADATA_LOOKUP`; the seed when the user never saved a toggle. */
  lookup: boolean;
  /** `KNOWLIFY_GOOGLE_BOOKS_API_KEY`; the fallback when the user never saved a key. */
  googleBooksApiKey: string | null;
}

export interface MetadataSettingsOptions {
  store: MetadataConfigStore;
  secrets: SecretBox;
  env: MetadataSettingsEnv;
  /** `KNOWLIFY_METADATA_LOCKED`: the environment wins and PUT answers 403. */
  locked: boolean;
  clock?: Clock;
  log?: Logger;
  /** Test seam; defaults to the documented 20 writes per minute. */
  writeRatePerMin?: number;
}

export interface MetadataSettingsView {
  lookupEnabled: boolean;
  lookupSource: "env" | "user";
  googleBooks: {
    hasKey: boolean;
    keyState: "ok" | "unreadable" | "none";
    source: "env" | "user" | "none";
  };
  locked: boolean;
  providers: Array<"openlibrary" | "googlebooks">;
}

interface EffectiveSettings {
  lookupEnabled: boolean;
  lookupSource: "env" | "user";
  key: string | null;
  keyState: "ok" | "unreadable" | "none";
  keySource: "env" | "user" | "none";
}

interface NormalizedUpdate {
  hasLookupEnabled: boolean;
  lookupEnabled: boolean | undefined;
  hasKey: boolean;
  googleBooksKey: string | null | undefined;
}

const emptyStored = (): StoredMetadataSettings => ({ lookupEnabled: null, sealedKey: null });

const invalidSettings = (message: string, field: string): never => {
  throw new MetadataSettingsError("invalid_settings", 400, message, field);
};

function normalizeUpdate(raw: unknown): NormalizedUpdate {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return invalidSettings("The request body must be a JSON object", "body");
  }
  const body = raw as Record<string, unknown>;
  const fields = Object.keys(body);
  if (fields.length === 0) return invalidSettings("Provide lookupEnabled or googleBooksKey", "body");
  for (const field of fields) {
    if (!UPDATE_FIELDS.has(field)) return invalidSettings(`Unknown field: ${field}`, field);
  }
  const hasLookupEnabled = "lookupEnabled" in body;
  if (hasLookupEnabled && typeof body.lookupEnabled !== "boolean") {
    return invalidSettings("lookupEnabled must be a boolean", "lookupEnabled");
  }
  const hasKey = "googleBooksKey" in body;
  const googleBooksKey = hasKey && body.googleBooksKey !== null
    ? normalizeGoogleBooksKey(body.googleBooksKey)
    : null;
  return {
    hasLookupEnabled,
    lookupEnabled: hasLookupEnabled ? body.lookupEnabled as boolean : undefined,
    hasKey,
    googleBooksKey,
  };
}

/**
 * Online metadata settings (ADR-4/ADR-5), mirroring the LLM key pattern: the database
 * overrides the environment, the key is sealed with AES-256-GCM and never leaves this
 * layer, and a locked server ignores the database. Values are resolved on every call so
 * a save applies to the running provider adapters without a restart.
 */
export class MetadataSettings {
  private stored: StoredMetadataSettings = emptyStored();
  private readonly writeHits: number[] = [];
  private readonly writeRatePerMin: number;
  private readonly now: () => number;

  constructor(private readonly options: MetadataSettingsOptions) {
    this.writeRatePerMin = Math.max(1, options.writeRatePerMin ?? WRITE_RATE_PER_MIN);
    const clock = options.clock;
    this.now = clock ? () => clock.now() : Date.now;
  }

  /** Reads storage once at boot; a locked server never looks at the database. */
  bootstrap(): void {
    this.stored = emptyStored();
    if (this.options.locked) return;
    const row = this.options.store.load();
    this.stored = {
      lookupEnabled: row.lookupEnabled,
      sealedKey: row.sealedKey,
    };
    if (row.sealedKey !== null && this.openKey(row.sealedKey) === null) {
      this.options.log?.warn?.(
        "the saved Google Books key cannot be decrypted; metadata lookup uses Open Library only until the key is saved again",
      );
    }
  }

  get(): MetadataSettingsView {
    const effective = this.effective();
    return {
      lookupEnabled: effective.lookupEnabled,
      lookupSource: effective.lookupSource,
      googleBooks: {
        hasKey: effective.keyState !== "none",
        keyState: effective.keyState,
        source: effective.keySource,
      },
      locked: this.options.locked,
      providers: ["openlibrary", "googlebooks"],
    };
  }

  /** Read by the lookup use case on every search so the toggle needs no restart. */
  isLookupEnabled(): boolean {
    return this.effective().lookupEnabled;
  }

  /** Read by the Google Books adapter on every request; never escaped or logged. */
  googleBooksKey(): GoogleBooksKeyResolution {
    const effective = this.effective();
    if (effective.keyState === "unreadable") return { state: "unreadable" };
    if (effective.key === null) return { state: "none" };
    return { state: "ok", key: effective.key };
  }

  /** `googleBooksKey: null` removes only the user key; an omitted field is unchanged. */
  update(raw: unknown): MetadataSettingsView {
    this.assertUnlocked();
    this.consumeWriteLimit();
    const input = normalizeUpdate(raw);
    const lookupEnabled = input.hasLookupEnabled ? input.lookupEnabled ?? null : this.stored.lookupEnabled;
    let sealedKey = this.stored.sealedKey;
    if (input.hasKey) {
      sealedKey = input.googleBooksKey == null ? null : this.options.secrets.seal(input.googleBooksKey);
    }
    this.options.store.save({ lookupEnabled, sealedKey });
    this.stored = { lookupEnabled, sealedKey };
    return this.get();
  }

  private effective(): EffectiveSettings {
    if (this.options.locked) return this.envEffective();
    const stored = this.stored;
    const lookupEnabled = stored.lookupEnabled ?? this.options.env.lookup;
    const lookupSource: EffectiveSettings["lookupSource"] = stored.lookupEnabled === null ? "env" : "user";
    if (stored.sealedKey !== null) {
      const key = this.openKey(stored.sealedKey);
      return {
        lookupEnabled,
        lookupSource,
        key,
        keyState: key === null ? "unreadable" : "ok",
        keySource: "user",
      };
    }
    const envKey = this.options.env.googleBooksApiKey;
    return {
      lookupEnabled,
      lookupSource,
      key: envKey,
      keyState: envKey === null ? "none" : "ok",
      keySource: envKey === null ? "none" : "env",
    };
  }

  private envEffective(): EffectiveSettings {
    const key = this.options.env.googleBooksApiKey;
    return {
      lookupEnabled: this.options.env.lookup,
      lookupSource: "env",
      key,
      keyState: key === null ? "none" : "ok",
      keySource: key === null ? "none" : "env",
    };
  }

  private openKey(sealed: string): string | null {
    try {
      const key = this.options.secrets.open(sealed);
      return key.length > 0 ? key : null;
    } catch {
      return null;
    }
  }

  private assertUnlocked(): void {
    if (!this.options.locked) return;
    throw new MetadataSettingsError(
      "metadata_locked",
      403,
      "Metadata settings are managed by the server environment",
    );
  }

  private consumeWriteLimit(): void {
    const now = this.now();
    const since = now - RATE_WINDOW_MS;
    while (this.writeHits.length > 0 && (this.writeHits[0] ?? now) <= since) this.writeHits.shift();
    if (this.writeHits.length >= this.writeRatePerMin) {
      const oldest = this.writeHits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      throw new MetadataSettingsError(
        "rate_limited",
        429,
        "Too many metadata settings changes; retry shortly",
        undefined,
        retryAfterSec,
      );
    }
    this.writeHits.push(now);
  }
}
