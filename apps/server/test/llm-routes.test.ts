import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { settingsLlmRoutes } from "../src/adapters/http/settings-llm.js";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { AesGcmSecretBox } from "../src/adapters/security/SecretBox.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteLlmConfigStore, SqliteTutorPromptStore } from "../src/adapters/storage/SqliteSettingsRepository.js";
import { serializeLlmConfig } from "../src/domain/assistant/LlmConfig.js";
import { TUTOR_PERSONA_DEFAULT, TUTOR_PROMPT_VERSION } from "../src/domain/assistant/tutorPrompt.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { LlmClient, LlmEvent, LlmRequest } from "../src/ports/assistant.js";
import type {
  LlmConfigStore,
  LlmEndpointProbe,
  LlmModelsResult,
  LlmProbeTarget,
  LlmRuntime,
  LlmRuntimeConfig,
  LlmTestResult,
  StoredLlmSettings,
  TutorPromptStore,
} from "../src/ports/llm-settings.js";
import { LlmSettings } from "../src/use-cases/LlmSettings.js";
import { TutorPromptSettings } from "../src/use-cases/TutorPromptSettings.js";

const SECRET = "s".repeat(32);
const KEY = "sk-route-sentinel-value";

class MemoryStore implements LlmConfigStore {
  record: StoredLlmSettings | undefined;
  load(): StoredLlmSettings | undefined { return this.record; }
  save(settings: StoredLlmSettings): void { this.record = settings; }
  clear(): void { this.record = undefined; }
  clearKey(): void { if (this.record) this.record = { ...this.record, sealedKey: null }; }
}

class MemoryPromptStore implements TutorPromptStore {
  value: string | null = null;
  loads = 0;
  load(): string | null { this.loads += 1; return this.value; }
  save(text: string | null): void { this.value = text; }
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
    throw new Error("not used");
  }
}

class FakeRuntime implements LlmRuntime {
  current: LlmClient = new NoLlmClient();
  get configured(): boolean { return this.current.configured; }
  prepare(config: LlmRuntimeConfig | null): LlmClient {
    return config ? new FakeClient(config) : new NoLlmClient();
  }
  commit(client: LlmClient): void { this.current = client; }
}

class FakeProbe implements LlmEndpointProbe {
  models: LlmModelsResult = { supported: true, models: ["m"] };
  test: LlmTestResult = { ok: true, latencyMs: 2, modelFound: true };
  calls: LlmProbeTarget[] = [];
  async listModels(target: LlmProbeTarget): Promise<LlmModelsResult> { this.calls.push(target); return this.models; }
  async testChat(target: LlmProbeTarget): Promise<LlmTestResult> { this.calls.push(target); return this.test; }
}

