import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return (await import("../src/config.js")).config;
}

describe("assistant configuration", () => {
  it("disables the LLM by default and applies the documented limits", async () => {
    const config = await loadConfig({
      KNOWLIFY_LLM_URL: undefined,
      KNOWLIFY_LLM_API_KEY: undefined,
      KNOWLIFY_LLM_MODEL: undefined,
      KNOWLIFY_LLM_MAX_TOKENS: undefined,
      KNOWLIFY_LLM_TIMEOUT_SEC: undefined,
      KNOWLIFY_LLM_RATE_PER_MIN: undefined,
      KNOWLIFY_LLM_HEADERS: undefined,
      KNOWLIFY_LLM_API_STYLE: undefined,
    });
    expect(config.llm).toEqual({
      url: null,
      apiKey: null,
      model: null,
      maxTokens: 1024,
      timeoutSec: 120,
      ratePerMin: 20,
      apiStyle: "openai",
      headers: [],
      legacySessionHeader: false,
    });
  });

  it("accepts a plain http(s) base URL and normalizes the trailing slash", async () => {
    const secure = await loadConfig({
      KNOWLIFY_LLM_URL: "https://api.example.com/v1/",
      KNOWLIFY_LLM_API_KEY: " secret ",
      KNOWLIFY_LLM_MODEL: " deepseek-v4.1-flash ",
    });
    expect(secure.llm).toMatchObject({
      url: "https://api.example.com/v1",
      apiKey: "secret",
      model: "deepseek-v4.1-flash",
    });

    const local = await loadConfig({ KNOWLIFY_LLM_URL: "http://127.0.0.1:11434/v1" });
    expect(local.llm.url).toBe("http://127.0.0.1:11434/v1");
  });

  it("rejects URLs with credentials, fragments or a non-HTTP scheme", async () => {
    for (const value of [
      "ftp://api.example.com/v1",
      "https://user:pass@api.example.com/v1",
      "https://api.example.com/v1#fragment",
      "not a url",
    ]) {
      const config = await loadConfig({ KNOWLIFY_LLM_URL: value });
      expect(config.llm.url).toBeNull();
    }
  });

  it("invalid numeric values fall back to the defaults", async () => {
    const config = await loadConfig({
      KNOWLIFY_LLM_MAX_TOKENS: "0",
      KNOWLIFY_LLM_TIMEOUT_SEC: "1.5",
      KNOWLIFY_LLM_RATE_PER_MIN: "many",
      KNOWLIFY_EMBEDDINGS_THREADS: "-2",
    });
    expect(config.llm).toMatchObject({ maxTokens: 1024, timeoutSec: 120, ratePerMin: 20 });
    expect(config.indexing.embeddings.threads).toBeGreaterThanOrEqual(1);
    expect(config.indexing.embeddings.threads).toBeLessThanOrEqual(4);
  });

  it("accepts an explicit embedding thread count", async () => {
    const config = await loadConfig({ KNOWLIFY_EMBEDDINGS_THREADS: "2" });
    expect(config.indexing.embeddings.threads).toBe(2);
  });

  it("derives browse roots from library paths and accepts `any` as unrestricted", async () => {
    const derived = await loadConfig({
      KNOWLIFY_LIBRARY_PATHS: "/library, /srv/books",
      KNOWLIFY_BROWSE_ROOTS: undefined,
    });
    expect(derived.libraryPaths).toEqual(["/library", "/srv/books"]);
    expect(derived.browseRoots).toEqual(["/library", "/srv/books"]);

    const explicit = await loadConfig({ KNOWLIFY_BROWSE_ROOTS: "/library, /srv/books" });
    expect(explicit.browseRoots).toEqual(["/library", "/srv/books"]);

    const unrestricted = await loadConfig({ KNOWLIFY_BROWSE_ROOTS: "any" });
    expect(unrestricted.browseRoots).toEqual([]);
  });
});
