import { afterEach, describe, expect, it } from "vitest";
import { AnthropicLlmClient } from "../src/adapters/llm/AnthropicLlmClient.js";
import { createLlmClient } from "../src/adapters/llm/createLlmClient.js";
import { LlmError, type LlmEvent, type LlmRequest } from "../src/ports/assistant.js";
import {
  anthropicEvent,
  anthropicMessageStart,
  anthropicMessageStop,
  anthropicPing,
  anthropicStop,
  anthropicText,
  anthropicThinking,
  sseHead,
  startFakeProvider,
  writeJson,
  writeSplitEvent,
  type FakeProvider,
} from "./helpers/fakeProvider.js";

const KEY = "anthropic-key-sentinel";
const HEADER_SENTINEL = "anthropic-header-sentinel";
const PROMPT_SENTINEL = "PROMPT SENTINEL about the hidden chapter";
const PASSAGE_SENTINEL = "PASSAGE SENTINEL about deep work";

const request: LlmRequest = {
  messages: [
    { role: "system", content: "rules" },
    { role: "assistant", content: "earlier answer" },
    { role: "system", content: "scope" },
    { role: "user", content: PROMPT_SENTINEL },
  ],
  maxTokens: 64,
  temperature: 0.3,
  sessionId: "conversation-42",
};

const providers: FakeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
});

async function provider(handler: Parameters<typeof startFakeProvider>[0]): Promise<FakeProvider> {
  const started = await startFakeProvider(handler);
  providers.push(started);
  return started;
}

