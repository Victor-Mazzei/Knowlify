import { lookup as dnsLookup } from "node:dns/promises";
import {
  LLM_DEFAULTS,
  LlmSettingsError,
  evaluateDestination,
  evaluateResolvedDestination,
  isIpLiteral,
  normalizeLlmApiKey,
  normalizeLlmConfig,
  normalizeLlmUrl,
  normalizeLlmModel,
  parseStoredLlmConfig,
  serializeLlmConfig,
  storedLlmConfigIsLegacy,
  urlOrigin,
  type LlmConfigValues,
} from "../domain/assistant/LlmConfig.js";
import {
  type LlmApiStyle,
} from "../domain/assistant/LlmApiStyle.js";
import {
  mergeLlmHeaders,
  normalizeLlmHeaderList,
  readStoredLlmHeaders,
  type LlmHeaderInput,
  type LlmHeaderStored,
  type LlmHeaderView,
} from "../domain/assistant/LlmHeaders.js";
import { LEGACY_SESSION_HEADER } from "../domain/assistant/legacyHeaders.js";
import type { AllowPrivatePolicy } from "../domain/net/IpClassification.js";
import type { Clock, Logger } from "../ports/index.js";
import type {
  HostLookup,
  LlmConfigStore,
  LlmEndpointProbe,
  LlmModelsResult,
  LlmProbeTarget,
  LlmRuntime,
  LlmRuntimeConfig,
  LlmTestResult,
  ProbeCode,
  SecretBox,
} from "../ports/llm-settings.js";

const PROBE_RATE_PER_MIN = 10;
const ADMIN_RATE_PER_MIN = 20;
const RATE_WINDOW_MS = 60_000;

export interface LlmSettingsEnv {
  url: string | null;
  apiKey: string | null;
  model: string | null;
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  apiStyle: LlmApiStyle;
  /** Values from `KNOWLIFY_LLM_HEADERS` (already validated at boot). */
  headers: readonly LlmHeaderStored[];
  /** True when `KNOWLIFY_LLM_HEADERS` is unset and the legacy seed is used (deprecation). */
  legacySessionHeader: boolean;
}

export interface LlmSettingsOptions {
  store: LlmConfigStore;
  secrets: SecretBox;
  runtime: LlmRuntime;
  probes: {
    plain: Readonly<Record<LlmApiStyle, LlmEndpointProbe>>;
    guarded: Readonly<Record<LlmApiStyle, LlmEndpointProbe>>;
  };
  clock: Clock;
  log: Logger;
  env: LlmSettingsEnv;
  locked: boolean;
  policy: AllowPrivatePolicy;
  lookup?: HostLookup;
}

export interface LlmSettingsView {
  source: "env" | "db" | "none";
  locked: boolean;
  enabled: boolean;
  url: string | null;
  model: string | null;
  hasKey: boolean;
  keyState: "none" | "set" | "unreadable";
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  apiStyle: LlmApiStyle;
  /** Names only, in the saved order; values are never returned. */
  headers: LlmHeaderView[];
  headersState: "none" | "set" | "unreadable";
  defaults: { maxTokens: number; timeoutSec: number; ratePerMin: number };
  policy: { allowPrivate: "off" | "on" | "list"; publicRequiresHttps: true };
}

export interface LlmUpdateInput {
  url: string;
  model?: string | null;
  apiKey?: string;
  maxTokens?: number;
  timeoutSec?: number;
  ratePerMin?: number;
  apiStyle?: LlmApiStyle;
  /** Omitted keeps the current list when the origin is unchanged; `[]` clears it. */
  headers?: LlmHeaderInput[];
}

export interface LlmProbeDraft {
  url?: string;
  apiKey?: string;
  model?: string | null;
  apiStyle?: LlmApiStyle;
  headers?: LlmHeaderInput[];
}

interface StoredSettings {
  config: LlmConfigValues;
  sealedKey: string | null;
  sealedHeaders: string | null;
  /** `null` when the sealed blob cannot be read or does not match `headerNames`. */
  headers: LlmHeaderStored[] | null;
}

interface EffectiveSettings {
  source: "env" | "db" | "none";
  config: LlmConfigValues | null;
  key: string | null;
  keyState: "none" | "set" | "unreadable";
  headers: LlmHeaderStored[];
  headersState: "none" | "set" | "unreadable";
}

interface KeyResolution {
  key: string | null;
  sealedKey: string | null;
}

