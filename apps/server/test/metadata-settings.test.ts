import { describe, expect, it } from "vitest";
import { AesGcmSecretBox } from "../src/adapters/security/SecretBox.js";
import { MetadataSettingsError } from "../src/domain/library/MetadataSettings.js";
import type { MetadataConfigStore, StoredMetadataSettings } from "../src/ports/metadata-settings.js";
import type { Logger } from "../src/ports/index.js";
import { MetadataSettings, type MetadataSettingsEnv } from "../src/use-cases/MetadataSettings.js";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "t".repeat(32);
const ENV_KEY = "env-key-sentinel-fixture";
const USER_KEY = "user-key-sentinel-fixture";

class MemoryStore implements MetadataConfigStore {
  record: StoredMetadataSettings = { lookupEnabled: null, sealedKey: null };
  saves = 0;

  load(): StoredMetadataSettings {
    return this.record;
  }

  save(settings: StoredMetadataSettings): void {
    this.record = settings;
    this.saves += 1;
  }
}

class RecordingLogger implements Logger {
  readonly entries: string[] = [];
  info(message: string): void { this.entries.push(`info:${message}`); }
  error(error: unknown, message: string): void { this.entries.push(`error:${message}:${String(error)}`); }
  warn(message: string): void { this.entries.push(`warn:${message}`); }
}

function fixture(options: {
  env?: Partial<MetadataSettingsEnv>;
  locked?: boolean;
  row?: StoredMetadataSettings;
  writeRatePerMin?: number;
  now?: () => number;
} = {}) {
  const store = new MemoryStore();
  if (options.row) store.record = options.row;
  const log = new RecordingLogger();
  const secrets = new AesGcmSecretBox(SECRET);
  const settings = new MetadataSettings({
    store,
    secrets,
    env: { lookup: true, googleBooksApiKey: null, ...options.env },
    locked: options.locked ?? false,
    log,
    clock: { now: options.now ?? (() => 0) },
    writeRatePerMin: options.writeRatePerMin,
  });
  settings.bootstrap();
  return { settings, store, log, secrets };
}

function errorOf(run: () => unknown): MetadataSettingsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataSettingsError);
    return error as MetadataSettingsError;
  }
  throw new Error("expected a metadata settings error");
}

const emptyGoogleBooks = { hasKey: false, keyState: "none", source: "none" } as const;

describe("MetadataSettings view", () => {
  it("reports the environment defaults with the exact contract shape", () => {
    const { settings } = fixture();
    expect(settings.get()).toEqual({
      lookupEnabled: true,
      lookupSource: "env",
      googleBooks: { ...emptyGoogleBooks },
      locked: false,
      providers: ["openlibrary", "googlebooks"],
    });
  });

  it("reports an environment lookup switch and key without exposing the key", () => {
    const { settings, log } = fixture({ env: { lookup: false, googleBooksApiKey: ENV_KEY } });
    const view = settings.get();
    expect(view).toEqual({
      lookupEnabled: false,
      lookupSource: "env",
      googleBooks: { hasKey: true, keyState: "ok", source: "env" },
      locked: false,
      providers: ["openlibrary", "googlebooks"],
    });
    expect(settings.isLookupEnabled()).toBe(false);
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: ENV_KEY });
    expect(JSON.stringify(view)).not.toContain(ENV_KEY);
    expect(JSON.stringify(log.entries)).not.toContain(ENV_KEY);
  });

  it("lets the database override the environment toggle and key", () => {
    const sealed = new AesGcmSecretBox(SECRET).seal(USER_KEY);
    const { settings, log } = fixture({
      env: { lookup: false, googleBooksApiKey: ENV_KEY },
      row: { lookupEnabled: true, sealedKey: sealed },
    });
    const view = settings.get();
    expect(view).toEqual({
      lookupEnabled: true,
      lookupSource: "user",
      googleBooks: { hasKey: true, keyState: "ok", source: "user" },
      locked: false,
      providers: ["openlibrary", "googlebooks"],
    });
    expect(settings.isLookupEnabled()).toBe(true);
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: USER_KEY });
    expect(JSON.stringify(view)).not.toContain(USER_KEY);
    expect(JSON.stringify(log.entries)).not.toContain(USER_KEY);
  });

  it("keeps a stored false override instead of falling back to an enabled environment", () => {
    const { settings } = fixture({ env: { lookup: true }, row: { lookupEnabled: false, sealedKey: null } });
    expect(settings.get()).toMatchObject({ lookupEnabled: false, lookupSource: "user" });
    expect(settings.isLookupEnabled()).toBe(false);
  });

  it("reports an unreadable stored key and fails closed", () => {
    const sealed = new AesGcmSecretBox(OTHER_SECRET).seal(USER_KEY);
    const { settings, log } = fixture({ row: { lookupEnabled: true, sealedKey: sealed } });
    expect(settings.get()).toMatchObject({
      lookupSource: "user",
      googleBooks: { hasKey: true, keyState: "unreadable", source: "user" },
    });
    expect(settings.googleBooksKey()).toEqual({ state: "unreadable" });
    expect(JSON.stringify(settings.get())).not.toContain(USER_KEY);
    expect(log.entries).toContain(
      "warn:the saved Google Books key cannot be decrypted; metadata lookup uses Open Library only until the key is saved again",
    );
    expect(log.entries.join(" ")).not.toContain(USER_KEY);
  });

  it("ignores the database and reports the environment when locked", () => {
    const sealed = new AesGcmSecretBox(SECRET).seal(USER_KEY);
    const { settings } = fixture({
      env: { lookup: true, googleBooksApiKey: ENV_KEY },
      locked: true,
      row: { lookupEnabled: false, sealedKey: sealed },
    });
    expect(settings.get()).toEqual({
      lookupEnabled: true,
      lookupSource: "env",
      googleBooks: { hasKey: true, keyState: "ok", source: "env" },
      locked: true,
      providers: ["openlibrary", "googlebooks"],
    });
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: ENV_KEY });
  });
});

