import { describe, expect, it } from "vitest";
import { AesGcmSecretBox } from "../src/adapters/security/SecretBox.js";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { LlmSettingsError } from "../src/domain/assistant/LlmConfig.js";
import { LEGACY_SESSION_HEADER } from "../src/domain/assistant/legacyHeaders.js";
import type { LlmClient, LlmEvent, LlmRequest } from "../src/ports/assistant.js";
import type { HostLookup, LlmConfigStore, LlmEndpointProbe, LlmModelsResult, LlmProbeTarget, LlmRuntime, LlmRuntimeConfig, LlmTestResult, StoredLlmSettings } from "../src/ports/llm-settings.js";
import type { AllowPrivatePolicy } from "../src/domain/net/IpClassification.js";
import { LlmSettings, type LlmSettingsEnv } from "../src/use-cases/LlmSettings.js";

const SECRET = "s".repeat(32);
const ENV_KEY = "env-key-12345";

class MemoryStore implements LlmConfigStore {
  record: StoredLlmSettings | undefined;
  failSave = false;

  load(): StoredLlmSettings | undefined {
    return this.record;
  }

  save(settings: StoredLlmSettings): void {
    if (this.failSave) throw new Error("disk full");
    this.record = settings;
  }

  clear(): void {
    this.record = undefined;
  }

  clearKey(): void {
    if (this.record) this.record = { ...this.record, sealedKey: null };
  }
}

class FakeClient implements LlmClient {
  readonly configured = true;
  readonly model: string;
  readonly host: string;

  constructor(config: LlmRuntimeConfig) {
    this.model = config.model;
    this.host = new URL(config.url).hostname;
  }

  async *stream(_request: LlmRequest, _signal: AbortSignal): AsyncIterable<LlmEvent> {
    throw new Error("not used in this test");
  }
}

class FakeRuntime implements LlmRuntime {
  current: LlmClient = new NoLlmClient();
  readonly configs: (LlmRuntimeConfig | null)[] = [];
  commits = 0;
  failPrepare = false;

  get configured(): boolean {
    return this.current.configured;
  }

  prepare(config: LlmRuntimeConfig | null): LlmClient {
    if (this.failPrepare) throw new Error("invalid candidate");
    this.configs.push(config);
    return config ? new FakeClient(config) : new NoLlmClient();
  }

  commit(client: LlmClient): void {
    this.current = client;
    this.commits += 1;
  }
}

class FakeProbe implements LlmEndpointProbe {
  readonly calls: LlmProbeTarget[] = [];
  models: LlmModelsResult = { supported: true, models: ["m"] };
  test: LlmTestResult = { ok: true, latencyMs: 3, modelFound: true };

  async listModels(target: LlmProbeTarget): Promise<LlmModelsResult> {
    this.calls.push(target);
    return this.models;
  }

  async testChat(target: LlmProbeTarget): Promise<LlmTestResult> {
    this.calls.push(target);
    return this.test;
  }
}

class RecordingLogger {
  readonly entries: string[] = [];
  info(message: string): void { this.entries.push(`info:${message}`); }
  error(error: unknown, message: string): void { this.entries.push(`error:${message}:${String(error)}`); }
  warn(message: string): void { this.entries.push(`warn:${message}`); }
}

const BARE_ENV: LlmSettingsEnv = {
  url: null,
  apiKey: null,
  model: null,
  maxTokens: 1024,
  timeoutSec: 120,
  ratePerMin: 20,
  apiStyle: "openai",
  headers: [],
  legacySessionHeader: false,
};

