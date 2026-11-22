import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { chatRoutes } from "../src/adapters/http/chat.js";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { OpenAiCompatibleLlmClient } from "../src/adapters/llm/OpenAiCompatibleLlmClient.js";
import { MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION } from "../src/domain/assistant/Conversation.js";
import { NO_PASSAGES_BLOCK } from "../src/domain/assistant/tutorPrompt.js";
import { LlmError } from "../src/ports/assistant.js";
import type { Chat } from "../src/use-cases/Chat.js";
import {
  BOOK,
  BlockingRetriever,
  FakeLlmClient,
  FakeRetriever,
  WaitingLlmClient,
  createChatFixture,
  passage,
  parseSseEvents,
} from "./chat-helpers.js";

const fixtures: ReturnType<typeof createChatFixture>[] = [];
const apps: FastifyInstance[] = [];
const providers: ReturnType<typeof createServer>[] = [];

function fixture(options: Parameters<typeof createChatFixture>[0] = {}) {
  const created = createChatFixture(options);
  fixtures.push(created);
  return created;
}

async function appFor(
  chat: Chat,
  configure?: (app: FastifyInstance) => void,
  heartbeatMs?: number,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cors, { origin: true });
  configure?.(app);
  await app.register(chatRoutes, { prefix: "/api", chat, ...(heartbeatMs === undefined ? {} : { heartbeatMs }) });
  await app.ready();
  apps.push(app);
  return app;
}

/** Signals when the route has finished with the chat iterator. */
function trackStreamCompletion(chat: Chat): Promise<void> {
  const original = chat.stream.bind(chat);
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  chat.stream = (input, signal) => {
    const source = original(input, signal);
    return {
      async *[Symbol.asyncIterator]() {
        try {
          yield* source;
        } finally {
          resolveFinished();
        }
      },
    };
  };
  return finished;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    /*
     * A hijacked SSE reply leaves the socket outside Fastify's lifecycle. Node 22 keeps
     * the idle connection open after a fetch is aborted mid-stream, and `server.close()`
     * (or even `closeIdleConnections()`) does not always reap it, so graceful close waits
     * forever. Tests own these sockets: drop them before closing the app.
     */
    app.server.closeAllConnections();
    await app.close();
  }
  for (const provider of providers.splice(0)) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  for (const created of fixtures.splice(0)) created.db.close();
});

function post(app: FastifyInstance, payload: object) {
  return app.inject({
    method: "POST",
    url: "/api/chat/messages",
    headers: { origin: "http://localhost:5174" },
    payload,
  });
}