const defaultLookup: HostLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
};

function requiresKey(): LlmSettingsError {
  return new LlmSettingsError("key_required", 400, "An API key is required for this server URL");
}

function policyFailure(verdict: "blocked" | "https_required"): LlmSettingsError {
  if (verdict === "https_required") {
    return new LlmSettingsError("https_required", 400, "Public servers must be reached over HTTPS on port 443");
  }
  return new LlmSettingsError("url_blocked", 400, "This server address is blocked by the network policy");
}

function probeFailure(code: ProbeCode): LlmTestResult {
  return { ok: false, latencyMs: 0, code };
}

/**
 * Assistant configuration use case (ADR-13..17). Database settings replace the whole
 * environment block; the API key and the custom header values are sealed at rest and
 * never leave this layer. The runtime client is swapped only after the new configuration
 * was built and persisted.
 */
export class LlmSettings {
  private stored: StoredSettings | undefined;
  private readonly probeHits: number[] = [];
  private readonly adminHits: number[] = [];
  private probeInFlight = false;
  private readonly lookup: HostLookup;

  constructor(private readonly options: LlmSettingsOptions) {
    this.lookup = options.lookup ?? defaultLookup;
  }

  /** Reads storage once at boot: db wins over env; a locked server ignores the db. */
  bootstrap(): void {
    this.stored = undefined;
    if (this.options.env.legacySessionHeader) {
      this.options.log.warn?.(
        "KNOWLIFY_LLM_HEADERS is not set; the environment configuration uses the legacy session header "
        + "(a configuration saved in Settings takes precedence). Set KNOWLIFY_LLM_HEADERS to an empty value or {} to disable it.",
      );
    }
    if (this.options.locked) {
      this.applyEnv();
      return;
    }
    const row = this.options.store.load();
    if (!row) {
      this.applyEnv();
      return;
    }
    let config: LlmConfigValues;
    try {
      config = parseStoredLlmConfig(row.configJson);
    } catch {
      this.options.log.warn?.("the stored LLM configuration is invalid; using the environment");
      this.applyEnv();
      return;
    }
    this.stored = {
      config,
      sealedKey: row.sealedKey,
      sealedHeaders: row.sealedHeaders,
      headers: this.openHeaders(config, row.sealedHeaders),
    };
    if (storedLlmConfigIsLegacy(row.configJson)) this.seedLegacyHeaders();
    const stored = this.stored ?? {
      config,
      sealedKey: row.sealedKey,
      sealedHeaders: row.sealedHeaders,
      headers: null,
    };
    if (stored.sealedKey && this.openKey(stored.sealedKey) === null) {
      this.options.log.warn?.("the stored LLM key cannot be decrypted; chat stays disabled until a new key is saved");
    }
    if (stored.config.headerNames.length > 0 && stored.headers === null) {
      this.options.log.warn?.(
        "the stored LLM headers cannot be decrypted; chat stays disabled until they are saved again",
      );
    }
    this.applyStored();
  }

  get(): LlmSettingsView {
    const effective = this.effective();
    const config = effective.config;
    const defaults = { ...LLM_DEFAULTS };
    const names = config?.headerNames ?? [];
    return {
      source: effective.source,
      locked: this.options.locked,
      enabled: this.options.runtime.configured,
      url: config?.url ?? null,
      model: config?.model ?? null,
      hasKey: effective.key !== null,
      keyState: effective.keyState,
      maxTokens: config?.maxTokens ?? defaults.maxTokens,
      timeoutSec: config?.timeoutSec ?? defaults.timeoutSec,
      ratePerMin: config?.ratePerMin ?? defaults.ratePerMin,
      apiStyle: config?.apiStyle ?? "openai",
      headers: names.map((name) => ({ name, hasValue: effective.headersState !== "unreadable" })),
      headersState: effective.headersState,
      defaults,
      policy: { allowPrivate: this.options.policy.mode, publicRequiresHttps: true },
    };
  }

  /** Limits used by the next chat turn, read from the effective (db or env) config. */
  currentLimits(): { maxTokens: number; timeoutSec: number; ratePerMin: number } {
    const config = this.effective().config;
    return {
      maxTokens: config?.maxTokens ?? LLM_DEFAULTS.maxTokens,
      timeoutSec: config?.timeoutSec ?? LLM_DEFAULTS.timeoutSec,
      ratePerMin: config?.ratePerMin ?? LLM_DEFAULTS.ratePerMin,
    };
  }

