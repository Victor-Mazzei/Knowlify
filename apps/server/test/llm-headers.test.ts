import { describe, expect, it } from "vitest";
import {
  HEADER_CONVERSATION_VARIABLE,
  MAX_LLM_HEADERS,
  PROBE_CONVERSATION_ID,
  assertLlmHeaderAllowed,
  isLlmHeaderNameForbidden,
  mergeLlmHeaders,
  normalizeLlmHeaderList,
  normalizeLlmHeaderName,
  normalizeLlmHeaderValue,
  parseLlmHeadersEnv,
  readStoredLlmHeaders,
  renderLlmHeaders,
  sensitiveHeaderValues,
} from "../src/domain/assistant/LlmHeaders.js";
import { LlmSettingsError } from "../src/domain/assistant/LlmSettingsError.js";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof LlmSettingsError ? error.code : "not-a-settings-error";
  }
}

function errorOf(run: () => unknown): LlmSettingsError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof LlmSettingsError ? error : undefined;
  }
}

const FORBIDDEN = [
  "Host",
  "Content-Length",
  "Transfer-Encoding",
  "Connection",
  "Keep-Alive",
  "Upgrade",
  "TE",
  "Trailer",
  "Expect",
  "Content-Type",
  "Content-Encoding",
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Accept-Charset",
  "accept-x",
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
  "Sec-Fetch-Site",
  ":authority",
];