function client(url: string, options: Partial<ConstructorParameters<typeof AnthropicLlmClient>[0]> = {}) {
  return new AnthropicLlmClient({
    url,
    apiKey: KEY,
    model: "claude-test",
    warn: () => {},
    firstTokenTimeoutMs: 2_000,
    idleTimeoutMs: 2_000,
    timeoutMs: 5_000,
    headers: [{ name: "X-Session-Id", value: "conversation={{conversationId}}" }],
    ...options,
  });
}

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const collected: LlmEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("AnthropicLlmClient", () => {
  it("streams text, ignores ping/thinking, sends the Messages body and custom headers", async () => {
    const fake = await provider(async (_request, response) => {
      sseHead(response);
      await writeSplitEvent(response, anthropicMessageStart());
      response.write(anthropicPing());
      response.write(anthropicThinking("internal thoughts " + PASSAGE_SENTINEL));
      await writeSplitEvent(response, anthropicText("Hel"));
      response.write(anthropicText("lo"));
      response.write(anthropicStop());
      response.write(anthropicMessageStop());
      response.end();
    });

    const events = await collect(client(`${fake.url}/anthropic`).stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(JSON.stringify(events)).not.toContain("internal thoughts");

    expect(fake.requests).toHaveLength(1);
    const received = fake.requests[0];
    expect(received.path).toBe("/anthropic/v1/messages");
    expect(received.headers["x-api-key"]).toBe(KEY);
    expect(received.headers["anthropic-version"]).toBe("2023-06-01");
    expect(received.headers["x-session-id"]).toBe("conversation=conversation-42");
    expect(received.headers["user-agent"]).toBe("knowlify");
    expect(received.headers["content-type"]).toBe("application/json");
    expect(received.headers.authorization).toBeUndefined();
    expect(received.json).toEqual({
      model: "claude-test",
      max_tokens: 64,
      system: "rules\n\nscope",
      messages: [
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: PROMPT_SENTINEL },
      ],
      stream: true,
    });
    expect(received.json).not.toHaveProperty("temperature");
    expect(received.body).not.toContain(HEADER_SENTINEL);
  });

  it("accepts a stream that closes after stop_reason without message_stop", async () => {
    const fake = await provider((_request, response) => {
      sseHead(response);
      response.end(anthropicText("partial") + anthropicStop("max_tokens"));
    });
    const events = await collect(client(fake.url).stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", text: "partial" },
      { type: "done", finishReason: "length" },
    ]);
  });

  it("maps max_tokens and model_context_window_exceeded to a length finish", async () => {
    for (const stop of ["max_tokens", "model_context_window_exceeded"]) {
      const fake = await provider((_request, response) => {
        response.end(anthropicText("x") + anthropicStop(stop) + anthropicMessageStop());
      });
      const events = await collect(client(fake.url).stream(request, new AbortController().signal));
      expect(events.at(-1)).toEqual({ type: "done", finishReason: "length" });
    }
  });

  it("ignores unknown events and keeps waiting for text", async () => {
    const fake = await provider((_request, response) => {
      response.end(
        anthropicEvent("future_event", { something: true })
        + anthropicText("answer")
        + anthropicStop()
        + anthropicMessageStop(),
      );
    });
    const events = await collect(client(fake.url).stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", text: "answer" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it.each([
    { type: "overloaded_error", code: "unavailable", detail: "provider_unavailable" },
    { type: "api_error", code: "unavailable", detail: "provider_unavailable" },
    { type: "timeout_error", code: "unavailable", detail: "provider_unavailable" },
    { type: "rate_limit_error", code: "unavailable", detail: "rate_limited" },
    { type: "authentication_error", code: "rejected", detail: "authentication_failed" },
    { type: "permission_error", code: "rejected", detail: "permission_denied" },
    { type: "billing_error", code: "rejected", detail: "permission_denied" },
    { type: "invalid_request_error", code: "rejected", detail: "invalid_request" },
  ])("maps a stream $type error to a fixed diagnostic", async ({ type, code, detail }) => {
    const fake = await provider((_request, response) => {
      response.end(anthropicEvent("error", {
        error: { type, message: `provider said ${KEY} ${HEADER_SENTINEL} ${PASSAGE_SENTINEL}` },
      }));
    });
    const warnings: string[] = [];
    const error = await collect(client(fake.url, { warn: (message) => warnings.push(message) })
      .stream(request, new AbortController().signal)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code, providerDetail: detail });
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain(HEADER_SENTINEL);
    expect(warnings.join("\n")).not.toContain(HEADER_SENTINEL);
  });

  it("maps an unknown stream error type to protocol without provider text", async () => {
    const fake = await provider((_request, response) => {
      response.end(anthropicEvent("error", {
        error: { type: "mystery_error", message: `boom ${KEY}` },
      }));
    });
    const error = await collect(client(fake.url).stream(request, new AbortController().signal))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "protocol" });
    expect((error as Error).message).not.toContain(KEY);
  });

  it.each([
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } }, code: "rejected", detail: "authentication_failed" },
    { status: 403, body: { type: "error", error: { type: "permission_error", message: HEADER_SENTINEL } }, code: "rejected", detail: "permission_denied" },
    { status: 402, body: { type: "error", error: { type: "billing_error", message: HEADER_SENTINEL } }, code: "rejected", detail: "permission_denied" },
    { status: 413, body: { type: "error", error: { type: "request_too_large", message: PASSAGE_SENTINEL } }, code: "rejected", detail: "context_length_exceeded" },
    { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: PASSAGE_SENTINEL } }, code: "unavailable", detail: "rate_limited" },
    { status: 529, body: { type: "error", error: { type: "overloaded_error", message: PASSAGE_SENTINEL } }, code: "unavailable", detail: "provider_unavailable" },
    { status: 500, body: { type: "error", error: { type: "api_error", message: `crash ${KEY}` } }, code: "unavailable", detail: "provider_unavailable" },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${PASSAGE_SENTINEL} ${KEY}` } }, code: "rejected", detail: "context_length_exceeded" },
    { status: 404, body: { type: "error", error: { type: "not_found_error", message: `model: claude-missing ${HEADER_SENTINEL}` } }, code: "rejected", detail: "model_not_found" },
    { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: `bad request ${PASSAGE_SENTINEL}` } }, code: "rejected", detail: "invalid_request" },
  ])("classifies HTTP $status without leaking the body", async ({ status, body, code, detail }) => {
    let attempts = 0;
    const fake = await provider((_request, response) => {
      attempts += 1;
      writeJson(response, status, body);
    });
    const warnings: string[] = [];
    const error = await collect(client(fake.url, { warn: (message) => warnings.push(message) })
      .stream(request, new AbortController().signal)).catch((caught: unknown) => caught);
    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code, providerDetail: detail });
    const output = `${(error as Error).message}\n${warnings.join("\n")}`;
    for (const forbidden of [KEY, HEADER_SENTINEL, PROMPT_SENTINEL, PASSAGE_SENTINEL, "https://"]) {
      expect(output).not.toContain(forbidden);
    }
  });

  it("rejects malformed JSON, oversized events and oversized answers as protocol errors", async () => {
    const malformed = await provider((_request, response) => {
      response.end("data: not-json\n\n");
    });
    await expect(collect(client(malformed.url).stream(request, new AbortController().signal)))
      .rejects.toMatchObject({ code: "protocol" });

    const oversizedLine = await provider((_request, response) => {
      response.end(anthropicText("x".repeat(70 * 1024)));
    });
    await expect(collect(client(oversizedLine.url).stream(request, new AbortController().signal)))
      .rejects.toMatchObject({ code: "protocol" });

    const oversizedAnswer = await provider((_request, response) => {
      response.end(anthropicText("abcdef") + anthropicStop() + anthropicMessageStop());
    });
    await expect(collect(client(oversizedAnswer.url, { maxResponseChars: 4 })
      .stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "protocol" });
  });

  it("reports a stream that ends without any finish marker as protocol", async () => {
    const fake = await provider((_request, response) => {
      response.end(anthropicMessageStart() + anthropicText("partial"));
    });
    await expect(collect(client(fake.url).stream(request, new AbortController().signal)))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("times out when the first event never arrives", async () => {
    const fake = await provider((_request, response) => {
      sseHead(response);
    });
    await expect(collect(client(fake.url, { firstTokenTimeoutMs: 80, timeoutMs: 2_000 })
      .stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "timeout" });
  });

  it("times out when the stream goes idle between texts", async () => {
    const fake = await provider((_request, response) => {
      sseHead(response);
      response.write(anthropicText("one"));
    });
    await expect(collect(client(fake.url, { idleTimeoutMs: 80, timeoutMs: 2_000 })
      .stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "timeout" });
  });

  it("counts ping and thinking events as activity while waiting for the first text", async () => {
    const fake = await provider(async (_request, response) => {
      sseHead(response);
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.write(anthropicPing());
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.write(anthropicThinking("still thinking"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      response.write(anthropicText("answer"));
      response.write(anthropicStop());
      response.write(anthropicMessageStop());
      response.end();
    });
    const events = await collect(client(fake.url, { firstTokenTimeoutMs: 250, idleTimeoutMs: 250, timeoutMs: 3_000 })
      .stream(request, new AbortController().signal));
    expect(events).toEqual([
      { type: "delta", text: "answer" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("enforces the total budget even while keepalive events arrive", async () => {
    const fake = await provider(async (_request, response) => {
      sseHead(response);
      for (let index = 0; index < 20 && !response.destroyed; index += 1) {
        response.write(anthropicPing());
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      response.end();
    });
    await expect(collect(client(fake.url, {
      firstTokenTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      timeoutMs: 150,
    }).stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "timeout" });
  });

  it("aborts the upstream stream when the caller aborts", async () => {
    const fake = await provider((_request, response) => {
      sseHead(response);
      response.write(anthropicText("first"));
    });
    const controller = new AbortController();
    const iterator = client(fake.url).stream(request, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta", text: "first" } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
  });

  it("normalizes base, /v1, full Messages and gateway-prefixed URLs", async () => {
    const fake = await provider((_request, response) => {
      response.end(anthropicText("ok") + anthropicStop() + anthropicMessageStop());
    });
    for (const base of [fake.url, `${fake.url}/`, `${fake.url}/v1`, `${fake.url}/v1/`, `${fake.url}/v1/messages`]) {
      await collect(client(base).stream(request, new AbortController().signal));
    }
    for (const base of [`${fake.url}/anthropic`, `${fake.url}/anthropic/`]) {
      await collect(client(base).stream(request, new AbortController().signal));
    }
    expect(fake.requests.map((entry) => entry.path)).toEqual([
      "/v1/messages",
      "/v1/messages",
      "/v1/messages",
      "/v1/messages",
      "/v1/messages",
      "/anthropic/v1/messages",
      "/anthropic/v1/messages",
    ]);
  });
});

describe("Anthropic API style selection", () => {
  it("builds the Anthropic client from the shared factory and keeps the OpenAI default", async () => {
    const fake = await provider((_request, response) => {
      response.end(anthropicText("ok") + anthropicStop() + anthropicMessageStop());
    });
    const anthropic = createLlmClient({
      url: fake.url,
      apiKey: KEY,
      model: "claude-test",
      apiStyle: "anthropic",
    });
    expect(anthropic.configured).toBe(true);
    const events = await collect(anthropic.stream(request, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
    expect(fake.requests[0]?.path).toBe("/v1/messages");
    expect(fake.requests[0]?.headers["x-api-key"]).toBe(KEY);

    const openai = createLlmClient({
      url: fake.url,
      apiKey: KEY,
      model: "m",
    });
    const openAiEvents = await collect(openai.stream({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 8,
      temperature: 0.3,
    }, new AbortController().signal)).catch((caught: unknown) => caught);
    expect(openAiEvents).toBeInstanceOf(LlmError);
    expect(fake.requests.at(-1)?.path).toBe("/chat/completions");
  });
});