  async update(input: LlmUpdateInput): Promise<LlmSettingsView> {
    this.assertUnlocked();
    this.consumeAdminLimit();
    const effective = this.effective();
    const apiStyle = input.apiStyle ?? effective.config?.apiStyle ?? "openai";
    const base = normalizeLlmConfig({ ...input, apiStyle });
    await this.validateDestination(base.url);

    const existing = effective.headersState === "unreadable" ? [] : effective.headers;
    const sameOrigin = effective.config !== null && urlOrigin(effective.config.url) === urlOrigin(base.url);
    const keptHeaders = sameOrigin && effective.headersState !== "unreadable" ? existing : [];
    let headers: LlmHeaderStored[];
    if (input.headers === undefined) {
      headers = keptHeaders.length > 0 ? normalizeLlmHeaderList(keptHeaders, apiStyle) : [];
    } else {
      headers = mergeLlmHeaders(input.headers, keptHeaders, { sameOrigin, style: apiStyle });
    }
    const next: LlmConfigValues = { ...base, headerNames: headers.map((header) => header.name) };

    const keys = this.resolveUpdateKey(input.apiKey, next.url);
    const sealedHeaders = this.sealHeaders(headers);
    // Build first: an invalid candidate must not touch storage or the running client.
    const client = this.options.runtime.prepare(this.runtimeConfig(next, keys.key, headers, true));
    this.options.store.save({
      configJson: serializeLlmConfig(next),
      sealedKey: keys.sealedKey,
      sealedHeaders,
    });
    this.stored = { config: next, sealedKey: keys.sealedKey, sealedHeaders, headers };
    this.options.runtime.commit(client);
    return this.get();
  }

  /** Removes only the key; the configuration and custom headers stay and chat is disabled. */
  clearKey(): void {
    this.assertUnlocked();
    this.consumeAdminLimit();
    if (!this.stored) return;
    this.options.store.clearKey();
    this.stored = { ...this.stored, sealedKey: null };
    this.applyStored();
  }

  /** Drops the database record: the environment (or no configuration) takes over. */
  reset(): void {
    this.assertUnlocked();
    this.consumeAdminLimit();
    this.options.store.clear();
    this.stored = undefined;
    this.applyEnv();
  }

  async test(draft: LlmProbeDraft = {}): Promise<LlmTestResult> {
    if (this.options.locked && hasDraft(draft)) {
      throw new LlmSettingsError("llm_locked", 403, "The LLM configuration is managed by the server environment");
    }
    return this.withProbe(async (probe, target, keyFailure) => {
      if (keyFailure) return probeFailure("key_required");
      return probe.testChat(target);
    }, draft);
  }

  async listModels(draft: LlmProbeDraft = {}): Promise<LlmModelsResult> {
    if (this.options.locked && hasDraft(draft)) {
      throw new LlmSettingsError("llm_locked", 403, "The LLM configuration is managed by the server environment");
    }
    return this.withProbe(async (probe, target, keyFailure) => {
      if (keyFailure) return { supported: false, models: [], code: "key_required" };
      return probe.listModels(target);
    }, draft);
  }

  private withProbe<T>(
    run: (probe: LlmEndpointProbe, target: LlmProbeTarget, keyFailure: boolean) => Promise<T>,
    draft: LlmProbeDraft,
  ): Promise<T> {
    const prepared = this.prepareProbe(draft);
    this.consumeProbeLimit();
    if (this.probeInFlight) {
      throw new LlmSettingsError("rate_limited", 429, "A connection test is already running", 1);
    }
    this.probeInFlight = true;
    return (async () => {
      try {
        return await run(prepared.probe, prepared.target, prepared.keyFailure);
      } finally {
        this.probeInFlight = false;
      }
    })();
  }