const apps: FastifyInstance[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSettings(options: {
  locked?: boolean;
  policy?: "off" | "on";
  envUrl?: string;
  storedPrompt?: string;
  log?: { info: (message: string) => void; error: (error: unknown, message: string) => void; warn?: (message: string) => void };
} = {}) {
  const store = new MemoryStore();
  const promptStore = new MemoryPromptStore();
  promptStore.value = options.storedPrompt ?? null;
  const guarded = new FakeProbe();
  const plain = new FakeProbe();
  const guardedAnthropic = new FakeProbe();
  const plainAnthropic = new FakeProbe();
  const runtime = new FakeRuntime();
  const settings = new LlmSettings({
    store,
    secrets: new AesGcmSecretBox(SECRET),
    runtime,
    probes: {
      plain: { openai: plain, anthropic: plainAnthropic },
      guarded: { openai: guarded, anthropic: guardedAnthropic },
    },
    clock: { now: () => 1_000 },
    log: options.log ?? { info: () => {}, error: () => {}, warn: () => {} },
    env: {
      url: options.envUrl ?? null,
      apiKey: options.envUrl ? "env-key-12345" : null,
      model: options.envUrl ? "env-model" : null,
      maxTokens: 1024,
      timeoutSec: 120,
      ratePerMin: 20,
      apiStyle: "openai",
      headers: [],
      legacySessionHeader: false,
    },
    locked: options.locked ?? false,
    policy: { mode: options.policy ?? "on" },
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  settings.bootstrap();
  const promptSettings = new TutorPromptSettings({
    store: promptStore,
    clock: { now: () => 1_000 },
    log: options.log ?? { info: () => {}, error: () => {}, warn: () => {} },
    locked: options.locked ?? false,
  });
  promptSettings.bootstrap();
  return { settings, promptSettings, promptStore, store, guarded, plain, guardedAnthropic, plainAnthropic, runtime };
}

async function appFor(setup: ReturnType<typeof makeSettings>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(settingsLlmRoutes, { llmSettings: setup.settings, tutorPromptSettings: setup.promptSettings });
  await app.ready();
  apps.push(app);
  return app;
}

describe("LLM settings HTTP routes", () => {
  it("returns the frozen view shape including defaults, policy and prompt", async () => {
    const setup = makeSettings();
    const app = await appFor(setup);
    const response = await app.inject({ method: "GET", url: "/settings/llm" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      source: "none",
      locked: false,
      enabled: false,
      url: null,
      model: null,
      hasKey: false,
      keyState: "none",
      maxTokens: 1024,
      timeoutSec: 120,
      ratePerMin: 20,
      apiStyle: "openai",
      headers: [],
      headersState: "none",
      defaults: { maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 },
      policy: { allowPrivate: "on", publicRequiresHttps: true },
      prompt: {
        custom: null,
        default: TUTOR_PERSONA_DEFAULT,
        version: TUTOR_PROMPT_VERSION,
        maxChars: 4_000,
        locked: false,
      },
    });
  });

  it("saves, exposes and resets the editable persona without erasing it on LLM reset", async () => {
    const setup = makeSettings();
    const { promptStore } = setup;
    const app = await appFor(setup);

    const saved = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: "  Answer as a pirate.\r\n" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      custom: "Answer as a pirate.",
      version: expect.stringMatching(/^custom-[0-9a-f]{8}$/),
      locked: false,
    });
    expect(promptStore.value).toBe("Answer as a pirate.");

    const view = await app.inject({ method: "GET", url: "/settings/llm" });
    expect(view.json().prompt).toMatchObject({ custom: "Answer as a pirate." });

    // The provider reset must not drop the persona: both have independent lifecycles.
    expect((await app.inject({ method: "DELETE", url: "/settings/llm" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/settings/llm" })).json().prompt)
      .toMatchObject({ custom: "Answer as a pirate." });

    const reset = await app.inject({ method: "PUT", url: "/settings/llm/prompt", payload: { systemPrompt: null } });
    expect(reset.json()).toMatchObject({ custom: null, version: TUTOR_PROMPT_VERSION });
    expect(promptStore.value).toBeNull();

    const defaultText = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: `  ${TUTOR_PERSONA_DEFAULT.replace(/\n/g, "\r\n")}  ` },
    });
    expect(defaultText.json()).toMatchObject({ custom: null, version: TUTOR_PROMPT_VERSION });
    expect(promptStore.value).toBeNull();

    const whitespace = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: "\t  Answer\r\nbriefly.\n\t " },
    });
    expect(whitespace.statusCode).toBe(200);
    expect(whitespace.json()).toMatchObject({ custom: "Answer\nbriefly." });
    expect(promptStore.value).toBe("Answer\nbriefly.");
  });

  it("validates the prompt body and keeps the previous persona", async () => {
    const setup = makeSettings();
    const app = await appFor(setup);
    await app.inject({ method: "PUT", url: "/settings/llm/prompt", payload: { systemPrompt: "Keep me." } });

    for (const payload of [
      {},
      { systemPrompt: 3 },
      { systemPrompt: "" },
      { systemPrompt: "   " },
      { systemPrompt: "x".repeat(4_001) },
      { systemPrompt: "NUL \u0000" },
      { systemPrompt: "escape \u001b" },
      { systemPrompt: "carriage\r" },
      { systemPrompt: "\rcarriage" },
      { systemPrompt: "edge\r " },
      { systemPrompt: "ok", extra: true },
      [],
      { systemPrompt: [] },
    ]) {
      const response = await app.inject({ method: "PUT", url: "/settings/llm/prompt", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_value" });
    }
    expect(setup.promptStore.value).toBe("Keep me.");

    const large = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: "x".repeat(21_000) },
    });
    expect(large.statusCode).toBe(413);
  });

  it("rate limits prompt writes with Retry-After", async () => {
    const setup = makeSettings();
    const app = await appFor(setup);
    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({
        method: "PUT",
        url: "/settings/llm/prompt",
        payload: { systemPrompt: `persona ${index}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: "one too many" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toMatchObject({ code: "rate_limited" });
  });

  it("ignores the stored persona and refuses writes on a locked server", async () => {
    const setup = makeSettings({ locked: true, storedPrompt: "Stored persona." });
    const app = await appFor(setup);
    expect(setup.promptStore.loads).toBe(0);
    const view = await app.inject({ method: "GET", url: "/settings/llm" });
    expect(view.json().prompt).toEqual({
      custom: null,
      default: TUTOR_PERSONA_DEFAULT,
      version: TUTOR_PROMPT_VERSION,
      maxChars: 4_000,
      locked: true,
    });
    const put = await app.inject({ method: "PUT", url: "/settings/llm/prompt", payload: { systemPrompt: "Nope." } });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: "llm_locked" });
    expect(setup.promptStore.value).toBe("Stored persona.");
  });

  it("never logs the custom persona or the invalid stored value", async () => {
    const logs: string[] = [];
    const log = {
      info: (message: string) => logs.push(message),
      error: (error: unknown, message: string) => logs.push(`${message} ${String(error)}`),
      warn: (message: string) => logs.push(message),
    };
    const setup = makeSettings({ storedPrompt: "invalid \u0000 SENTINEL-PROMPT", log });
    const app = await appFor(setup);
    const sentinel = "SENTINEL-PROMPT";
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/llm/prompt",
      payload: { systemPrompt: `Answer as ${sentinel}.` },
    });
    expect(saved.statusCode).toBe(200);
    await app.inject({ method: "GET", url: "/settings/llm" });
    expect(logs.join("\n")).not.toContain(sentinel);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("saves a configuration without echoing the key", async () => {
    const setup = makeSettings();
    const { settings, store } = setup;
    const app = await appFor(setup);
    const response = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m", maxTokens: 2048 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(KEY);
    expect(response.json()).toMatchObject({ source: "db", enabled: true, hasKey: true, keyState: "set", maxTokens: 2048 });
    expect(store.record?.configJson).not.toContain(KEY);
  });

  it("rejects a first db save from another origin and keeps the same-origin copy", async () => {
    const setup = makeSettings({ envUrl: "https://api.example.com/v1" });
    const { settings, store, runtime } = setup;
    const app = await appFor(setup);
    const before = runtime.current;
    const crossOrigin = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "https://attacker.example.net/v1", model: "m" },
    });
    expect(crossOrigin.statusCode).toBe(400);
    expect(crossOrigin.json()).toMatchObject({ code: "key_required" });
    expect(store.record).toBeUndefined();
    expect(runtime.current).toBe(before);
    expect(settings.get()).toMatchObject({ source: "env", url: "https://api.example.com/v1" });

    const sameOrigin = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "https://api.example.com/other", model: "m" },
    });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.json()).toMatchObject({ source: "db", hasKey: true, keyState: "set" });
    expect(sameOrigin.body).not.toContain("env-key-12345");
    expect(store.record?.sealedKey).toMatch(/^v1:/);
  });

  it("rejects extra properties and invalid bodies", async () => {
    const setup = makeSettings();
    const { settings } = setup;
    const app = await appFor(setup);
    for (const payload of [
      { url: "http://127.0.0.1:11434/v1", extra: true },
      { apiKey: KEY },
      { url: "" },
      { url: "http://127.0.0.1:11434/v1", apiKey: "has space" },
      { url: "http://127.0.0.1:11434/v1", maxTokens: 0 },
      { url: "http://127.0.0.1:11434/v1", timeoutSec: 601 },
    ]) {
      const response = await app.inject({ method: "PUT", url: "/settings/llm", payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it("maps policy and URL errors to the contract codes", async () => {
    const setup = makeSettings({ policy: "off" });
    const { settings } = setup;
    const app = await appFor(setup);
    const blocked = await settings.update({
      url: "https://8.8.8.8/v1",
      model: "m",
      apiKey: KEY,
    }).catch((error: unknown) => error);
    expect(blocked).toBeTruthy();
    // Direct use case sanity: public HTTPS is allowed, loopback is blocked by policy.
    expect(settings.get().source).toBe("db");
    const loopback = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m" },
    });
    expect(loopback.statusCode).toBe(400);
    expect(loopback.json()).toMatchObject({ code: "url_blocked" });

    const invalid = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "ftp://example.com/v1" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_url" });

    const publicHttp = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://8.8.8.8/v1", apiKey: KEY, model: "m" },
    });
    expect(publicHttp.statusCode).toBe(400);
    expect(publicHttp.json()).toMatchObject({ code: "https_required" });
  });

  it("deletes only the key, then resets to the environment", async () => {
    const setup = makeSettings();
    const { settings } = setup;
    const app = await appFor(setup);
    await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m" },
    });
    const cleared = await app.inject({ method: "DELETE", url: "/settings/llm/key" });
    expect(cleared.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/settings/llm" })).json())
      .toMatchObject({ source: "db", enabled: false, hasKey: false, keyState: "none" });
    const reset = await app.inject({ method: "DELETE", url: "/settings/llm" });
    expect(reset.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/settings/llm" })).json())
      .toMatchObject({ source: "none", enabled: false });
  });

  it("lists models and tests connections with 200 results", async () => {
    const setup = makeSettings();
    const { settings, guarded } = setup;
    const app = await appFor(setup);
    const models = await app.inject({
      method: "POST",
      url: "/settings/llm/models",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({ supported: true, models: ["m"] });
    const test = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m" },
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: true, latencyMs: 2, modelFound: true });
    expect(test.body).not.toContain(KEY);
    expect(guarded.calls).toHaveLength(2);
  });

  it("rate limits probes with Retry-After", async () => {
    const setup = makeSettings();
    const { settings } = setup;
    const app = await appFor(setup);
    const payload = { url: "http://127.0.0.1:11434/v1", apiKey: KEY };
    for (let index = 0; index < 10; index += 1) {
      expect((await app.inject({ method: "POST", url: "/settings/llm/test", payload })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/settings/llm/test", payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toMatchObject({ code: "rate_limited" });
  });

  it("blocks writes on a locked server but still tests the effective configuration", async () => {
    const setup = makeSettings({
      locked: true,
      envUrl: "https://api.example.com/v1",
    });
    const { settings, plain, guarded } = setup;
    const app = await appFor(setup);
    const put = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", model: "m" },
    });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: "llm_locked" });
    expect((await app.inject({ method: "DELETE", url: "/settings/llm" })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/settings/llm/key" })).statusCode).toBe(403);
    const draft = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: { url: "http://127.0.0.1:11434/v1" },
    });
    expect(draft.statusCode).toBe(403);
    const styleDraft = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: { apiStyle: "anthropic" },
    });
    expect(styleDraft.statusCode).toBe(403);
    const headerDraft = await app.inject({
      method: "POST",
      url: "/settings/llm/models",
      payload: { headers: [] },
    });
    expect(headerDraft.statusCode).toBe(403);
    const plainTest = await app.inject({ method: "POST", url: "/settings/llm/test", payload: {} });
    expect(plainTest.statusCode).toBe(200);
    expect(plain.calls).toHaveLength(1);
    expect(guarded.calls).toHaveLength(0);
  });

  it("saves custom headers and the API style without echoing a value", async () => {
    const setup = makeSettings();
    const { settings, guardedAnthropic } = setup;
    const app = await appFor(setup);
    const sentinel = "ROUTE-HEADER-SENTINEL";
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        apiStyle: "anthropic",
        headers: [
          { name: "X-Session-Id", value: `conversation-{{conversationId}}-${sentinel}` },
          { name: "anthropic-beta", value: "messages-2026-10-21" },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(sentinel);
    expect(saved.body).not.toContain("messages-2026-10-21");
    expect(saved.json()).toMatchObject({
      source: "db",
      apiStyle: "anthropic",
      headers: [
        { name: "X-Session-Id", hasValue: true },
        { name: "anthropic-beta", hasValue: true },
      ],
      headersState: "set",
    });

    const view = await app.inject({ method: "GET", url: "/settings/llm" });
    expect(view.json()).toMatchObject({
      apiStyle: "anthropic",
      headers: [
        { name: "X-Session-Id", hasValue: true },
        { name: "anthropic-beta", hasValue: true },
      ],
    });
    expect(view.body).not.toContain(sentinel);

    // The probe receives the resolved list and the requested style.
    const probe = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiStyle: "anthropic",
        headers: [{ name: "X-Session-Id" }],
      },
    });
    expect(probe.statusCode).toBe(200);
    expect(guardedAnthropic.calls.at(-1)).toMatchObject({
      apiStyle: "anthropic",
      headers: [{ name: "X-Session-Id", value: `conversation-{{conversationId}}-${sentinel}` }],
    });
    expect(probe.body).not.toContain(sentinel);
    expect(JSON.stringify(settings.get())).not.toContain(sentinel);
  });

  it("maps header validation errors to the frozen codes", async () => {
    const setup = makeSettings();
    const app = await appFor(setup);
    const forbiddenStyleHeader = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        apiStyle: "anthropic",
        headers: [{ name: "x-api-key", value: "sentinel-value" }],
      },
    });
    expect(forbiddenStyleHeader.statusCode).toBe(400);
    expect(forbiddenStyleHeader.json()).toMatchObject({ code: "invalid_header" });
    expect(forbiddenStyleHeader.body).not.toContain("sentinel-value");

    const forbidden = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        headers: [{ name: "Host", value: "sentinel-value" }],
      },
    });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json()).toMatchObject({ code: "invalid_header" });

    const tooMany = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        headers: Array.from({ length: 9 }, (_, index) => ({ name: `x-${index}`, value: "v" })),
      },
    });
    expect(tooMany.statusCode).toBe(400);

    const incomplete = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        headers: [{ name: "x-kept" }],
      },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()).toMatchObject({ code: "header_value_required" });
  });

  it("rejects Accept*, controls and non-ASCII through the API with the failing field", async () => {
    const setup = makeSettings();
    const { guarded } = setup;
    const app = await appFor(setup);
    const base = { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m" };

    for (const style of ["openai", "anthropic"] as const) {
      for (const name of ["Accept", "Accept-Encoding", "accept-language", "ACCEPT-CHARSET", "accept-x"]) {
        const response = await app.inject({
          method: "PUT",
          url: "/settings/llm",
          payload: { ...base, apiStyle: style, headers: [{ name, value: "ok" }] },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "invalid_header", field: "name" });
      }
    }

    for (const value of ["\r\nsecret", "secret\r\n", "a\r\nb", "\tx", "x\u0000", "é"]) {
      const response = await app.inject({
        method: "PUT",
        url: "/settings/llm",
        payload: { ...base, headers: [{ name: "x-custom", value }] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_header", field: "value" });
      expect(response.body).not.toContain("secret");
    }

    const probeName = await app.inject({
      method: "POST",
      url: "/settings/llm/models",
      payload: { url: base.url, apiKey: KEY, headers: [{ name: "Accept-Language", value: "pt-BR" }] },
    });
    expect(probeName.statusCode).toBe(400);
    expect(probeName.json()).toMatchObject({ code: "invalid_header", field: "name" });

    const probeValue = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: {
        url: base.url,
        apiKey: KEY,
        model: "m",
        headers: [{ name: "x-custom", value: "a\r\nb" }],
      },
    });
    expect(probeValue.statusCode).toBe(400);
    expect(probeValue.json()).toMatchObject({ code: "invalid_header", field: "value" });
    expect(guarded.calls).toHaveLength(0);
  });

  it("trims surrounding spaces only after validating the original header", async () => {
    const setup = makeSettings();
    const { guarded } = setup;
    const app = await appFor(setup);
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: {
        url: "http://127.0.0.1:11434/v1",
        apiKey: KEY,
        model: "m",
        headers: [{ name: "  X-Custom  ", value: "  ok  " }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ headers: [{ name: "X-Custom", hasValue: true }] });

    const probe = await app.inject({
      method: "POST",
      url: "/settings/llm/test",
      payload: {},
    });
    expect(probe.statusCode).toBe(200);
    expect(guarded.calls.at(-1)?.headers).toEqual([{ name: "X-Custom", value: "ok" }]);
  });

  it("accepts a 16 KB body and rejects a larger one", async () => {
    const setup = makeSettings();
    const app = await appFor(setup);
    const saved = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: KEY, model: "m" },
    });
    expect(saved.statusCode).toBe(200);
    const large = await app.inject({
      method: "PUT",
      url: "/settings/llm",
      payload: { url: "http://127.0.0.1:11434/v1", apiKey: "x".repeat(17_000) },
    });
    expect(large.statusCode).toBe(413);
  });
});

describe("LLM settings registration in the real app", () => {
  it("requires auth, persists the sealed key and hot-swaps the chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-llm-routes-"));
    roots.push(root);
    config.dataDir = root;
    config.secret.file = join(root, "secret.key");
    const db: Db = openDb(":memory:");
    const { app } = await buildApp(db, false);
    const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
    try {
      expect((await app.inject({ method: "GET", url: "/api/settings/llm" })).statusCode).toBe(401);
      const initial = await app.inject({ method: "GET", url: "/api/settings/llm", headers: auth });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ source: "none", enabled: false });

      const saved = await app.inject({
        method: "PUT",
        url: "/api/settings/llm",
        headers: auth,
        payload: { url: "https://8.8.8.8/v1", apiKey: KEY, model: "m" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(KEY);

      const status = await app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
      expect(status.json()).toMatchObject({ enabled: true, host: "8.8.8.8", model: "m" });
      expect(status.body).not.toContain(KEY);

      const rawRows = (db.prepare("SELECT value FROM settings").all() as { value: string }[])
        .map((row) => row.value)
        .join("\n");
      expect(rawRows).not.toContain(KEY);
      expect(rawRows).toContain("v1:");

      expect((await app.inject({ method: "DELETE", url: "/api/settings/llm", headers: auth })).statusCode).toBe(204);
      const disabled = await app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
      expect(disabled.json()).toMatchObject({ enabled: false, host: null, model: null });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("persists the persona across restarts and keeps it out of chat status", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-prompt-routes-"));
    roots.push(root);
    config.dataDir = root;
    config.secret.file = join(root, "secret.key");
    const db: Db = openDb(":memory:");
    const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
    const sentinel = "PROMPT-SENTINEL";
    const first = await buildApp(db, false);
    let version = "";
    try {
      const before = await first.app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
      expect(before.json()).toMatchObject({ promptVersion: TUTOR_PROMPT_VERSION });

      const saved = await first.app.inject({
        method: "PUT",
        url: "/api/settings/llm/prompt",
        headers: auth,
        payload: { systemPrompt: `Answer as ${sentinel}.` },
      });
      expect(saved.statusCode).toBe(200);
      version = saved.json().version;
      expect(version).toMatch(/^custom-[0-9a-f]{8}$/);

      const status = await first.app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
      expect(status.json()).toMatchObject({ promptVersion: version });
      expect(status.body).not.toContain(sentinel);
    } finally {
      await first.app.close();
    }

    const second = await buildApp(db, false);
    try {
      const view = await second.app.inject({ method: "GET", url: "/api/settings/llm", headers: auth });
      expect(view.json().prompt).toMatchObject({ custom: `Answer as ${sentinel}.`, version });
    } finally {
      await second.app.close();
      db.close();
    }
  });

  it("sends the saved custom headers to /models and /test with the real probes", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-llm-probe-headers-"));
    roots.push(root);
    config.dataDir = root;
    config.secret.file = join(root, "secret.key");
    const previousPolicy = config.llmAllowPrivate;
    config.llmAllowPrivate = "on";
    const sentinel = "REAL-PROBE-HEADER-SENTINEL";
    const shortSentinel = "secret";
    const received: { url?: string; xSession?: string; xShort?: string; authorization?: string }[] = [];
    const provider = createServer((req, res) => {
      received.push({
        url: req.url,
        xSession: typeof req.headers["x-session-id"] === "string" ? req.headers["x-session-id"] : undefined,
        xShort: typeof req.headers["x-short"] === "string" ? req.headers["x-short"] : undefined,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "m" },
          { id: `probe-knowlify-probe-${sentinel}` },
          { id: `echo-${shortSentinel}` },
        ],
      }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { port } = provider.address() as AddressInfo;
    const db: Db = openDb(":memory:");
    const { app } = await buildApp(db, false);
    const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
    try {
      const saved = await app.inject({
        method: "PUT",
        url: "/api/settings/llm",
        headers: auth,
        payload: {
          url: `http://127.0.0.1:${port}/v1`,
          apiKey: KEY,
          model: "m",
          headers: [
            { name: "X-Session-Id", value: `probe-{{conversationId}}-${sentinel}` },
            { name: "X-Short", value: shortSentinel },
          ],
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain(sentinel);
      expect(saved.body).not.toContain(shortSentinel);

      const models = await app.inject({
        method: "POST",
        url: "/api/settings/llm/models",
        headers: auth,
        payload: {},
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toEqual({ supported: true, models: ["m"] });
      expect(models.body).not.toContain(sentinel);
      expect(models.body).not.toContain(shortSentinel);

      const test = await app.inject({
        method: "POST",
        url: "/api/settings/llm/test",
        headers: auth,
        payload: { model: "m" },
      });
      expect(test.statusCode).toBe(200);
      expect(test.json()).toMatchObject({ ok: true, modelFound: true });
      expect(test.body).not.toContain(sentinel);
      expect(test.body).not.toContain(shortSentinel);

      expect(received).toHaveLength(2);
      for (const request of received) {
        expect(request.url).toBe("/v1/models");
        expect(request.xSession).toBe(`probe-knowlify-probe-${sentinel}`);
        expect(request.xShort).toBe(shortSentinel);
        expect(request.authorization).toBe(`Bearer ${KEY}`);
      }
    } finally {
      config.llmAllowPrivate = previousPolicy;
      await app.close();
      db.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });

  it("boots from a stored database record and falls back after reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-llm-boot-"));
    roots.push(root);
    const secret = randomBytes(32);
    const secretFile = join(root, "secret.key");
    writeFileSync(secretFile, secret, { mode: 0o600 });
    config.dataDir = root;
    config.secret.file = secretFile;
    const db: Db = openDb(":memory:");
    const store = new SqliteLlmConfigStore(db);
    store.save({
      configJson: serializeLlmConfig({
        url: "https://8.8.4.4/v1",
        model: "stored-model",
        maxTokens: 4096,
        timeoutSec: 45,
        ratePerMin: 9,
      }),
      sealedKey: new AesGcmSecretBox(secret).seal(KEY),
      sealedHeaders: null,
    });
    const { app } = await buildApp(db, false);
    const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
    try {
      const view = await app.inject({ method: "GET", url: "/api/settings/llm", headers: auth });
      expect(view.json()).toMatchObject({
        source: "db",
        enabled: true,
        url: "https://8.8.4.4/v1",
        model: "stored-model",
        keyState: "set",
        maxTokens: 4096,
        timeoutSec: 45,
        ratePerMin: 9,
      });
      const status = await app.inject({ method: "GET", url: "/api/chat/status", headers: auth });
      expect(status.json()).toMatchObject({ enabled: true, host: "8.8.4.4", model: "stored-model" });
      expect((await app.inject({ method: "DELETE", url: "/api/settings/llm", headers: auth })).statusCode).toBe(204);
      const after = await app.inject({ method: "GET", url: "/api/settings/llm", headers: auth });
      expect(after.json()).toMatchObject({ source: "none", enabled: false });
    } finally {
      await app.close();
      db.close();
    }
  });
});
