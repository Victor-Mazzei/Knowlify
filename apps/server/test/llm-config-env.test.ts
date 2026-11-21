import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { LEGACY_SESSION_HEADER } from "../src/domain/assistant/legacyHeaders.js";

afterEach(() => vi.unstubAllEnvs());

async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("LLM settings environment", () => {
  it("parses the lock, the private policy and the secret file location", async () => {
    const config = await loadConfig({
      KNOWLIFY_DATA: "/tmp/knowlify-config-test",
      KNOWLIFY_LLM_LOCKED: "1",
      KNOWLIFY_LLM_ALLOW_PRIVATE: " on ",
      KNOWLIFY_SECRET: "s".repeat(32),
    });
    expect(config.llmLocked).toBe(true);
    expect(config.llmAllowPrivate).toBe("on");
    expect(config.secret.value).toBe("s".repeat(32));
    expect(config.secret.invalid).toBe(false);
    expect(config.secret.file).toBe(join("/tmp/knowlify-config-test", "secret.key"));
  });

  it("rejects a short KNOWLIFY_SECRET without exposing it", async () => {
    const config = await loadConfig({
      KNOWLIFY_LLM_LOCKED: undefined,
      KNOWLIFY_SECRET: "too-short",
    });
    expect(config.llmLocked).toBe(false);
    expect(config.secret.value).toBeNull();
    expect(config.secret.invalid).toBe(true);
  });

  it("accepts a CIDR list verbatim for the policy parser", async () => {
    const config = await loadConfig({
      KNOWLIFY_LLM_ALLOW_PRIVATE: "127.0.0.1/32,192.168.1.0/24",
    });
    expect(config.llmAllowPrivate).toBe("127.0.0.1/32,192.168.1.0/24");
  });

  it("parses the API style and fails the boot on an unknown value", async () => {
    const openai = await loadConfig({ KNOWLIFY_LLM_API_STYLE: undefined });
    expect(openai.llm.apiStyle).toBe("openai");
    const anthropic = await loadConfig({ KNOWLIFY_LLM_API_STYLE: " anthropic " });
    expect(anthropic.llm.apiStyle).toBe("anthropic");
    await expect(loadConfig({ KNOWLIFY_LLM_API_STYLE: "gemini" }))
      .rejects.toThrow("KNOWLIFY_LLM_API_STYLE must be openai or anthropic");
  });

  it("uses the legacy session header only while KNOWLIFY_LLM_HEADERS is unset", async () => {
    const shim = await loadConfig({
      KNOWLIFY_LLM_URL: "https://api.example.com/v1",
      KNOWLIFY_LLM_HEADERS: undefined,
    });
    expect(shim.llm.legacySessionHeader).toBe(true);
    expect(shim.llm.headers).toEqual([LEGACY_SESSION_HEADER]);

    const disabled = await loadConfig({
      KNOWLIFY_LLM_URL: "https://api.example.com/v1",
      KNOWLIFY_LLM_HEADERS: "",
    });
    expect(disabled.llm.legacySessionHeader).toBe(false);
    expect(disabled.llm.headers).toEqual([]);

    const emptyObject = await loadConfig({
      KNOWLIFY_LLM_URL: "https://api.example.com/v1",
      KNOWLIFY_LLM_HEADERS: "{}",
    });
    expect(emptyObject.llm.legacySessionHeader).toBe(false);
    expect(emptyObject.llm.headers).toEqual([]);

    const configured = await loadConfig({
      KNOWLIFY_LLM_HEADERS: '{"X-Session-Id":"  conversation-{{conversationId}}  "}',
    });
    expect(configured.llm.headers).toEqual([
      { name: "X-Session-Id", value: "conversation-{{conversationId}}" },
    ]);
  });

  it("rejects invalid custom headers at boot without repeating their values", async () => {
    const sentinel = "ENV-VALUE-SENTINEL";
    for (const raw of [
      `{"Host":"${sentinel}"}`,
      `{"Accept-Language":"${sentinel}"}`,
      `{"X-To":"{{unknown}}"}`,
      `{"X-To":1}`,
      `{"X-To":"\\r\\n${sentinel}"}`,
      `{"X-To":"${sentinel}\\r\\n"}`,
      `{"X-To":"a\\r\\nb"}`,
      `{"X-To":"\\t${sentinel}"}`,
      `{"X-To":"${sentinel}\\u0000"}`,
      `{"X-To":"é-${sentinel}"}`,
      `not-json-${sentinel}`,
      JSON.stringify(Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`x-${index}`, sentinel]),
      )),
    ]) {
      const failure = await loadConfig({ KNOWLIFY_LLM_HEADERS: raw }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(sentinel);
    }
  });
});