  private prepareProbe(draft: LlmProbeDraft): {
    probe: LlmEndpointProbe;
    target: LlmProbeTarget;
    keyFailure: boolean;
  } {
    const effective = this.effective();
    const hasUrl = draft.url !== undefined;
    const url = hasUrl ? normalizeLlmUrl(draft.url ?? "") : effective.config?.url;
    if (!url) throw new LlmSettingsError("invalid_url", 400, "A server URL is required");
    const model = draft.model !== undefined ? normalizeLlmModel(draft.model) : effective.config?.model ?? null;
    const apiStyle = draft.apiStyle ?? effective.config?.apiStyle ?? "openai";

    const sameOrigin = effective.config !== null && urlOrigin(effective.config.url) === urlOrigin(url);
    const existing = effective.headersState === "unreadable" ? [] : effective.headers;
    const kept = sameOrigin ? existing : [];
    const headers = draft.headers === undefined
      ? (kept.length > 0 ? normalizeLlmHeaderList(kept, apiStyle) : [])
      : mergeLlmHeaders(draft.headers, kept, { sameOrigin, style: apiStyle });

    let key: string | null = null;
    let keyFailure = false;
    if (draft.apiKey !== undefined) {
      key = normalizeLlmApiKey(draft.apiKey);
    } else if (effective.key && effective.config) {
      if (urlOrigin(effective.config.url) === urlOrigin(url)) key = effective.key;
      else keyFailure = true;
    }

    const guarded = hasUrl || effective.source === "db";
    const probes = guarded ? this.options.probes.guarded : this.options.probes.plain;
    return {
      probe: probes[apiStyle],
      target: { url, apiKey: key, model, apiStyle, headers },
      keyFailure,
    };
  }

  private effective(): EffectiveSettings {
    if (this.options.locked) return this.envEffective();
    if (this.stored) {
      const key = this.stored.sealedKey ? this.openKey(this.stored.sealedKey) : null;
      const unreadable = this.stored.config.headerNames.length > 0 && this.stored.headers === null;
      const headers = this.stored.headers ?? [];
      return {
        source: "db",
        config: this.stored.config,
        key,
        keyState: this.stored.sealedKey ? (key ? "set" : "unreadable") : "none",
        headers: unreadable ? [] : headers,
        headersState: unreadable ? "unreadable" : headers.length > 0 ? "set" : "none",
      };
    }
    return this.envEffective();
  }

  private envEffective(): EffectiveSettings {
    const config = this.envConfig();
    if (!config) return { source: "none", config: null, key: null, keyState: "none", headers: [], headersState: "none" };
    const key = this.options.env.apiKey;
    const headers = [...this.options.env.headers];
    return {
      source: "env",
      config,
      key,
      keyState: key ? "set" : "none",
      headers,
      headersState: headers.length > 0 ? "set" : "none",
    };
  }

  private envConfig(): LlmConfigValues | null {
    const env = this.options.env;
    if (!env.url) return null;
    return {
      url: env.url,
      model: env.model,
      maxTokens: env.maxTokens,
      timeoutSec: env.timeoutSec,
      ratePerMin: env.ratePerMin,
      apiStyle: env.apiStyle,
      headerNames: env.headers.map((header) => header.name),
    };
  }

  private openKey(sealed: string): string | null {
    try {
      return this.options.secrets.open(sealed);
    } catch {
      return null;
    }
  }

  private openHeaders(config: LlmConfigValues, sealed: string | null): LlmHeaderStored[] | null {
    if (config.headerNames.length === 0) return [];
    if (!sealed) return null;
    try {
      return readStoredLlmHeaders(JSON.parse(this.options.secrets.open(sealed)), config.headerNames, config.apiStyle);
    } catch {
      return null;
    }
  }

  /**
   * One-time compatibility seed for rows written before custom headers existed. A failed
   * seal/save keeps the row legacy, so the next boot retries; chat works without headers.
   */
  private seedLegacyHeaders(): void {
    const stored = this.stored;
    if (!stored || stored.config.headerNames.length > 0) return;
    const headers = [{ ...LEGACY_SESSION_HEADER }];
    let sealed: string | null;
    try {
      sealed = this.sealHeaders(headers);
    } catch {
      this.options.log.warn?.("the legacy LLM session header could not be encrypted; chat continues without custom headers");
      return;
    }
    if (!sealed) return;
    const next: LlmConfigValues = { ...stored.config, headerNames: headers.map((header) => header.name) };
    try {
      this.options.store.save({
        configJson: serializeLlmConfig(next),
        sealedKey: stored.sealedKey,
        sealedHeaders: sealed,
      });
    } catch {
      this.options.log.warn?.("the legacy LLM session header could not be saved; chat continues without custom headers");
      return;
    }
    this.stored = { ...stored, config: next, sealedHeaders: sealed, headers };
  }

  private applyEnv(): void {
    const config = this.envConfig();
    this.apply(config, config ? this.options.env.apiKey : null, [...this.options.env.headers], false);
  }

