import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleLlmClient } from "../src/adapters/llm/OpenAiCompatibleLlmClient.js";
import { createLlmClient } from "../src/adapters/llm/createLlmClient.js";
import { LlmError, type LlmEvent, type LlmRequest } from "../src/ports/assistant.js";

const KEY = "super-secret-key";
const request: LlmRequest = {
  messages: [
    { role: "system", content: "rules" },
    { role: "user", content: "question" },
  ],
  maxTokens: 64,
  temperature: 0.3,
};

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, bodies: unknown[]) => void | Promise<void>,
  run: (baseUrl: string, bodies: unknown[]) => Promise<void>,
): Promise<void> {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, bodies)).catch(() => res.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await run(`http://127.0.0.1:${port}/v1`, bodies);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function client(baseUrl: string, options: Partial<ConstructorParameters<typeof OpenAiCompatibleLlmClient>[0]> = {}) {
  return new OpenAiCompatibleLlmClient({
    url: baseUrl,
    apiKey: KEY,
    model: "test-model",
    warn: () => {},
    ...options,
  });
}

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const collected: LlmEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("OpenAiCompatibleLlmClient", () => {
  it("streams SSE deltas, ignores reasoning content and waits for [DONE]", async () => {
    await withServer(async (req, res, bodies) => {
      bodies.push(JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"internal thoughts"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"');
      res.write('},"finish_reason":"stop"}]}\n\n');
      res.end("data: [DONE]\n\n");
    }, async (baseUrl, bodies) => {
      const events = await collect(client(baseUrl).stream(request, new AbortController().signal));
      expect(events).toEqual([
        { type: "delta", text: "Hel" },
        { type: "delta", text: "lo" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(JSON.stringify(events)).not.toContain("internal thoughts");
      expect(bodies).toEqual([{
        model: "test-model",
        messages: request.messages,
        max_tokens: 64,
        temperature: 0.3,
        stream: true,
      }]);
    });
  });

  it("keeps the first-token timer alive while a reasoning model is thinking", async () => {
    // Reasoning-first models can stream only `reasoning_content` for a long time.
    // Ignoring it must not count as silence for the first-token timeout.
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => {
        res.write('data: {"choices":[{"delta":{"reasoning_content":"reasoning sentinel"}}]}\n\n');
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        res.write('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
        res.end("data: [DONE]\n\n");
      }, 2_000);
    }, async (baseUrl) => {
      const events = await collect(client(baseUrl, {
        firstTokenTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
        timeoutMs: 6_000,
      }).stream(request, new AbortController().signal));
      expect(events).toEqual([
        { type: "delta", text: "answer" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(JSON.stringify(events)).not.toContain("reasoning sentinel");
    });
  });

  it("ignores empty choices, null content and usage-only chunks", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[],"usage":null}\n\n');
      res.write('data: {"choices":[{"delta":{"content":null},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n');
      res.end("data: [DONE]\n\n");
    }, async (baseUrl) => {
      const events = await collect(client(baseUrl).stream(request, new AbortController().signal));
      expect(events).toEqual([{ type: "done", finishReason: "stop" }]);
    });
  });

  it("accepts a stream that closes after finish_reason without [DONE]", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n');
    }, async (baseUrl) => {
      const events = await collect(client(baseUrl).stream(request, new AbortController().signal));
      expect(events).toEqual([
        { type: "delta", text: "partial" },
        { type: "done", finishReason: "length" },
      ]);
    });
  });

  it("maps auth failures to rejected without leaking the key", async () => {
    await withServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl).stream(request, new AbortController().signal))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({
        code: "rejected",
        providerStatus: 401,
        providerDetail: "authentication_failed",
      });
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).not.toContain("bad key");
    });
  });

  it("retries once without an optional parameter rejected with 400", async () => {
    const bodies: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const promptSentinel = "PROMPT SENTINEL: explain the hidden chapter";
    const encodedKey = Buffer.from(KEY).toString("base64");
    let attempts = 0;
    await withServer(async (req, res) => {
      attempts += 1;
      bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      if (attempts === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: `Unsupported parameter: 'max_tokens' is not supported with this model. ${promptSentinel} key ${KEY} encoded ${encodedKey} at https://provider.example/v1?token=${KEY}`,
          },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, async (baseUrl) => {
      const events = await collect(client(baseUrl, { warn: (message) => warnings.push(message) })
        .stream(request, new AbortController().signal));
      expect(events).toEqual([
        { type: "delta", text: "ok" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(attempts).toBe(2);
      expect(bodies[0]).toHaveProperty("max_tokens", 64);
      expect(bodies[1]).not.toHaveProperty("max_tokens");
      expect(bodies[1]).toHaveProperty("temperature", 0.3);
      const log = warnings.join("\n");
      expect(log).toContain("status 400 (unsupported_max_tokens)");
      expect(log).toContain('rejected optional parameter "max_tokens"');
      expect(log).not.toContain(promptSentinel);
      expect(log).not.toContain(KEY);
      expect(log).not.toContain(encodedKey);
      expect(log).not.toContain("http");
    });
  });

  it.each([
    {
      name: "authentication mixed with an unsupported parameter",
      message: "invalid api key; unsupported temperature",
      expected: "authentication_failed",
    },
    {
      name: "authentication mixed with a disconnected temperature value",
      message: "invalid api key; temperature is 0.3",
      expected: "authentication_failed",
    },
    {
      name: "model failure mixed with an unsupported parameter",
      message: "invalid model; unsupported max_tokens",
      expected: "model_not_found",
    },
    {
      name: "context failure mixed with an unsupported parameter",
      message: "context length exceeded; unsupported temperature",
      expected: "context_length_exceeded",
    },
    {
      name: "permission failure mixed with an unsupported parameter",
      message: "permission denied; unsupported max_tokens",
      expected: "permission_denied",
    },
    {
      name: "rate limit mixed with an unsupported parameter",
      message: "rate limit exceeded; unsupported temperature",
      expected: "rate_limited",
    },
    {
      name: "disconnected words without another diagnosis",
      message: "invalid request; temperature is 0.3",
      expected: "invalid_request",
    },
    {
      name: "echoed prompt words next to a real authentication failure",
      message: "invalid api key; prompt asked about unsupported temperature and max_tokens",
      expected: "authentication_failed",
    },
  ])("does not retry a mixed 400: $name", async ({ message, expected }) => {
    const warnings: string[] = [];
    let attempts = 0;
    await withServer((_req, res) => {
      attempts += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl, { warn: (warning) => warnings.push(warning) })
        .stream(request, new AbortController().signal)).catch((caught: unknown) => caught);
      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ code: "rejected", providerStatus: 400, providerDetail: expected });
      expect(warnings.join("\n")).toContain(`(${expected})`);
    });
  });

  it("makes at most one optional-parameter fallback attempt", async () => {
    const bodies: Record<string, unknown>[] = [];
    let attempts = 0;
    await withServer(async (req, res) => {
      attempts += 1;
      bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: attempts === 1
            ? "Unsupported parameter: 'max_tokens' is not supported with this model."
            : "Unsupported parameter: 'temperature' is not supported with this model.",
        },
      }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl).stream(request, new AbortController().signal))
        .catch((caught: unknown) => caught);
      expect(attempts).toBe(2);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("max_tokens", 64);
      expect(bodies[1]).not.toHaveProperty("max_tokens");
      expect(error).toMatchObject({ code: "rejected", providerDetail: "unsupported_temperature" });
    });
  });

  it("reports an unrelated 400 without retrying and exposes only an allowlisted diagnostic", async () => {
    const warnings: string[] = [];
    let attempts = 0;
    await withServer((_req, res) => {
      attempts += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "MissingSessionID",
          message: "Request is missing session header and cannot be routed efficiently. See https://provider.example/docs",
        },
      }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl, { warn: (message) => warnings.push(message) })
        .stream(request, new AbortController().signal)).catch((caught: unknown) => caught);
      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({
        code: "rejected",
        providerStatus: 400,
        providerDetail: "missing_session",
      });
      const log = warnings.join("\n");
      expect(log).toContain("status 400 (missing_session)");
      expect(log).not.toContain("Request is missing");
      expect(log).not.toContain("http");
    });
  });

  it("classifies a JSON error without forwarding echoed prompt, passage, URL or secret", async () => {
    const warnings: string[] = [];
    const promptSentinel = "PROMPT SENTINEL RULES";
    const passageSentinel = "PASSAGE SENTINEL about deep work";
    const encodedKey = Buffer.from(KEY).toString("base64");
    const sentinelRequest: LlmRequest = {
      messages: [
        { role: "system", content: promptSentinel },
        { role: "user", content: passageSentinel },
      ],
      maxTokens: 8,
      temperature: 0.3,
    };
    await withServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: `Invalid request for prompt ${promptSentinel} and passage ${passageSentinel}; key ${KEY}; encoded ${encodedKey}; see https://provider.example/v1?token=${KEY}`,
        },
      }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl, { warn: (message) => warnings.push(message) })
        .stream(sentinelRequest, new AbortController().signal)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({ code: "rejected", providerStatus: 400, providerDetail: "invalid_request" });
      expect((error as Error).message).not.toContain(promptSentinel);
      expect((error as Error).message).not.toContain(passageSentinel);
      expect((error as Error).message).not.toContain(KEY);

      const log = warnings.join("\n");
      expect(log).toContain("status 400 (invalid_request)");
      for (const forbidden of [promptSentinel, passageSentinel, KEY, encodedKey, "https://", "provider.example"]) {
        expect(log).not.toContain(forbidden);
      }
    });
  });

  it("falls back for a plain-text body without forwarding the echoed content", async () => {
    const warnings: string[] = [];
    const promptSentinel = "PROMPT SENTINEL plain text";
    const passageSentinel = "PASSAGE SENTINEL plain text";
    const encodedKey = Buffer.from(KEY).toString("base64");
    const bodies: Record<string, unknown>[] = [];
    const sentinelRequest: LlmRequest = {
      messages: [
        { role: "system", content: promptSentinel },
        { role: "user", content: passageSentinel },
      ],
      maxTokens: 64,
      temperature: 0.3,
    };
    await withServer(async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)) as Record<string, unknown>);
      if (bodies.length === 1) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(
          `Unsupported parameter: temperature is not supported for prompt ${promptSentinel} and passage ${passageSentinel}; key ${KEY}; encoded ${encodedKey}; see https://provider.example/v1?token=${KEY}`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, async (baseUrl) => {
      const events = await collect(client(baseUrl, { warn: (message) => warnings.push(message) })
        .stream(sentinelRequest, new AbortController().signal));
      expect(events).toEqual([
        { type: "delta", text: "ok" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toHaveProperty("temperature");
      const log = warnings.join("\n");
      expect(log).toContain("status 400 (unsupported_temperature)");
      expect(log).toContain('rejected optional parameter "temperature"');
      for (const forbidden of [promptSentinel, passageSentinel, KEY, encodedKey, "https://", "provider.example"]) {
        expect(log).not.toContain(forbidden);
      }
    });
  });

  it("does not forward an oversized provider body", async () => {
    const warnings: string[] = [];
    await withServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "x".repeat(5_000) } }));
    }, async (baseUrl) => {
      const error = await collect(client(baseUrl, { warn: (message) => warnings.push(message) })
        .stream(request, new AbortController().signal)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).providerDetail).toBe("invalid_request");
      expect(warnings).toEqual(["[llm] provider returned status 400 (invalid_request)"]);
    });
  });

  it("sends the default openai user agent when no custom header overrides it", async () => {
    let headers: IncomingHttpHeaders = {};
    await withServer((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, async (baseUrl) => {
      await collect(client(baseUrl).stream(request, new AbortController().signal));
    });
    expect(headers["user-agent"]).toBe("knowlify");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("sends the configured custom headers and a client user agent", async () => {
    let headers: IncomingHttpHeaders = {};
    await withServer((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, async (baseUrl) => {
      await collect(client(baseUrl, {
        headers: [
          { name: "X-Session-Id", value: "{{conversationId}}" },
          { name: "user-agent", value: "custom-agent" },
        ],
      }).stream(
        { ...request, sessionId: "conversation-42" },
        new AbortController().signal,
      ));
    });
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-session-id"]).toBe("conversation-42");
    expect(headers["user-agent"]).toBe("custom-agent");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("omits a conversation-scoped header when the session id is missing", async () => {
    let headers: IncomingHttpHeaders = {};
    await withServer((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, async (baseUrl) => {
      await collect(client(baseUrl, {
        headers: [
          { name: "x-session-id", value: "{{conversationId}}" },
          { name: "x-static", value: "kept" },
        ],
      }).stream(request, new AbortController().signal));
    });
    expect(headers["x-session-id"]).toBeUndefined();
    expect(headers["x-static"]).toBe("kept");
    expect(headers["user-agent"]).toBe("knowlify");
  });

  it("accepts a base URL and a full chat-completions URL without duplicating the suffix", async () => {
    const paths: string[] = [];
    await withServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    }, async (baseUrl) => {
      await collect(client(baseUrl).stream(request, new AbortController().signal));
      await collect(client(`${baseUrl}/`).stream(request, new AbortController().signal));
      await collect(client(`${baseUrl}/chat/completions`).stream(request, new AbortController().signal));
      await collect(client(`${baseUrl}/chat/completions/`).stream(request, new AbortController().signal));
    });
    expect(paths).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
  });

  it("maps 429 and 5xx to unavailable", async () => {
    for (const status of [429, 500, 503]) {
      await withServer((_req, res) => {
        res.writeHead(status);
        res.end("provider failure");
      }, async (baseUrl) => {
        await expect(collect(client(baseUrl).stream(request, new AbortController().signal)))
          .rejects.toMatchObject({ code: "unavailable" });
      });
    }
  });

  it("does not follow redirects", async () => {
    let targetHits = 0;
    await withServer((req, res) => {
      if (req.url === "/target") {
        targetHits += 1;
        res.writeHead(200);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(302, { location: "/target" });
      res.end();
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl).stream(request, new AbortController().signal)))
        .rejects.toMatchObject({ code: "unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(targetHits).toBe(0);
    });
  });

  it("times out when the first token never arrives", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl, { firstTokenTimeoutMs: 80, timeoutMs: 2_000 })
        .stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "timeout" });
    });
  });

  it("times out when the stream goes idle between chunks", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl, { idleTimeoutMs: 80, timeoutMs: 2_000 })
        .stream(request, new AbortController().signal))).rejects.toMatchObject({ code: "timeout" });
    });
  });

  it("rejects an oversized event line", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(70 * 1024) } }] })}\n\n`);
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl).stream(request, new AbortController().signal)))
        .rejects.toMatchObject({ code: "protocol" });
    });
  });

  it("enforces the total answer size", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"abcdef"}}]}\n\ndata: [DONE]\n\n');
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl, { maxResponseChars: 4 }).stream(request, new AbortController().signal)))
        .rejects.toMatchObject({ code: "protocol" });
    });
  });

  it("rejects malformed provider payloads", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: not-json\n\n");
    }, async (baseUrl) => {
      await expect(collect(client(baseUrl).stream(request, new AbortController().signal)))
        .rejects.toMatchObject({ code: "protocol" });
    });
  });

  it("aborts the upstream stream when the caller aborts", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    }, async (baseUrl) => {
      const controller = new AbortController();
      const iterator = client(baseUrl).stream(request, controller.signal)[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta", text: "first" } });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
    });
  });

  it("reports hostname only and builds the factory from the configuration", () => {
    const configured = createLlmClient({
      url: "http://192.168.0.10:11434/v1",
      apiKey: KEY,
      model: "local-model",
    });
    expect(configured.configured).toBe(true);
    expect(configured.model).toBe("local-model");
    expect(configured.host).toBe("192.168.0.10");
    expect(configured.host).not.toContain("11434");

    const disabled = createLlmClient({ url: null, apiKey: null, model: null });
    expect(disabled.configured).toBe(false);
    expect(disabled.model).toBeNull();
    expect(disabled.host).toBeNull();

    expect(createLlmClient({ url: "ftp://example.com/v1", apiKey: KEY, model: "m" }).configured).toBe(false);
    expect(createLlmClient({ url: "https://example.com/v1", apiKey: "", model: "m" }).configured).toBe(false);
  });
});
