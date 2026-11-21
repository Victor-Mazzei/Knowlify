import { describe, expect, it } from "vitest";
import {
  LLM_DEFAULTS,
  LlmSettingsError,
  normalizeLlmApiKey,
  normalizeLlmConfig,
  normalizeLlmModel,
  normalizeLlmUrl,
  parseStoredLlmConfig,
  serializeLlmConfig,
  storedLlmConfigIsLegacy,
  urlOrigin,
} from "../src/domain/assistant/LlmConfig.js";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof LlmSettingsError ? error.code : "not-a-settings-error";
  }
}

describe("LLM config value object", () => {
  it("normalizes HTTP(S) URLs and strips trailing slashes", () => {
    expect(normalizeLlmUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(normalizeLlmUrl(" http://127.0.0.1:11434/v1 ")).toBe("http://127.0.0.1:11434/v1");
    expect(normalizeLlmUrl("https://api.example.com")).toBe("https://api.example.com");
  });

  it.each([
    "",
    "not a url",
    "ftp://api.example.com/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/v1?key=value",
    `https://api.example.com/${"a".repeat(2_048)}`,
  ])("rejects an invalid URL: %s", (url) => {
    expect(codeOf(() => normalizeLlmUrl(url))).toBe("invalid_url");
  });

  it("accepts a model name without controls and rejects oversized/control values", () => {
    expect(normalizeLlmModel(undefined)).toBeNull();
    expect(normalizeLlmModel(null)).toBeNull();
    expect(normalizeLlmModel("  deepseek-v4.1-flash ")).toBe("deepseek-v4.1-flash");
    expect(codeOf(() => normalizeLlmModel("bad\u0007model"))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmModel("m".repeat(201)))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmModel("   "))).toBe("invalid_value");
  });

  it("only accepts visible ASCII in API keys", () => {
    expect(normalizeLlmApiKey("sk-abc_123:XYZ")).toBe("sk-abc_123:XYZ");
    expect(codeOf(() => normalizeLlmApiKey(""))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmApiKey("has space"))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmApiKey("line\nbreak"))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmApiKey("chave-ção"))).toBe("invalid_value");
    expect(codeOf(() => normalizeLlmApiKey("k".repeat(513)))).toBe("invalid_value");
  });

  it("applies defaults and range validation to numeric settings", () => {
    const config = normalizeLlmConfig({ url: "https://api.example.com/v1" });
    expect(config).toEqual({
      url: "https://api.example.com/v1",
      model: null,
      ...LLM_DEFAULTS,
      apiStyle: "openai",
      headerNames: [],
    });
    expect(normalizeLlmConfig({
      url: "https://api.example.com/v1",
      maxTokens: 4_096,
      timeoutSec: 30,
      ratePerMin: 5,
    })).toMatchObject({ maxTokens: 4_096, timeoutSec: 30, ratePerMin: 5 });
    for (const invalid of [
      { maxTokens: 0 },
      { maxTokens: 32_769 },
      { maxTokens: 1.5 },
      { timeoutSec: 4 },
      { timeoutSec: 601 },
      { ratePerMin: 0 },
      { ratePerMin: 121 },
    ]) {
      expect(codeOf(() => normalizeLlmConfig({ url: "https://api.example.com/v1", ...invalid }))).toBe("invalid_value");
    }
  });

  it("round-trips the stored JSON and rejects corrupted rows", () => {
    const config = normalizeLlmConfig({
      url: "https://api.example.com/v1",
      model: "model",
      maxTokens: 2_048,
      timeoutSec: 60,
      ratePerMin: 10,
      apiStyle: "anthropic",
      headerNames: ["X-Session-Id", "anthropic-beta"],
    });
    expect(parseStoredLlmConfig(serializeLlmConfig(config))).toEqual(config);
    expect(codeOf(() => parseStoredLlmConfig("{not json"))).toBe("invalid_value");
    expect(codeOf(() => parseStoredLlmConfig(JSON.stringify({ url: 1 })))).toBe("invalid_value");
    expect(codeOf(() => parseStoredLlmConfig(JSON.stringify({ url: "ftp://x" })))).toBe("invalid_url");
    expect(codeOf(() => parseStoredLlmConfig(JSON.stringify({ url: "https://x", apiStyle: "other" }))))
      .toBe("invalid_value");
    expect(codeOf(() => parseStoredLlmConfig(JSON.stringify({
      url: "https://x",
      apiStyle: "anthropic",
      headerNames: ["x-api-key"],
    })))).toBe("invalid_value");
  });

  it("treats a row without headerNames as legacy and defaults the style to openai", () => {
    const legacy = JSON.stringify({ url: "https://x.example.com/v1", model: "m" });
    expect(storedLlmConfigIsLegacy(legacy)).toBe(true);
    expect(parseStoredLlmConfig(legacy)).toMatchObject({ apiStyle: "openai", headerNames: [] });
    expect(storedLlmConfigIsLegacy(serializeLlmConfig(normalizeLlmConfig({ url: "https://x.example.com/v1" }))))
      .toBe(false);
    expect(storedLlmConfigIsLegacy("{not json")).toBe(false);
  });

  it("compares origins for the key-leak rule", () => {
    expect(urlOrigin("https://api.example.com/v1")).toBe("https://api.example.com");
    expect(urlOrigin("https://api.example.com:8443/v1")).toBe("https://api.example.com:8443");
    expect(urlOrigin("https://api.example.com/v1")).not.toBe(urlOrigin("http://api.example.com/v1"));
  });
});