describe("MetadataSettings updates", () => {
  it("saves the toggle and seals the key, never returning the plaintext", () => {
    const { settings, store, log } = fixture({ env: { lookup: false } });
    const view = settings.update({ lookupEnabled: true, googleBooksKey: USER_KEY });
    expect(view).toEqual({
      lookupEnabled: true,
      lookupSource: "user",
      googleBooks: { hasKey: true, keyState: "ok", source: "user" },
      locked: false,
      providers: ["openlibrary", "googlebooks"],
    });
    expect(store.record.lookupEnabled).toBe(true);
    expect(store.record.sealedKey).toMatch(/^v1:/);
    expect(store.record.sealedKey).not.toContain(USER_KEY);
    expect(JSON.stringify(store.record)).not.toContain(USER_KEY);
    expect(JSON.stringify(view)).not.toContain(USER_KEY);
    expect(JSON.stringify(log.entries)).not.toContain(USER_KEY);
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: USER_KEY });
  });

  it("removes only the user key and falls back to the environment key", () => {
    const { settings, store } = fixture({ env: { googleBooksApiKey: ENV_KEY } });
    settings.update({ googleBooksKey: USER_KEY });
    expect(settings.get()).toMatchObject({ googleBooks: { hasKey: true, source: "user" } });

    const removed = settings.update({ googleBooksKey: null });
    expect(removed).toEqual({
      lookupEnabled: true,
      lookupSource: "env",
      googleBooks: { hasKey: true, keyState: "ok", source: "env" },
      locked: false,
      providers: ["openlibrary", "googlebooks"],
    });
    expect(store.record.sealedKey).toBeNull();
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: ENV_KEY });
  });

  it("removing a key is a coherent no-op when only the environment has one", () => {
    const { settings, store } = fixture({ env: { googleBooksApiKey: ENV_KEY } });
    const before = settings.get();
    const after = settings.update({ googleBooksKey: null });
    expect(after).toEqual(before);
    expect(store.record.sealedKey).toBeNull();
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: ENV_KEY });
  });

  it("keeps omitted fields and repairs an unreadable key by saving a new one", () => {
    const sealed = new AesGcmSecretBox(OTHER_SECRET).seal(USER_KEY);
    const { settings, store } = fixture({ row: { lookupEnabled: false, sealedKey: sealed } });
    expect(settings.get()).toMatchObject({ lookupEnabled: false, googleBooks: { keyState: "unreadable" } });

    const repaired = settings.update({ googleBooksKey: USER_KEY });
    expect(repaired).toMatchObject({
      lookupEnabled: false,
      lookupSource: "user",
      googleBooks: { hasKey: true, keyState: "ok", source: "user" },
    });
    expect(store.record.lookupEnabled).toBe(false);
    expect(settings.googleBooksKey()).toEqual({ state: "ok", key: USER_KEY });
  });

  it("rejects locked servers with 403 metadata_locked and keeps storage untouched", () => {
    const { settings, store } = fixture({ locked: true, env: { googleBooksApiKey: ENV_KEY } });
    const error = errorOf(() => settings.update({ lookupEnabled: false }));
    expect(error.code).toBe("metadata_locked");
    expect(error.status).toBe(403);
    expect(store.saves).toBe(0);
    expect(JSON.stringify(error.message)).not.toContain(ENV_KEY);
  });

  it("rejects invalid bodies, unknown fields and unsafe keys with stable codes", () => {
    const { settings } = fixture({ writeRatePerMin: 100 });
    const cases: Array<[unknown, string, string]> = [
      [{}, "invalid_settings", "body"],
      [[], "invalid_settings", "body"],
      [null, "invalid_settings", "body"],
      [{ unknown: true }, "invalid_settings", "unknown"],
      [{ lookupEnabled: "on" }, "invalid_settings", "lookupEnabled"],
      [{ googleBooksKey: 42 }, "invalid_google_books_key", "googleBooksKey"],
      [{ googleBooksKey: "" }, "invalid_google_books_key", "googleBooksKey"],
      [{ googleBooksKey: "   " }, "invalid_google_books_key", "googleBooksKey"],
      [{ googleBooksKey: "key with space" }, "invalid_google_books_key", "googleBooksKey"],
      [{ googleBooksKey: "key\twith\ttab" }, "invalid_google_books_key", "googleBooksKey"],
      [{ googleBooksKey: "x".repeat(257) }, "invalid_google_books_key", "googleBooksKey"],
    ];
    for (const [body, code, field] of cases) {
      const error = errorOf(() => settings.update(body));
      expect(error.status).toBe(400);
      expect(error.code).toBe(code);
      expect(error.field).toBe(field);
      expect(`${error.message} ${error.code} ${error.field ?? ""}`).not.toContain(USER_KEY);
    }
  });

  it("rate limits writes with 429 and Retry-After data", () => {
    let now = 1_000;
    const { settings } = fixture({ writeRatePerMin: 2, now: () => now });
    settings.update({ lookupEnabled: true });
    settings.update({ lookupEnabled: false });
    const error = errorOf(() => settings.update({ lookupEnabled: true }));
    expect(error.code).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(60);
    now += 60_000;
    expect(() => settings.update({ lookupEnabled: true })).not.toThrow();
  });
});