describe("LLM custom headers domain", () => {
  it("accepts RFC 7230 tokens and preserves the typed case", () => {
    expect(normalizeLlmHeaderName("X-Session-Id")).toBe("X-Session-Id");
    expect(normalizeLlmHeaderName("x_custom.1+2")).toBe("x_custom.1+2");
    expect(normalizeLlmHeaderName("  X-Spaced  ")).toBe("X-Spaced");
    for (const invalid of ["", " ", "has space", "semi;colon", "chave-ção", "x".repeat(65), "x\ny"]) {
      expect(codeOf(() => normalizeLlmHeaderName(invalid))).toBe("invalid_header");
    }
    for (const invalid of ["\r\nX", "X\r\n", "\tX", "X\t", "X\u0000", "X\u007f"]) {
      const error = errorOf(() => normalizeLlmHeaderName(invalid));
      expect(error).toMatchObject({ code: "invalid_header", field: "name" });
    }
    expect(codeOf(() => normalizeLlmHeaderName(1))).toBe("invalid_header");
  });

  it("rejects every Accept* variant in both styles, ignoring case", () => {
    for (const style of ["openai", "anthropic"] as const) {
      for (const name of ["Accept", "accept", "Accept-Encoding", "Accept-Language", "ACCEPT-CHARSET", "accept-x"]) {
        expect(isLlmHeaderNameForbidden(name, style)).toBe(true);
        expect(errorOf(() => assertLlmHeaderAllowed(name, style))).toMatchObject({
          code: "invalid_header",
          field: "name",
        });
      }
    }
  });

  it("rejects every fixed, hop-by-hop and style-managed header", () => {
    for (const name of FORBIDDEN) {
      expect(isLlmHeaderNameForbidden(name, "openai")).toBe(true);
      expect(isLlmHeaderNameForbidden(name, "anthropic")).toBe(true);
      expect(codeOf(() => assertLlmHeaderAllowed(name, "openai"))).toBe("invalid_header");
    }
    // Style-owned credential header: forbidden in its own style, allowed in the other.
    expect(isLlmHeaderNameForbidden("x-api-key", "anthropic")).toBe(true);
    expect(isLlmHeaderNameForbidden("x-api-key", "openai")).toBe(false);
    expect(isLlmHeaderNameForbidden("user-agent", "anthropic")).toBe(false);
    expect(isLlmHeaderNameForbidden("anthropic-version", "anthropic")).toBe(false);
    expect(isLlmHeaderNameForbidden("anthropic-beta", "anthropic")).toBe(false);
  });

  it("validates the original value before trimming and accepts visible ASCII only", () => {
    expect(normalizeLlmHeaderValue("  ok  ", "x")).toBe("ok");
    expect(normalizeLlmHeaderValue("a".repeat(512), "x")).toHaveLength(512);
    for (const invalid of ["", "   ", "a".repeat(513)]) {
      expect(codeOf(() => normalizeLlmHeaderValue(invalid, "x"))).toBe("invalid_header");
    }
    for (const invalid of [
      "\r\nsecret",
      "secret\r\n",
      "a\r\nb",
      "\tx",
      "x\t",
      "x\u0000",
      "\u0007value",
      "é",
      "secret\u007f",
    ]) {
      expect(errorOf(() => normalizeLlmHeaderValue(invalid, "x"))).toMatchObject({
        code: "invalid_header",
        field: "value",
      });
    }
  });

  it("rejects unknown template variables and lone braces", () => {
    expect(normalizeLlmHeaderValue(`prefix-${HEADER_CONVERSATION_VARIABLE}`, "x"))
      .toBe("prefix-{{conversationId}}");
    for (const invalid of ["{{conversation}}", "{{conversationId}", "{{conversationId}}}", "{{", "}}", "{x}"]) {
      expect(codeOf(() => normalizeLlmHeaderValue(invalid, "x"))).toBe("invalid_header");
    }
  });

  it("rejects duplicates ignoring case, more than eight headers and oversized totals", () => {
    expect(codeOf(() => normalizeLlmHeaderList([
      { name: "X-One", value: "a" },
      { name: "x-one", value: "b" },
    ], "openai"))).toBe("invalid_header");

    const tooMany = Array.from({ length: MAX_LLM_HEADERS + 1 }, (_, index) => ({
      name: `x-${index}`,
      value: "v",
    }));
    expect(codeOf(() => normalizeLlmHeaderList(tooMany, "openai"))).toBe("invalid_header");

    const total = Array.from({ length: MAX_LLM_HEADERS }, (_, index) => ({
      name: `x-header-${index}`,
      value: "v".repeat(400),
    }));
    expect(codeOf(() => normalizeLlmHeaderList(total, "openai"))).toBe("invalid_header");
  });

  it("revalidates a kept list against the new style", () => {
    expect(codeOf(() => normalizeLlmHeaderList([{ name: "x-api-key", value: "v" }], "anthropic")))
      .toBe("invalid_header");
    expect(normalizeLlmHeaderList([{ name: "x-api-key", value: "v" }], "openai"))
      .toEqual([{ name: "x-api-key", value: "v" }]);
  });

  it("renders lowercase names, replaces every variable and omits it without a conversation", () => {
    const headers = [
      { name: "X-Session-Id", value: "a-{{conversationId}}-b-{{conversationId}}" },
      { name: "X-Static", value: "kept" },
    ];
    expect(renderLlmHeaders(headers, { conversationId: "c1" })).toEqual({
      "x-session-id": "a-c1-b-c1",
      "x-static": "kept",
    });
    expect(renderLlmHeaders(headers, {})).toEqual({ "x-static": "kept" });
    expect(errorOf(() => renderLlmHeaders(headers, { conversationId: "bad\nid" }))).toMatchObject({
      code: "invalid_header",
      field: "value",
    });
  });

  it("keeps a value only for the same origin and an existing name", () => {
    const existing = [{ name: "X-One", value: "saved" }];
    expect(mergeLlmHeaders([{ name: "x-one" }], existing, { sameOrigin: true, style: "openai" }))
      .toEqual([{ name: "x-one", value: "saved" }]);
    expect(errorOf(() => mergeLlmHeaders([{ name: "x-one" }], existing, { sameOrigin: false, style: "openai" })))
      .toMatchObject({ code: "header_value_required", field: "value" });
    // Renaming is a new header: it never inherits the value of another name.
    expect(errorOf(() => mergeLlmHeaders([{ name: "x-two" }], existing, { sameOrigin: true, style: "openai" })))
      .toMatchObject({ code: "header_value_required", field: "value" });
    expect(mergeLlmHeaders([], existing, { sameOrigin: true, style: "openai" })).toEqual([]);
    expect(mergeLlmHeaders([{ name: "x-one", value: "new" }], existing, { sameOrigin: true, style: "openai" }))
      .toEqual([{ name: "x-one", value: "new" }]);
  });

  it("parses the environment object and never repeats a value in the error", () => {
    expect(parseLlmHeadersEnv('{"X-One":"a","x-two":"b"}', "openai")).toEqual([
      { name: "X-One", value: "a" },
      { name: "x-two", value: "b" },
    ]);
    expect(parseLlmHeadersEnv("{}", "openai")).toEqual([]);
    const sentinel = "VALUE-SENTINEL";
    for (const invalid of [
      `{"Host":"${sentinel}"}`,
      `{"Accept-Language":"${sentinel}"}`,
      `{"X-One":"${sentinel}"} trailing`,
      `["${sentinel}"]`,
      `{"X-One":1}`,
      `{"X-One":"{{bad}}"}`,
      `{"X-One":"\\r\\nsecret"}`,
      `{"X-One":"secret\\u0000"}`,
    ]) {
      const error = (() => {
        try {
          parseLlmHeadersEnv(invalid, "openai");
          return undefined;
        } catch (caught) {
          return caught as Error;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain(sentinel);
    }
  });

  it("rebuilds stored values only when the names match exactly", () => {
    const names = ["X-One", "x-two"];
    expect(readStoredLlmHeaders({ "X-One": "a", "x-two": "b" }, names, "openai")).toEqual([
      { name: "X-One", value: "a" },
      { name: "x-two", value: "b" },
    ]);
    expect(readStoredLlmHeaders({ "X-One": "a" }, names, "openai")).toBeNull();
    expect(readStoredLlmHeaders({ "X-One": "a", "x-two": "b", extra: "c" }, names, "openai")).toBeNull();
    expect(readStoredLlmHeaders({ "X-One": "a", "x-two": "bad\nvalue" }, names, "openai")).toBeNull();
    expect(readStoredLlmHeaders({ "X-One": "a", "x-two": "b" }, names, "anthropic")).toEqual([
      { name: "X-One", value: "a" },
      { name: "x-two", value: "b" },
    ]);
    expect(readStoredLlmHeaders({ "x-api-key": "leaked" }, ["x-api-key"], "anthropic")).toBeNull();
    expect(readStoredLlmHeaders(null, names, "openai")).toBeNull();
  });

  it("resolves templates and treats every rendered value as sensitive, however short", () => {
    expect(sensitiveHeaderValues([
      { name: "x-one-char", value: "q" },
      { name: "x-short", value: "secret" },
      { name: "x-long", value: "long-value" },
      { name: "x-template", value: `prefix-${HEADER_CONVERSATION_VARIABLE}` },
      { name: "x-repeated", value: `${HEADER_CONVERSATION_VARIABLE}-a-${HEADER_CONVERSATION_VARIABLE}` },
    ])).toEqual([
      "q",
      "secret",
      "long-value",
      `prefix-${PROBE_CONVERSATION_ID}`,
      `${PROBE_CONVERSATION_ID}-a-${PROBE_CONVERSATION_ID}`,
    ]);
  });
});