describe("chat HTTP routes", () => {
  it("reports the frozen status shape", async () => {
    const { chat } = fixture({ llm: new NoLlmClient() });
    const app = await appFor(chat);
    const response = await app.inject({ method: "GET", url: "/api/chat/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      model: null,
      host: null,
      promptVersion: "feynman-3",
      scopes: { library: false, book: false },
    });
    expect(response.body).not.toMatch(/https?:\/\/|api[_-]?key|secret/i);
  });

  it("returns 503 chat_disabled without consuming a turn", async () => {
    const { chat, conversations } = fixture({ llm: new NoLlmClient() });
    const app = await appFor(chat);
    const response = await post(app, { message: "hi", scope: { kind: "library" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ message: "Chat is not configured", code: "chat_disabled" });
    expect(conversations.countAll()).toBe(0);
  });

  it("validates the body and the conversation id", async () => {
    const { chat } = fixture();
    const app = await appFor(chat);
    const invalid = [
      {},
      { message: "", scope: { kind: "library" } },
      { message: "x".repeat(2_001), scope: { kind: "library" } },
      { message: "q", scope: { kind: "library" }, extra: true },
      { message: "q", scope: { kind: "library", bookId: BOOK.id } },
      { message: "q", scope: { kind: "book" } },
      { message: "q", scope: { kind: "book", bookId: BOOK.id, excerptKind: "all" } },
      { message: "q", scope: { kind: "book", bookId: BOOK.id, section: "x".repeat(201) } },
      { message: "q", scope: { kind: "other" } },
    ];
    for (const payload of invalid) {
      const response = await post(app, payload);
      expect(response.statusCode).toBe(400);
      expect(typeof response.json().message).toBe("string");
    }
  });

  it("returns 400 for whitespace-only messages, including Unicode whitespace", async () => {
    const { chat, conversations } = fixture();
    const app = await appFor(chat);
    for (const message of ["   ", "\t\n", "\u00a0", "\u2003", "\u3000", "\ufeff"]) {
      const response = await post(app, { message, scope: { kind: "library" } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ message: "Message must not be empty" });
      expect(response.body).not.toMatch(/internal server error/i);
    }
    expect(conversations.countAll()).toBe(0);
  });

  it("returns 413 for bodies over the route limit", async () => {
    const { chat } = fixture();
    const app = await appFor(chat);
    const response = await post(app, { message: "x".repeat(40_000), scope: { kind: "library" } });
    expect(response.statusCode).toBe(413);
  });

  it("maps missing books and conversations to 404", async () => {
    const { chat } = fixture();
    const app = await appFor(chat);
    expect((await post(app, { message: "q", scope: { kind: "book", bookId: "missing" } })).statusCode).toBe(404);
    expect((await post(app, { conversationId: "missing", message: "q", scope: { kind: "library" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/chat/conversations/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/chat/conversations/missing" })).statusCode).toBe(404);
  });

  it("maps a disabled library and a scope change to 409", async () => {
    const disabled = fixture({ limits: { libraryScope: false } });
    const app = await appFor(disabled.chat);
    expect((await post(app, { message: "q", scope: { kind: "library" } })).statusCode).toBe(409);

    const enabled = fixture();
    const enabledApp = await appFor(enabled.chat);
    const first = await post(enabledApp, { message: "q", scope: { kind: "library" } });
    const conversationId = parseSseEvents(first.body)[0];
    expect(conversationId.type).toBe("sources");
    const mismatch = await post(enabledApp, {
      conversationId: (conversationId as { conversationId: string }).conversationId,
      message: "q",
      scope: { kind: "book", bookId: BOOK.id },
    });
    expect(mismatch.statusCode).toBe(409);
  });

  it("rejects a full conversation with 409 before the stream starts", async () => {
    const { chat, conversations } = fixture();
    conversations.create({ id: "full", scope: { kind: "library" }, title: "full", createdAt: 1, updatedAt: 1 });
    for (let turn = 0; turn < MAX_MESSAGES_PER_CONVERSATION / 2; turn += 1) {
      conversations.saveTurn({
        conversationId: "full",
        newConversation: null,
        user: { id: `u${turn}`, role: "user", content: "q", citations: null, promptVersion: null, createdAt: 1 },
        assistant: { id: `a${turn}`, role: "assistant", content: "a", citations: null, promptVersion: "feynman-1", createdAt: 1 },
      }, { maxConversations: MAX_CONVERSATIONS, maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION }, 1);
    }
    const app = await appFor(chat);

    const response = await post(app, { conversationId: "full", message: "q", scope: { kind: "library" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ message: "This conversation is full; start a new one", code: "conversation_full" });
  });

  it("rate limits with Retry-After", async () => {
    const { chat } = fixture({ limits: { ratePerMin: 1 } });
    const app = await appFor(chat);
    expect((await post(app, { message: "one", scope: { kind: "library" } })).statusCode).toBe(200);
    const response = await post(app, { message: "two", scope: { kind: "library" } });
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.json()).toMatchObject({ code: "rate_limited" });
  });

  it("streams the contract order with SSE headers and CORS on the hijacked reply", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat } = fixture({ llm, retriever });
    const app = await appFor(chat);

    const response = await post(app, { message: "What is deep work?", scope: { kind: "library" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["content-encoding"]).toBe("identity");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5174");

    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "done"]);
    expect(events[0]).toMatchObject({ type: "sources", retrieval: "hybrid" });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("keeps a hijacked stream alive with SSE comments while the provider is quiet", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new WaitingLlmClient();
    const { chat } = fixture({ llm, retriever });
    const app = await appFor(chat, undefined, 25);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const streamFinished = trackStreamCompletion(chat);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "grounded question", scope: { kind: "library" } }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected a stream");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes(": ping")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      if (chunk === "timeout") throw new Error("no heartbeat within 2 s");
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain(": ping");

    controller.abort();
    await llm.aborted;
    await streamFinished;
    await reader.cancel().catch(() => undefined);
  });

  it("emits a terminal error event when the provider fails mid-stream", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("timeout", "slow provider");
    const { chat, conversations } = fixture({ llm, retriever });
    const app = await appFor(chat);

    const response = await post(app, { message: "grounded question", scope: { kind: "library" } });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "llm_timeout",
      message: "The language model took too long to answer",
    });
    expect(response.body).not.toContain("slow provider");
    expect(conversations.countAll()).toBe(0);
  });

  it("adds the allowlisted provider diagnostic to the terminal error event", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("rejected", "The language model provider rejected the request (status 400)", {
      providerStatus: 400,
      providerDetail: "missing_session",
    });
    const { chat, conversations } = fixture({ llm, retriever });
    const app = await appFor(chat);

    const response = await post(app, { message: "grounded question", scope: { kind: "library" } });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "llm_rejected",
      message: "The language model rejected the request",
      detail: "missing_session",
    });
    expect(conversations.countAll()).toBe(0);
  });

  it("streams only the allowlisted diagnostic, never echoed prompt, passage, URL or secret", async () => {
    const providerKey = "super-secret-key";
    const promptSentinel = "PROMPT SENTINEL grounded question";
    const passageSentinel = "PASSAGE SENTINEL about deep work";
    const encodedKey = Buffer.from(providerKey).toString("base64");
    const errorBodies = [
      {
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            type: "MissingSessionID",
            message: `Request is missing session header for prompt ${promptSentinel} and passage ${passageSentinel}; key ${providerKey}; encoded ${encodedKey}; see https://provider.example/v1?token=${providerKey}`,
          },
        }),
      },
      {
        contentType: "text/plain",
        body: `Request is missing session header for prompt ${promptSentinel} and passage ${passageSentinel}; key ${providerKey}; encoded ${encodedKey}; see https://provider.example/v1?token=${providerKey}`,
      },
    ];

    for (const errorBody of errorBodies) {
      const warnings: string[] = [];
      const chatLogs: unknown[] = [];
      const provider = createServer((_req, res) => {
        res.writeHead(400, { "content-type": errorBody.contentType });
        res.end(errorBody.body);
      });
      providers.push(provider);
      await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const { port } = provider.address() as AddressInfo;
      const llm = new OpenAiCompatibleLlmClient({
        url: `http://127.0.0.1:${port}/v1`,
        apiKey: providerKey,
        model: "test-model",
        warn: (message) => warnings.push(message),
      });
      const retriever = new FakeRetriever();
      retriever.hits = [passage({ text: passageSentinel })];
      const { chat, conversations } = fixture({
        llm,
        retriever,
        log: { info: () => {}, error: (error) => chatLogs.push(error) },
      });
      const app = await appFor(chat);

      const response = await post(app, { message: promptSentinel, scope: { kind: "library" } });
      expect(response.statusCode).toBe(200);
      expect(parseSseEvents(response.body).at(-1)).toMatchObject({
        type: "error",
        code: "llm_rejected",
        message: "The language model rejected the request",
        detail: "missing_session",
      });
      expect(conversations.countAll()).toBe(0);

      for (const forbidden of [promptSentinel, passageSentinel, providerKey, encodedKey, "https://", "provider.example"]) {
        expect(response.body).not.toContain(forbidden);
        expect(warnings.join("\n")).not.toContain(forbidden);
        expect(JSON.stringify(chatLogs)).not.toContain(forbidden);
      }
      expect(warnings.join("\n")).toContain("status 400 (missing_session)");
      expect(JSON.stringify(chatLogs)).toContain("missing_session");
    }
  });

  it("keeps reasoning tokens out of the SSE stream and every log", async () => {
    const reasoningSentinel = "REASONING SENTINEL: hidden chain of thought";
    const provider = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoningSentinel } }] })}\n\n`);
      }, 20);
      setTimeout(() => {
        clearInterval(timer);
        res.end(
          'data: {"choices":[{"delta":{"content":"The answer"},"finish_reason":"stop"}]}\n\n'
          + "data: [DONE]\n\n",
        );
      }, 2_000);
    });
    providers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { port } = provider.address() as AddressInfo;
    const warnings: string[] = [];
    const logs: unknown[] = [];
    const llm = new OpenAiCompatibleLlmClient({
      url: `http://127.0.0.1:${port}/v1`,
      apiKey: "chat-key",
      model: "reasoning-model",
      firstTokenTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      timeoutMs: 6_000,
      warn: (message) => warnings.push(message),
    });
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat } = fixture({
      llm,
      retriever,
      log: { info: () => {}, error: (error, message) => logs.push(error, message) },
    });
    const app = await appFor(chat);

    const response = await post(app, { message: "grounded question", scope: { kind: "library" } });
    expect(response.statusCode).toBe(200);
    expect(parseSseEvents(response.body).map((event) => event.type)).toEqual(["sources", "delta", "done"]);
    expect(response.body).toContain("The answer");
    for (const output of [response.body, warnings.join("\n"), JSON.stringify(logs)]) {
      expect(output).not.toContain(reasoningSentinel);
    }
  });

  it("sends the configured custom header with the conversation id to the chat provider", async () => {
    const received: IncomingHttpHeaders[] = [];
    const headerSentinel = "chat-header-sentinel-value";
    const provider = createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    providers.push(provider);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const { port } = provider.address() as AddressInfo;
    const llm = new OpenAiCompatibleLlmClient({
      url: `http://127.0.0.1:${port}/v1`,
      apiKey: "chat-key",
      model: "test-model",
      headers: [
        { name: "X-Session-Id", value: "conversation={{conversationId}}" },
        { name: "X-Static", value: headerSentinel },
      ],
    });
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat } = fixture({ llm, retriever });
    const app = await appFor(chat);

    const response = await post(app, { message: "grounded question", scope: { kind: "library" } });
    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);
    const conversationId = (events[0] as { conversationId: string }).conversationId;
    expect(conversationId).toBeTruthy();
    expect(received[0]?.["x-session-id"]).toBe(`conversation=${conversationId}`);
    expect(received[0]?.["x-static"]).toBe(headerSentinel);
    expect(received[0]?.authorization).toBe("Bearer chat-key");
    expect(response.body).not.toContain(headerSentinel);
  });

  it("calls the provider when retrieval finds nothing", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat } = fixture({ llm, retriever });
    const app = await appFor(chat);

    const response = await post(app, { message: "An unanswerable question", scope: { kind: "library" } });
    const events = parseSseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "done"]);
    expect(events[1]).toEqual({ type: "delta", text: "Hello" });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages.at(-1)?.content).toContain(NO_PASSAGES_BLOCK);
    expect(llm.requests[0].messages.at(-1)?.content).toContain("Question: An unanswerable question");
  });

  it("lists, returns and deletes conversations", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, conversations } = fixture({ retriever });
    const app = await appFor(chat);

    const created = parseSseEvents((await post(app, { message: "What is deep work?", scope: { kind: "library" } })).body);
    const conversationId = (created[0] as { conversationId: string }).conversationId;

    const libraryList = await app.inject({ method: "GET", url: "/api/chat/conversations" });
    expect(libraryList.statusCode).toBe(200);
    expect(libraryList.json()).toEqual([
      { id: conversationId, title: "What is deep work?", scope: { kind: "library" }, updatedAt: expect.any(Number) },
    ]);
    expect((await app.inject({ method: "GET", url: `/api/chat/conversations?bookId=${BOOK.id}` })).json()).toEqual([]);

    const detail = await app.inject({ method: "GET", url: `/api/chat/conversations/${conversationId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: conversationId,
      title: "What is deep work?",
      scope: { kind: "library" },
      messages: [
        { role: "user", content: "What is deep work?" },
        { role: "assistant", content: "Hello there", citations: [{ n: 1 }] },
      ],
    });

    expect((await app.inject({ method: "DELETE", url: `/api/chat/conversations/${conversationId}` })).statusCode).toBe(204);
    expect(conversations.countAll()).toBe(0);
  });

  it("aborts the upstream when the client disconnects and persists nothing", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new WaitingLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });
    const app = await appFor(chat);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const streamFinished = trackStreamCompletion(chat);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "grounded question", scope: { kind: "library" } }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let received = "";
    while (!received.includes("partial")) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    expect(received).toContain("partial");

    controller.abort();
    await llm.aborted;
    // Wait for the route to unwind instead of guessing with a fixed sleep: the turn must
    // be abandoned before the teardown closes the app and the database.
    await streamFinished;
    expect(llm.signals[0].aborted).toBe(true);
    expect(conversations.countAll()).toBe(0);
    await reader?.cancel().catch(() => undefined);
  });

  it("never starts the provider when the client disconnects during retrieval", async () => {
    const retriever = new BlockingRetriever();
    const llm = new FakeLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { resolveSocketClosed = resolve; });
    const app = await appFor(chat, (instance) => {
      instance.addHook("onRequest", (request, _reply, done) => {
        request.raw.socket.once("close", resolveSocketClosed);
        done();
      });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const streamFinished = trackStreamCompletion(chat);
    const payload = JSON.stringify({ message: "grounded question", scope: { kind: "library" } });
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/api/chat/messages",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    });
    request.on("error", () => undefined);
    request.end(payload);

    await retriever.started;
    request.destroy();
    try {
      await socketClosed;
    } finally {
      retriever.release();
    }
    await retriever.finished;
    await streamFinished;

    expect(llm.requests).toEqual([]);
    expect(conversations.countAll()).toBe(0);
  });
});