  private applyStored(): void {
    if (!this.stored) {
      this.applyEnv();
      return;
    }
    const key = this.stored.sealedKey ? this.openKey(this.stored.sealedKey) : null;
    this.apply(this.stored.config, key, this.stored.headers, true);
  }

  private apply(
    config: LlmConfigValues | null,
    key: string | null,
    headers: readonly LlmHeaderStored[] | null,
    guard: boolean,
  ): void {
    if (config === null || headers === null) {
      this.options.runtime.commit(this.options.runtime.prepare(null));
      return;
    }
    this.options.runtime.commit(this.options.runtime.prepare(this.runtimeConfig(config, key, headers, guard)));
  }

  private runtimeConfig(
    config: LlmConfigValues | null,
    key: string | null,
    headers: readonly LlmHeaderStored[],
    guard: boolean,
  ): LlmRuntimeConfig | null {
    if (!config || !config.model || !key) return null;
    return {
      url: config.url,
      apiKey: key,
      model: config.model,
      timeoutSec: config.timeoutSec,
      apiStyle: config.apiStyle,
      headers,
      guard,
    };
  }

  private sealHeaders(headers: readonly LlmHeaderStored[]): string | null {
    if (headers.length === 0) return null;
    return this.options.secrets.seal(
      JSON.stringify(Object.fromEntries(headers.map((header) => [header.name, header.value]))),
    );
  }

  private resolveUpdateKey(inputKey: string | undefined, url: string): KeyResolution {
    if (inputKey !== undefined) {
      const key = normalizeLlmApiKey(inputKey);
      return { key, sealedKey: this.options.secrets.seal(key) };
    }
    if (this.stored?.sealedKey) {
      const existing = this.openKey(this.stored.sealedKey);
      if (!existing) return { key: null, sealedKey: null };
      if (urlOrigin(this.stored.config.url) !== urlOrigin(url)) throw requiresKey();
      return { key: existing, sealedKey: this.stored.sealedKey };
    }
    // First move from env to db: copy the operator key so the user does not retype it,
    // but only to the origin it belongs to (ADR-14). A different origin must present
    // its own key, otherwise a saved request could exfiltrate the operator secret.
    if (!this.stored && this.options.env.url && this.options.env.apiKey) {
      if (urlOrigin(this.options.env.url) !== urlOrigin(url)) throw requiresKey();
      const key = this.options.env.apiKey;
      return { key, sealedKey: this.options.secrets.seal(key) };
    }
    return { key: null, sealedKey: null };
  }

  private async validateDestination(url: string): Promise<void> {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIpLiteral(hostname)) {
      const verdict = evaluateDestination(parsed, hostname, this.options.policy);
      if (verdict !== "ok") throw policyFailure(verdict);
      return;
    }
    let addresses: readonly string[];
    try {
      addresses = (await this.lookup(hostname)).map((entry) => entry.address);
    } catch {
      // A DNS failure must not prevent saving: the provider may be offline right now.
      // The strong guarantee is the lookup performed by the guarded connection.
      return;
    }
    if (addresses.length === 0) return;
    const verdict = evaluateResolvedDestination(parsed, addresses, this.options.policy);
    if (verdict !== "ok") throw policyFailure(verdict);
  }

  private assertUnlocked(): void {
    if (!this.options.locked) return;
    throw new LlmSettingsError("llm_locked", 403, "The LLM configuration is managed by the server environment");
  }

  private consumeAdminLimit(): void {
    this.consume(this.adminHits, ADMIN_RATE_PER_MIN);
  }

  private consumeProbeLimit(): void {
    this.consume(this.probeHits, PROBE_RATE_PER_MIN);
  }

  private consume(hits: number[], limit: number): void {
    const now = this.options.clock.now();
    const since = now - RATE_WINDOW_MS;
    while (hits.length > 0 && (hits[0] ?? now) <= since) hits.shift();
    if (hits.length >= limit) {
      const oldest = hits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      throw new LlmSettingsError("rate_limited", 429, "Too many configuration requests; retry shortly", retryAfterSec);
    }
    hits.push(now);
  }
}

function hasDraft(draft: LlmProbeDraft): boolean {
  return draft.url !== undefined
    || draft.apiKey !== undefined
    || draft.model !== undefined
    || draft.apiStyle !== undefined
    || draft.headers !== undefined;
}