function fixture(overrides: {
  env?: Partial<LlmSettingsEnv>;
  locked?: boolean;
  policy?: AllowPrivatePolicy;
  lookup?: HostLookup;
} = {}) {
  const store = new MemoryStore();
  const secrets = new AesGcmSecretBox(SECRET);
  const runtime = new FakeRuntime();
  const plainOpenAi = new FakeProbe();
  const plainAnthropic = new FakeProbe();
  const guardedOpenAi = new FakeProbe();
  const guardedAnthropic = new FakeProbe();
  const log = new RecordingLogger();
  let now = 1_000;
  const settings = new LlmSettings({
    store,
    secrets,
    runtime,
    probes: {
      plain: { openai: plainOpenAi, anthropic: plainAnthropic },
      guarded: { openai: guardedOpenAi, anthropic: guardedAnthropic },
    },
    clock: { now: () => now },
    log,
    env: { ...BARE_ENV, ...overrides.env },
    locked: overrides.locked ?? false,
    policy: overrides.policy ?? { mode: "on" },
    lookup: overrides.lookup ?? (async () => [{ address: "127.0.0.1", family: 4 }]),
  });
  return {
    store,
    secrets,
    runtime,
    plain: plainOpenAi,
    plainAnthropic,
    guarded: guardedOpenAi,
    guardedAnthropic,
    log,
    settings,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

function expectSettingsError(run: () => unknown | Promise<unknown>, code: string, status: number) {
  return Promise.resolve()
    .then(run)
    .then(
      () => { throw new Error(`expected ${code}`); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(LlmSettingsError);
        expect(error).toMatchObject({ code, status });
        return error as LlmSettingsError;
      },
    );
}

describe("LlmSettings use case", () => {
  it("boots from the environment with the documented view and limits", () => {
    const { settings, runtime, store } = fixture({
      env: {
        url: "https://api.example.com/v1",
        apiKey: ENV_KEY,
        model: "env-model",
        maxTokens: 2048,
        timeoutSec: 30,
        ratePerMin: 7,
      },
    });
    settings.bootstrap();
    expect(store.record).toBeUndefined();
    expect(runtime.configs).toEqual([{
      url: "https://api.example.com/v1",
      apiKey: ENV_KEY,
      model: "env-model",
      timeoutSec: 30,
      apiStyle: "openai",
      headers: [],
      guard: false,
    }]);
    expect(settings.get()).toEqual({
      source: "env",
      locked: false,
      enabled: true,
      url: "https://api.example.com/v1",
      model: "env-model",
      hasKey: true,
      keyState: "set",
      maxTokens: 2048,
      timeoutSec: 30,
      ratePerMin: 7,
      apiStyle: "openai",
      headers: [],
      headersState: "none",
      defaults: { maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 },
      policy: { allowPrivate: "on", publicRequiresHttps: true },
    });
    expect(settings.currentLimits()).toEqual({ maxTokens: 2048, timeoutSec: 30, ratePerMin: 7 });
  });

  it("reports `none` with defaults when neither env nor db is configured", () => {
    const { settings } = fixture();
    settings.bootstrap();
    expect(settings.get()).toMatchObject({
      source: "none",
      enabled: false,
      url: null,
      model: null,
      hasKey: false,
      keyState: "none",
      maxTokens: 1024,
      timeoutSec: 120,
      ratePerMin: 20,
    });
  });

  it("persists a db config with a sealed key and applies the guarded client", async () => {
    const { settings, store, runtime, secrets } = fixture();
    settings.bootstrap();
    const key = "sk-live-sentinel-value";
    const view = await settings.update({
      url: "http://127.0.0.1:11434/v1/",
      apiKey: key,
      model: "llama",
      maxTokens: 2048,
      timeoutSec: 30,
      ratePerMin: 5,
    });
    expect(view).toMatchObject({
      source: "db",
      enabled: true,
      url: "http://127.0.0.1:11434/v1",
      model: "llama",
      hasKey: true,
      keyState: "set",
      maxTokens: 2048,
      timeoutSec: 30,
      ratePerMin: 5,
    });
    expect(store.record?.configJson).not.toContain(key);
    expect(store.record?.sealedKey).toMatch(/^v1:/);
    expect(secrets.open(store.record?.sealedKey ?? "")).toBe(key);
    expect(JSON.stringify(view)).not.toContain(key);
    expect(runtime.configs.at(-1)).toMatchObject({ guard: true, apiKey: key, model: "llama" });
  });

  it("copies the environment key on the first db save only for the same origin", async () => {
    const { settings, store, secrets, runtime } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    settings.bootstrap();
    await settings.update({ url: "https://api.example.com/other", model: "db-model" });
    expect(store.record?.sealedKey).not.toBeNull();
    expect(secrets.open(store.record?.sealedKey ?? "")).toBe(ENV_KEY);
    expect(runtime.configs.at(-1)).toMatchObject({ apiKey: ENV_KEY, guard: true });
  });

  it("rejects the first db save from another origin instead of copying the environment key", async () => {
    const { settings, store, runtime } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    settings.bootstrap();
    const configs = runtime.configs.length;
    const commits = runtime.commits;
    await expectSettingsError(
      () => settings.update({ url: "https://attacker.example.net/v1", model: "m" }),
      "key_required",
      400,
    );
    expect(store.record).toBeUndefined();
    expect(runtime.configs).toHaveLength(configs);
    expect(runtime.commits).toBe(commits);
    expect(settings.get()).toMatchObject({
      source: "env",
      url: "https://api.example.com/v1",
      enabled: true,
    });
  });

  it("never sends the stored key to a different origin", async () => {
    const { settings, store } = fixture();
    settings.bootstrap();
    await settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk-original",
      model: "m",
    });
    const sealed = store.record?.sealedKey;
    await expectSettingsError(
      () => settings.update({ url: "http://127.0.0.1:11435/v1", model: "m" }),
      "key_required",
      400,
    );
    await settings.update({ url: "http://127.0.0.1:11434/other", model: "m" });
    expect(store.record?.sealedKey).toBe(sealed);
  });

  it("clears the key without dropping the URL and disables chat until a new key", async () => {
    const { settings, runtime } = fixture();
    settings.bootstrap();
    await settings.update({ url: "http://127.0.0.1:11434/v1", apiKey: "sk-original", model: "m" });
    expect(settings.get().enabled).toBe(true);
    settings.clearKey();
    expect(settings.get()).toMatchObject({ source: "db", enabled: false, hasKey: false, keyState: "none" });
    expect(runtime.current.configured).toBe(false);
  });

  it("resets to the environment record", async () => {
    const { settings, store } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    settings.bootstrap();
    await settings.update({ url: "http://127.0.0.1:11434/v1", apiKey: "sk-db", model: "m" });
    expect(settings.get().source).toBe("db");
    settings.reset();
    expect(store.record).toBeUndefined();
    expect(settings.get()).toMatchObject({ source: "env", url: "https://api.example.com/v1", enabled: true });
  });

  it("ignores the db and blocks writes while the server is locked", async () => {
    const { settings, store, plain, guarded, runtime, log } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
      locked: true,
    });
    store.record = {
      configJson: JSON.stringify({ url: "http://127.0.0.1:11434/v1", model: "db", maxTokens: 5, timeoutSec: 5, ratePerMin: 1 }),
      sealedKey: null,
      sealedHeaders: null,
    };
    settings.bootstrap();
    expect(settings.get()).toMatchObject({ source: "env", locked: true, url: "https://api.example.com/v1" });
    expect(runtime.configs.at(-1)).toMatchObject({ guard: false });
    await expectSettingsError(
      () => settings.update({ url: "http://127.0.0.1:11434/v1" }),
      "llm_locked",
      403,
    );
    await expectSettingsError(() => settings.clearKey(), "llm_locked", 403);
    await expectSettingsError(() => settings.reset(), "llm_locked", 403);
    await expectSettingsError(() => settings.test({ url: "http://127.0.0.1:11434/v1" }), "llm_locked", 403);
    await expectSettingsError(() => settings.listModels({ apiKey: "x" }), "llm_locked", 403);
    expect(guarded.calls).toHaveLength(0);
    await settings.test();
    expect(plain.calls[0]).toMatchObject({ url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" });
    expect(log.entries).toEqual([]);
  });

  it("treats an undecryptable stored key as unreadable and recovers on a new key", async () => {
    const { settings, store, log } = fixture();
    const otherBox = new AesGcmSecretBox("o".repeat(32));
    store.record = {
      configJson: JSON.stringify({ url: "http://127.0.0.1:11434/v1", model: "m", maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 }),
      sealedKey: otherBox.seal("sk-lost"),
      sealedHeaders: null,
    };
    settings.bootstrap();
    expect(settings.get()).toMatchObject({
      source: "db",
      enabled: false,
      hasKey: false,
      keyState: "unreadable",
      url: "http://127.0.0.1:11434/v1",
    });
    expect(log.entries.join("\n")).toContain("cannot be decrypted");
    expect(log.entries.join("\n")).not.toContain("sk-lost");
    await settings.update({ url: "http://127.0.0.1:11434/v1", model: "m", apiKey: "sk-new" });
    expect(settings.get()).toMatchObject({ enabled: true, keyState: "set" });
  });

  it("validates the destination policy on save but tolerates a DNS failure", async () => {
    const blocked = fixture({
      policy: { mode: "off" },
      lookup: async () => [{ address: "10.0.0.1", family: 4 }],
    });
    blocked.settings.bootstrap();
    await expectSettingsError(
      () => blocked.settings.update({ url: "http://internal.example.com/v1", apiKey: "sk", model: "m" }),
      "url_blocked",
      400,
    );

    const offline = fixture({
      lookup: async () => { throw new Error("ENOTFOUND"); },
    });
    offline.settings.bootstrap();
    await expect(offline.settings.update({ url: "http://offline.example.com/v1", apiKey: "sk", model: "m" }))
      .resolves.toMatchObject({ source: "db" });

    const publicHttp = fixture({
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    publicHttp.settings.bootstrap();
    await expectSettingsError(
      () => publicHttp.settings.update({ url: "http://api.example.com/v1", apiKey: "sk", model: "m" }),
      "https_required",
      400,
    );

    const metadata = fixture();
    metadata.settings.bootstrap();
    await expectSettingsError(
      () => metadata.settings.update({ url: "http://169.254.169.254/v1", apiKey: "sk", model: "m" }),
      "url_blocked",
      400,
    );
  });

  it("selects the guarded probe for drafts/db and the plain probe for env", async () => {
    const { settings, plain, guarded } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    settings.bootstrap();
    await settings.test();
    expect(plain.calls).toHaveLength(1);
    await settings.test({ url: "https://api.example.com/v1", model: "env-model" });
    expect(guarded.calls).toHaveLength(1);

    await settings.update({ url: "https://api.example.com/v1", model: "db-model" });
    await settings.test();
    expect(guarded.calls).toHaveLength(2);
    expect(guarded.calls.at(-1)).toMatchObject({ apiKey: ENV_KEY, model: "db-model" });
  });

  it("returns key_required for a cross-origin probe instead of reusing the key", async () => {
    const { settings, guarded } = fixture();
    settings.bootstrap();
    await settings.update({ url: "http://127.0.0.1:11434/v1", apiKey: "sk-original", model: "m" });
    const result = await settings.test({ url: "http://127.0.0.1:11435/v1" });
    expect(result).toEqual({ ok: false, latencyMs: 0, code: "key_required" });
    expect(guarded.calls).toHaveLength(0);
    const models = await settings.listModels({ url: "http://127.0.0.1:11435/v1" });
    expect(models).toEqual({ supported: false, models: [], code: "key_required" });
  });

  it("rate limits probes and admin actions with Retry-After data", async () => {
    const probeFixture = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    probeFixture.settings.bootstrap();
    for (let index = 0; index < 10; index += 1) await probeFixture.settings.test();
    const error = await expectSettingsError(() => probeFixture.settings.test(), "rate_limited", 429);
    expect(error.retryAfterSec).toBe(60);
    probeFixture.advance(60_001);
    await expect(probeFixture.settings.test()).resolves.toMatchObject({ ok: true });

    const adminFixture = fixture();
    adminFixture.settings.bootstrap();
    for (let index = 0; index < 20; index += 1) adminFixture.settings.reset();
    const adminError = await expectSettingsError(() => adminFixture.settings.reset(), "rate_limited", 429);
    expect(adminError.retryAfterSec).toBe(60);
    adminFixture.advance(60_001);
    expect(() => adminFixture.settings.reset()).not.toThrow();
  });

  it("does not swap or persist a candidate that fails to build", async () => {
    const prepareFailure = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    prepareFailure.settings.bootstrap();
    const commits = prepareFailure.runtime.commits;
    prepareFailure.runtime.failPrepare = true;
    // prepare throws a plain Error, which bubbles unchanged; what matters is no commit.
    await expect(prepareFailure.settings.update({ url: "http://127.0.0.1:11434/v1", apiKey: "sk", model: "m" }))
      .rejects.toThrow("invalid candidate");
    expect(prepareFailure.runtime.commits).toBe(commits);
    expect(prepareFailure.store.record).toBeUndefined();

    const saveFailure = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
    });
    saveFailure.settings.bootstrap();
    const previousCommits = saveFailure.runtime.commits;
    saveFailure.store.failSave = true;
    await expect(saveFailure.settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk",
      model: "m",
    })).rejects.toThrow("disk full");
    expect(saveFailure.runtime.commits).toBe(previousCommits);
    expect(saveFailure.settings.get().source).toBe("env");
  });

  it("never writes the key to the logger", async () => {
    const { settings, log } = fixture();
    settings.bootstrap();
    await settings.update({ url: "http://127.0.0.1:11434/v1", apiKey: "sk-log-sentinel", model: "m" });
    await settings.test();
    settings.clearKey();
    const output = log.entries.join("\n");
    expect(output).not.toContain("sk-log-sentinel");
  });

  it("persists custom header values sealed and never exposes them", async () => {
    const { settings, store, runtime, secrets } = fixture();
    settings.bootstrap();
    const sentinel = "HEADER-VALUE-SENTINEL";
    const view = await settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk-key",
      model: "m",
      headers: [{ name: "X-Session-Id", value: sentinel }],
    });
    expect(view).toMatchObject({
      source: "db",
      headers: [{ name: "X-Session-Id", hasValue: true }],
      headersState: "set",
    });
    expect(view.headers).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain(sentinel);
    expect(store.record?.sealedHeaders).toMatch(/^v1:/);
    expect(store.record?.sealedHeaders).not.toContain(sentinel);
    expect(store.record?.configJson).not.toContain(sentinel);
    expect(store.record?.configJson).toContain("X-Session-Id");
    expect(secrets.open(store.record?.sealedHeaders ?? "")).toContain(sentinel);
    expect(runtime.configs.at(-1)).toMatchObject({
      apiStyle: "openai",
      headers: [{ name: "X-Session-Id", value: sentinel }],
    });
    expect(runtime.current.configured).toBe(true);
  });

  it("keeps headers on the same origin, drops them on a new origin and demands values then", async () => {
    const { settings, store, runtime } = fixture();
    settings.bootstrap();
    const sentinel = "ORIGIN-HEADER-SENTINEL";
    await settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk-key",
      model: "m",
      headers: [{ name: "X-Session-Id", value: sentinel }],
    });

    await settings.update({ url: "http://127.0.0.1:11434/other", model: "m" });
    expect(settings.get().headers).toEqual([{ name: "X-Session-Id", hasValue: true }]);
    expect(runtime.configs.at(-1)).toMatchObject({ headers: [{ name: "X-Session-Id", value: sentinel }] });
    const sealed = store.record?.sealedHeaders;

    await expectSettingsError(
      () => settings.update({
        url: "http://127.0.0.1:11435/v1",
        apiKey: "sk-other",
        model: "m",
        headers: [{ name: "x-session-id" }],
      }),
      "header_value_required",
      400,
    );
    expect(store.record?.sealedHeaders).toBe(sealed);

    await settings.update({ url: "http://127.0.0.1:11435/v1", apiKey: "sk-other", model: "m" });
    expect(settings.get()).toMatchObject({ headers: [], headersState: "none" });
    expect(store.record?.sealedHeaders).toBeNull();
    expect(runtime.configs.at(-1)).toMatchObject({ headers: [] });
  });

  it("revalidates kept headers when the style changes", async () => {
    const { settings, store } = fixture();
    settings.bootstrap();
    await settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk-key",
      model: "m",
      headers: [{ name: "x-api-key", value: "gateway-value" }],
    });
    await expectSettingsError(
      () => settings.update({ url: "http://127.0.0.1:11434/v1", model: "m", apiStyle: "anthropic" }),
      "invalid_header",
      400,
    );
    expect(settings.get().apiStyle).toBe("openai");
    expect(store.record?.configJson).toContain("x-api-key");

    const switched = await settings.update({
      url: "http://127.0.0.1:11434/v1",
      model: "m",
      apiStyle: "anthropic",
      headers: [{ name: "anthropic-beta", value: "messages-2026-10-21" }],
    });
    expect(switched).toMatchObject({ apiStyle: "anthropic", headers: [{ name: "anthropic-beta", hasValue: true }] });
  });

  it("disables chat when the stored headers cannot be decrypted and recovers when saved again", async () => {
    const { settings, store, runtime, log, secrets } = fixture();
    const otherBox = new AesGcmSecretBox("o".repeat(32));
    const sentinel = "UNREADABLE-HEADER-SENTINEL";
    store.record = {
      configJson: JSON.stringify({
        url: "http://127.0.0.1:11434/v1",
        model: "m",
        maxTokens: 1024,
        timeoutSec: 120,
        ratePerMin: 20,
        apiStyle: "openai",
        headerNames: ["X-Session-Id"],
      }),
      sealedKey: new AesGcmSecretBox(SECRET).seal("sk-key"),
      sealedHeaders: otherBox.seal(JSON.stringify({ "X-Session-Id": sentinel })),
    };
    settings.bootstrap();
    expect(settings.get()).toMatchObject({
      source: "db",
      enabled: false,
      headers: [{ name: "X-Session-Id", hasValue: false }],
      headersState: "unreadable",
    });
    expect(runtime.current.configured).toBe(false);
    const output = log.entries.join("\n");
    expect(output).toContain("cannot be decrypted");
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain("X-Session-Id");

    await settings.update({
      url: "http://127.0.0.1:11434/v1",
      model: "m",
      headers: [{ name: "X-Session-Id", value: "retyped-value" }],
    });
    expect(settings.get()).toMatchObject({ enabled: true, headersState: "set" });
    expect(secrets.open(store.record?.sealedHeaders ?? "")).toContain("retyped-value");
  });

  it("seeds the legacy session header once for an existing stored configuration", () => {
    const { settings, store, runtime } = fixture();
    store.record = {
      configJson: JSON.stringify({
        url: "http://127.0.0.1:11434/v1",
        model: "m",
        maxTokens: 1024,
        timeoutSec: 120,
        ratePerMin: 20,
      }),
      sealedKey: new AesGcmSecretBox(SECRET).seal("sk-key"),
      sealedHeaders: null,
    };
    settings.bootstrap();
    expect(store.record?.configJson).toContain("headerNames");
    expect(store.record?.configJson).toContain(LEGACY_SESSION_HEADER.name);
    expect(store.record?.sealedHeaders).toMatch(/^v1:/);
    expect(settings.get()).toMatchObject({
      headers: [{ name: LEGACY_SESSION_HEADER.name, hasValue: true }],
      headersState: "set",
    });
    expect(runtime.configs.at(-1)).toMatchObject({
      headers: [{ name: LEGACY_SESSION_HEADER.name, value: LEGACY_SESSION_HEADER.value }],
    });
    const seeded = store.record?.sealedHeaders;

    const second = fixture({});
    second.store.record = store.record;
    second.settings.bootstrap();
    // The row already has headerNames, so the seed is not applied again (new seal would differ).
    expect(second.store.record?.sealedHeaders).toBe(seeded);
  });

  it("uses the environment header shim and disables it with an empty value", () => {
    const shim = fixture({
      env: {
        url: "https://api.example.com/v1",
        apiKey: ENV_KEY,
        model: "env-model",
        headers: [{ name: "X-Session-Id", value: "env-{{conversationId}}" }],
        legacySessionHeader: true,
      },
    });
    shim.settings.bootstrap();
    expect(shim.runtime.configs.at(-1)).toMatchObject({
      headers: [{ name: "X-Session-Id", value: "env-{{conversationId}}" }],
    });
    expect(shim.log.entries.join("\n")).toContain("KNOWLIFY_LLM_HEADERS");
    // The boot warning describes the current seed; it must not promise a removal that
    // already happened (the 2.x releases kept the compatibility seed).
    expect(shim.log.entries.join("\n")).not.toContain("removed in 2.0");
    expect(shim.log.entries.join("\n")).toContain("legacy session header");

    const disabled = fixture({
      env: {
        url: "https://api.example.com/v1",
        apiKey: ENV_KEY,
        model: "env-model",
        headers: [],
        legacySessionHeader: false,
      },
    });
    disabled.settings.bootstrap();
    expect(disabled.runtime.configs.at(-1)).toMatchObject({ headers: [] });
  });

  it("lets the database replace the whole environment header block", async () => {
    const { settings, store, secrets, runtime } = fixture({
      env: {
        url: "https://api.example.com/v1",
        apiKey: ENV_KEY,
        model: "env-model",
        headers: [{ name: "X-Env", value: "from-env" }],
        legacySessionHeader: false,
      },
    });
    store.record = {
      configJson: JSON.stringify({
        url: "https://api.example.com/other",
        model: "db-model",
        maxTokens: 1024,
        timeoutSec: 120,
        ratePerMin: 20,
        apiStyle: "openai",
        headerNames: ["X-Db"],
      }),
      sealedKey: secrets.seal(ENV_KEY),
      sealedHeaders: secrets.seal(JSON.stringify({ "X-Db": "from-db" })),
    };
    settings.bootstrap();
    expect(settings.get()).toMatchObject({
      source: "db",
      headers: [{ name: "X-Db", hasValue: true }],
      headersState: "set",
    });
    expect(runtime.configs.at(-1)).toMatchObject({ headers: [{ name: "X-Db", value: "from-db" }] });
  });

  it("passes the resolved headers and style to probes and enforces the origin rule", async () => {
    const { settings, runtime, guarded, guardedAnthropic } = fixture();
    settings.bootstrap();
    await settings.update({
      url: "http://127.0.0.1:11434/v1",
      apiKey: "sk-key",
      model: "m",
      headers: [{ name: "X-Session-Id", value: "saved-value" }],
    });
    await settings.test({ headers: [{ name: "X-Session-Id" }] });
    expect(guarded.calls.at(-1)).toMatchObject({
      apiStyle: "openai",
      headers: [{ name: "X-Session-Id", value: "saved-value" }],
    });
    await settings.listModels({ apiStyle: "anthropic" });
    expect(guardedAnthropic.calls.at(-1)).toMatchObject({
      apiStyle: "anthropic",
      headers: [{ name: "X-Session-Id", value: "saved-value" }],
    });

    await expectSettingsError(
      () => settings.test({
        url: "http://127.0.0.1:11435/v1",
        apiKey: "sk-other",
        headers: [{ name: "X-Session-Id" }],
      }),
      "header_value_required",
      400,
    );
    await expectSettingsError(
      () => settings.test({ headers: [{ name: "x-api-key", value: "v" }], apiStyle: "anthropic" }),
      "invalid_header",
      400,
    );
    expect(runtime.current.configured).toBe(true);
  });

  it("blocks apiStyle and header drafts on a locked server", async () => {
    const { settings } = fixture({
      env: { url: "https://api.example.com/v1", apiKey: ENV_KEY, model: "env-model" },
      locked: true,
    });
    settings.bootstrap();
    await expectSettingsError(() => settings.test({ apiStyle: "anthropic" }), "llm_locked", 403);
    await expectSettingsError(() => settings.listModels({ headers: [] }), "llm_locked", 403);
    await expectSettingsError(
      () => settings.update({ url: "https://api.example.com/v1", headers: [] }),
      "llm_locked",
      403,
    );
  });

  it("does not log header values during validation failures", async () => {
    const { settings, log } = fixture();
    settings.bootstrap();
    const sentinel = "VALIDATION-SENTINEL-VALUE";
    await expectSettingsError(
      () => settings.update({
        url: "http://127.0.0.1:11434/v1",
        apiKey: "sk",
        model: "m",
        headers: [{ name: "Host", value: sentinel }],
      }),
      "invalid_header",
      400,
    );
    expect(log.entries.join("\n")).not.toContain(sentinel);
  });
});
