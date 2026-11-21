import { afterEach, describe, expect, it } from "vitest";
import { AnthropicModelsProbe } from "../src/adapters/llm/AnthropicModelsProbe.js";
import { createGuardedFetch } from "../src/adapters/llm/GuardedFetch.js";
import type { LlmProbeTarget } from "../src/ports/llm-settings.js";
import { startFakeProvider, writeJson, type FakeProvider } from "./helpers/fakeProvider.js";

const KEY = "anthropic-probe-key-sentinel";
const HEADER_SENTINEL = "probe-header-sentinel";
const providers: FakeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
});

async function provider(handler: Parameters<typeof startFakeProvider>[0]): Promise<FakeProvider> {
  const started = await startFakeProvider(handler);
  providers.push(started);
  return started;
}

function target(overrides: Partial<LlmProbeTarget> & Pick<LlmProbeTarget, "url">): LlmProbeTarget {
  return {
    apiKey: KEY,
    model: null,
    apiStyle: "anthropic",
    headers: [{ name: "X-Probe", value: HEADER_SENTINEL }],
    ...overrides,
  };
}

describe("Anthropic Messages probe", () => {
  it("lists models from /v1/models with the Anthropic headers and normalizes URLs", async () => {
    const fake = await provider((_request, response) => {
      writeJson(response, 200, {
        data: [{ id: "claude-b", display_name: "B" }, { id: "claude-a" }, { id: "claude-a" }],
        has_more: false,
      });
    });
    const probe = new AnthropicModelsProbe(globalThis.fetch);
    for (const base of [fake.url, `${fake.url}/v1`, `${fake.url}/v1/messages`, `${fake.url}/gateway`]) {
      await probe.listModels(target({ url: base }));
    }
    expect(fake.requests.map((entry) => entry.path)).toEqual([
      "/v1/models?limit=1000",
      "/v1/models?limit=1000",
      "/v1/models?limit=1000",
      "/gateway/v1/models?limit=1000",
    ]);
    const first = fake.requests[0];
    expect(first?.headers["x-api-key"]).toBe(KEY);
    expect(first?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(first?.headers["x-probe"]).toBe(HEADER_SENTINEL);
    expect(first?.headers["user-agent"]).toBe("knowlify");
    expect(first?.headers.authorization).toBeUndefined();
  });

  it("lets a custom anthropic-version header override the default", async () => {
    const fake = await provider((_request, response) => {
      writeJson(response, 200, { data: [] });
    });
    await new AnthropicModelsProbe(globalThis.fetch).listModels(target({
      url: fake.url,
      headers: [{ name: "anthropic-version", value: "2026-10-21" }],
    }));
    expect(fake.requests[0]?.headers["anthropic-version"]).toBe("2026-10-21");
  });

  it("drops model ids that echo the key or a rendered or short custom header value", async () => {
    const fake = await provider((_request, response) => {
      writeJson(response, 200, {
        data: [
          { id: KEY },
          { id: `prefix-${HEADER_SENTINEL}` },
          { id: "echo-secret" },
          { id: "echo-prefix-knowlify-probe" },
          { id: "claude-safe" },
        ],
      });
    });
    const headers = [
      { name: "X-Probe", value: HEADER_SENTINEL },
      { name: "X-Short", value: "secret" },
      { name: "X-Template", value: "prefix-{{conversationId}}" },
    ];
    const probe = new AnthropicModelsProbe(globalThis.fetch);
    const result = await probe.listModels(target({ url: fake.url, headers }));
    expect(result).toEqual({ supported: true, models: ["claude-safe"] });
    expect(fake.requests[0]?.headers["x-short"]).toBe("secret");
    expect(fake.requests[0]?.headers["x-template"]).toBe("prefix-knowlify-probe");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(HEADER_SENTINEL);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("prefix-knowlify-probe");

    const status = await probe.testChat(target({ url: fake.url, model: "secret", headers }));
    expect(status).toMatchObject({ ok: true, modelFound: false });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("maps auth failures to unauthorized and unimplemented endpoints to unsupported", async () => {
    for (const status of [401, 403]) {
      const fake = await provider((_request, response) => writeJson(response, status, {
        type: "error",
        error: { type: "authentication_error", message: `SECRET ${KEY}` },
      }));
      const result = await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: fake.url }));
      expect(result).toEqual({ supported: false, models: [], code: "unauthorized" });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
    for (const status of [404, 405, 501]) {
      const fake = await provider((_request, response) => {
        response.writeHead(status);
        response.end("no models");
      });
      expect(await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: fake.url })))
        .toEqual({ supported: false, models: [] });
    }
  });

  it("maps overload, rate limits and malformed payloads to fixed codes without echoing text", async () => {
    for (const status of [429, 500, 529]) {
      const fake = await provider((_request, response) => writeJson(response, status, {
        type: "error",
        error: { type: "overloaded_error", message: `SECRET ${KEY}` },
      }));
      const result = await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: fake.url }));
      expect(result).toMatchObject({ supported: false, code: "unreachable" });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }

    const malformed = await provider((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json SECRET");
    });
    const result = await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: malformed.url }));
    expect(result).toEqual({ supported: false, models: [], code: "rejected" });
    expect(JSON.stringify(result)).not.toContain("SECRET");

    const oversized = await provider((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], pad: "SECRET".repeat(200_000) }));
    });
    expect(await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: oversized.url })))
      .toEqual({ supported: false, models: [], code: "rejected" });
  });

  it("caps the list at 500 ids and rejects redirects", async () => {
    const capped = await provider((_request, response) => {
      writeJson(response, 200, {
        data: Array.from({ length: 600 }, (_, index) => ({ id: `claude-${index}` })),
        has_more: true,
      });
    });
    const result = await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: capped.url }));
    expect(result.models).toHaveLength(500);

    const redirect = await provider((_request, response) => {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
    });
    expect(await new AnthropicModelsProbe(globalThis.fetch).listModels(target({ url: redirect.url })))
      .toEqual({ supported: false, models: [], code: "unreachable" });
    expect(redirect.requests).toHaveLength(1);
  });

  it("tests a supported models endpoint without spending tokens", async () => {
    const fake = await provider((_request, response) => {
      writeJson(response, 200, { data: [{ id: "claude-test" }] });
    });
    const probe = new AnthropicModelsProbe(globalThis.fetch);
    await expect(probe.testChat(target({ url: fake.url, model: "claude-test" })))
      .resolves.toMatchObject({ ok: true, modelFound: true });
    await expect(probe.testChat(target({ url: fake.url, model: "claude-other" })))
      .resolves.toMatchObject({ ok: true, modelFound: false });
    const noModel = await probe.testChat(target({ url: fake.url }));
    expect(noModel.ok).toBe(true);
    expect(noModel).not.toHaveProperty("modelFound");
  });

  it("falls back to one-token Messages only when /models is unsupported and a model exists", async () => {
    const fake = await provider((request, response) => {
      if (request.path.startsWith("/v1/models")) {
        response.writeHead(404);
        response.end("missing");
        return;
      }
      writeJson(response, 200, {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        stop_reason: "end_turn",
      });
    });
    const probe = new AnthropicModelsProbe(globalThis.fetch);
    const noModel = await probe.testChat(target({ url: fake.url }));
    expect(noModel.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);

    const fallback = await probe.testChat(target({
      url: fake.url,
      model: "claude-test",
      headers: [
        { name: "X-Probe", value: HEADER_SENTINEL },
        { name: "anthropic-version", value: "2026-10-21" },
      ],
    }));
    expect(fallback).toMatchObject({ ok: true, modelFound: true });
    const messages = fake.requests.at(-1);
    expect(messages?.path).toBe("/v1/messages");
    expect(messages?.headers["x-api-key"]).toBe(KEY);
    expect(messages?.headers["anthropic-version"]).toBe("2026-10-21");
    expect(messages?.headers["x-probe"]).toBe(HEADER_SENTINEL);
    expect(messages?.json).toEqual({
      model: "claude-test",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    });
    expect(JSON.stringify(fallback)).not.toContain(KEY);
  });

  it("maps fallback failures to fixed codes and never echoes the provider body", async () => {
    for (const [status, code] of [[401, "unauthorized"], [404, "not_found"], [429, "unreachable"], [500, "unreachable"], [400, "rejected"]] as const) {
      const fake = await provider((request, response) => {
        if (request.path.startsWith("/v1/models")) {
          response.writeHead(404);
          response.end();
          return;
        }
        writeJson(response, status, {
          type: "error",
          error: { type: "invalid_request_error", message: `SECRET ${KEY}` },
        });
      });
      const result = await new AnthropicModelsProbe(globalThis.fetch).testChat(target({
        url: fake.url,
        model: "m",
      }));
      expect(result).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it("maps timeouts and blocked destinations to codes", async () => {
    const timingOut = new AnthropicModelsProbe(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await timingOut.testChat(target({ url: "https://api.example.com" })))
      .toMatchObject({ ok: false, code: "timeout" });

    const fake = await provider((_request, response) => response.end("should not run"));
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const blocked = await new AnthropicModelsProbe(guarded).testChat(target({ url: fake.url }));
    expect(blocked).toMatchObject({ ok: false, code: "blocked" });
  });
});
