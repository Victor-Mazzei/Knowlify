import { afterEach, describe, expect, it } from "vitest";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION } from "../src/domain/assistant/Conversation.js";
import { ChatDisabledError, ChatRateLimitedError, ConversationFullError, ConversationScopeMismatchError, LibraryChatUnavailableError } from "../src/domain/assistant/errors.js";
import { composeSystemPrompt, promptVersionFor } from "../src/domain/assistant/tutorPrompt.js";
import { NotFoundError } from "../src/domain/errors.js";
import { LlmError } from "../src/ports/assistant.js";
import type { ChatEvent } from "../src/use-cases/Chat.js";
import {
  BOOK,
  FakeLlmClient,
  FakeRetriever,
  WaitingLlmClient,
  collect,
  createChatFixture,
  passage,
} from "./chat-helpers.js";

const CAPS = { maxConversations: MAX_CONVERSATIONS, maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION };
const fixtures: ReturnType<typeof createChatFixture>[] = [];

function fixture(options: Parameters<typeof createChatFixture>[0] = {}) {
  const created = createChatFixture(options);
  fixtures.push(created);
  return created;
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.db.close();
});

describe("Chat status", () => {
  it("stays silent without a provider", () => {
    const { chat } = fixture({ llm: new NoLlmClient(), limits: { libraryScope: true } });
    expect(chat.status()).toEqual({
      enabled: false,
      model: null,
      host: null,
      promptVersion: "feynman-2",
      scopes: { library: false, book: false },
    });
  });

  it("exposes the model host without the URL path or key and follows the index state", () => {
    const { chat } = fixture();
    expect(chat.status()).toEqual({
      enabled: true,
      model: "fake-model",
      host: "llm.example",
      promptVersion: "feynman-2",
      scopes: { library: true, book: true },
    });

    const withoutIndex = fixture({ limits: { libraryScope: false } });
    expect(withoutIndex.chat.status().scopes).toEqual({ library: false, book: true });
  });
});

describe("Chat turn", () => {
  it("emits sources, deltas and done, then persists the turn", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "What is deep work?", scope: { kind: "library" } }, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "done"]);

    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    expect(sources.retrieval).toBe("hybrid");
    expect(sources.citations).toEqual([
      { n: 1, passageId: 1, bookId: BOOK.id, bookTitle: BOOK.title, page: 12, section: "Chapter 1" },
    ]);
    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(done.title).toBe("What is deep work?");
    expect(done.finishReason).toBe("stop");

    const detail = chat.get(sources.conversationId);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0].content).toBe("What is deep work?");
    expect(detail?.messages[1]).toMatchObject({
      id: done.messageId,
      content: "Hello there",
      citations: sources.citations,
      promptVersion: "feynman-2",
    });
    expect(conversations.countAll()).toBe(1);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages[0]).toMatchObject({ role: "system" });
    expect(llm.requests[0].messages.at(-1)?.content).toContain("What is deep work?");
  });

  it("builds the same prompt regardless of the provider API style", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const firstLlm = new FakeLlmClient();
    const secondLlm = new FakeLlmClient();
    const first = fixture({ llm: firstLlm, retriever });
    const second = fixture({ llm: secondLlm, retriever });
    const question = { message: "What is deep work?", scope: { kind: "library" as const } };

    await collect(first.chat.stream(question, new AbortController().signal));
    await collect(second.chat.stream(question, new AbortController().signal));

    // The style is a client concern; Chat only passes LlmMessages and limits.
    expect(secondLlm.requests[0]?.messages).toEqual(firstLlm.requests[0]?.messages);
    expect(secondLlm.requests[0]?.maxTokens).toBe(firstLlm.requests[0]?.maxTokens);
    expect(secondLlm.requests[0]?.temperature).toBe(firstLlm.requests[0]?.temperature);
    expect(JSON.stringify(secondLlm.requests[0]?.messages)).toContain("What is deep work?");
  });

  it("applies a persona change on the next turn and stamps the effective version", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    let persona: string | null = null;
    const { chat } = fixture({ llm, retriever, systemPrompt: () => persona });

    const first = await collect(chat.stream({ message: "First question", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    expect(llm.requests[0].messages[0]).toEqual({ role: "system", content: composeSystemPrompt(null) });
    expect(chat.status().promptVersion).toBe("feynman-2");

    persona = "Answer as a pirate.";
    await collect(chat.stream({ conversationId, message: "Second question", scope: { kind: "library" } }, new AbortController().signal));
    const customVersion = promptVersionFor(persona);
    expect(customVersion).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(llm.requests[1].messages[0]).toEqual({ role: "system", content: composeSystemPrompt(persona) });
    expect(chat.status().promptVersion).toBe(customVersion);

    const messages = chat.get(conversationId)?.messages ?? [];
    expect(messages.map((message) => message.promptVersion)).toEqual([
      null,
      "feynman-2",
      null,
      customVersion,
    ]);
  });

  it("continues a conversation with the same scope and sends history to the provider", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat } = fixture({ llm, retriever });

    const first = await collect(chat.stream({ message: "What is deep work?", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;

    const second = await collect(chat.stream({
      conversationId,
      message: "And how do I practice it?",
      scope: { kind: "library" },
    }, new AbortController().signal));
    expect((second[0] as Extract<ChatEvent, { type: "sources" }>).conversationId).toBe(conversationId);
    expect(chat.get(conversationId)?.messages).toHaveLength(4);

    const history = llm.requests[1].messages;
    expect(history.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(history[1].content).toContain("What is deep work?");

    await expect(collect(chat.stream({
      conversationId,
      message: "other book",
      scope: { kind: "book", bookId: BOOK.id },
    }, new AbortController().signal))).rejects.toBeInstanceOf(ConversationScopeMismatchError);
  });

  it("uses the previous question as context for very short follow-ups", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat } = fixture({ retriever });
    const first = await collect(chat.stream({ message: "Explain the concept of deep work in this book", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;

    await collect(chat.stream({ conversationId, message: "why?", scope: { kind: "library" } }, new AbortController().signal));
    expect(retriever.queries.at(-1)?.q).toBe("Explain the concept of deep work in this book why?");
  });

  it("answers from the reader excerpt when the index is off", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat } = fixture({ llm, retriever, limits: { libraryScope: false } });

    const events = await collect(chat.stream({
      message: "Explain this excerpt",
      scope: { kind: "book", bookId: BOOK.id, excerpt: "Focus is the new IQ.", excerptKind: "selection", page: 4 },
    }, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "sources", retrieval: "none", citations: [] });
    expect(events.at(-1)?.type).toBe("done");
    expect(retriever.queries).toEqual([]);
    expect(llm.requests[0].messages.at(-1)?.content).toContain("Focus is the new IQ.");
  });

  it("skips the provider when no passage grounds a library question", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "A question with no passages", scope: { kind: "library" } }, new AbortController().signal));
    expect(events).toEqual([
      { type: "sources", conversationId: expect.any(String), retrieval: "none", citations: [] },
      { type: "delta", text: "I couldn't find passages about this in your library yet." },
      { type: "done", conversationId: expect.any(String), messageId: expect.any(String), title: "A question with no passages", finishReason: "stop" },
    ]);
    expect(llm.requests).toEqual([]);
    const conversationId = (events[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    expect(chat.get(conversationId)?.messages[1].promptVersion).toBeNull();
  });

  it("reports search failures after sources and persists nothing", async () => {
    const retriever = new FakeRetriever();
    retriever.error = new Error("index exploded");
    const llm = new FakeLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "grounded question", scope: { kind: "library" } }, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["sources", "error"]);
    expect(events[1]).toMatchObject({ code: "search_failed" });
    expect(conversations.countAll()).toBe(0);
    expect(llm.requests).toEqual([]);
  });

  it("reports provider failures after sources and persists nothing", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("unavailable", "provider down");
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "grounded question", scope: { kind: "library" } }, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "error"]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "llm_unavailable" });
    expect(events.at(-1)).not.toHaveProperty("detail");
    expect(conversations.countAll()).toBe(0);
  });

  it("forwards the allowlisted provider diagnostic and the conversation id as the session", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("rejected", "The language model provider rejected the request (status 400)", {
      providerStatus: 400,
      providerDetail: "missing_session",
    });
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "grounded question", scope: { kind: "library" } }, new AbortController().signal));
    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    expect(llm.requests[0]?.sessionId).toBe(sources.conversationId);
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "llm_rejected",
      message: "The language model rejected the request",
      detail: "missing_session",
    });
    expect(conversations.countAll()).toBe(0);
  });

  it("logs only allowlisted provider fields, never the prompt or passage", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage({ text: "PASSAGE SENTINEL about deep work" })];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("rejected", "The language model provider rejected the request (status 400)", {
      providerStatus: 400,
      providerDetail: "missing_session",
    });
    const logged: unknown[] = [];
    const { chat } = fixture({
      llm,
      retriever,
      log: { info: () => {}, error: (error) => logged.push(error) },
    });

    await collect(chat.stream(
      { message: "PROMPT SENTINEL grounded question", scope: { kind: "library" } },
      new AbortController().signal,
    ));

    expect(logged).toEqual([
      { llmErrorCode: "rejected", providerStatus: 400, providerDiagnostic: "missing_session" },
    ]);
    expect(JSON.stringify(logged)).not.toContain("PROMPT SENTINEL");
    expect(JSON.stringify(logged)).not.toContain("PASSAGE SENTINEL");
  });

  it("does not persist a turn when the caller aborts mid-stream", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new WaitingLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });
    const controller = new AbortController();
    const iterator = chat.stream({ message: "grounded question", scope: { kind: "library" } }, controller.signal)[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({ value: { type: "sources" } });
    expect(await iterator.next()).toMatchObject({ value: { type: "delta", text: "partial" } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });
    await iterator.return?.(undefined);
    expect(conversations.countAll()).toBe(0);
    expect(llm.signals[0].aborted).toBe(true);
  });

  it("rejects an unknown book, an unknown conversation, a disabled library and a full conversation", async () => {
    const { chat, conversations } = fixture();
    await expect(collect(chat.stream({ message: "q", scope: { kind: "book", bookId: "missing" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(NotFoundError);
    await expect(collect(chat.stream({ conversationId: "missing", message: "q", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(NotFoundError);

    const withoutIndex = fixture({ limits: { libraryScope: false } });
    await expect(collect(withoutIndex.chat.stream({ message: "q", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(LibraryChatUnavailableError);

    conversations.create({ id: "full", scope: { kind: "library" }, title: "full", createdAt: 1, updatedAt: 1 });
    for (let turn = 0; turn < 50; turn += 1) {
      conversations.saveTurn({
        conversationId: "full",
        newConversation: null,
        user: { id: `u${turn}`, role: "user", content: "q", citations: null, promptVersion: null, createdAt: 1 },
        assistant: { id: `a${turn}`, role: "assistant", content: "a", citations: null, promptVersion: "feynman-1", createdAt: 1 },
      }, CAPS, 1);
    }
    await expect(collect(chat.stream({ conversationId: "full", message: "q", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(ConversationFullError);
  });

  it("caps the number of conversations, dropping the oldest", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, conversations } = fixture({ retriever });
    for (let index = 0; index < 200; index += 1) {
      conversations.create({ id: `old-${index}`, scope: { kind: "library" }, title: "old", createdAt: index, updatedAt: index });
    }
    await collect(chat.stream({ message: "new conversation", scope: { kind: "library" } }, new AbortController().signal));
    expect(conversations.countAll()).toBe(200);
    expect(conversations.get("old-0")).toBeUndefined();
    expect(conversations.get("old-1")).toBeDefined();
  });

  it("serializes concurrent turns so only one passes the message cap", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, conversations } = fixture({ retriever });
    conversations.create({ id: "almost-full", scope: { kind: "library" }, title: "almost-full", createdAt: 1, updatedAt: 1 });
    for (let turn = 0; turn < 49; turn += 1) {
      conversations.saveTurn({
        conversationId: "almost-full",
        newConversation: null,
        user: { id: `u${turn}`, role: "user", content: "q", citations: null, promptVersion: null, createdAt: 1 },
        assistant: { id: `a${turn}`, role: "assistant", content: "a", citations: null, promptVersion: "feynman-1", createdAt: 1 },
      }, CAPS, 1);
    }
    expect(conversations.messages("almost-full")).toHaveLength(98);

    const results = await Promise.allSettled([
      collect(chat.stream({ conversationId: "almost-full", message: "first", scope: { kind: "library" } }, new AbortController().signal)),
      collect(chat.stream({ conversationId: "almost-full", message: "second", scope: { kind: "library" } }, new AbortController().signal)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(ConversationFullError);
    expect(conversations.messages("almost-full")).toHaveLength(100);
  });

  it("lets a queued turn give up when its client aborts", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new WaitingLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });
    conversations.create({ id: "busy", scope: { kind: "library" }, title: "busy", createdAt: 1, updatedAt: 1 });

    const firstController = new AbortController();
    const first = chat.stream({ conversationId: "busy", message: "first", scope: { kind: "library" } }, firstController.signal)[Symbol.asyncIterator]();
    expect(await first.next()).toMatchObject({ value: { type: "sources" } });
    expect(await first.next()).toMatchObject({ value: { type: "delta", text: "partial" } });

    const secondController = new AbortController();
    const second = chat.stream({ conversationId: "busy", message: "second", scope: { kind: "library" } }, secondController.signal)[Symbol.asyncIterator]();
    const queued = second.next();
    secondController.abort();
    await expect(queued).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });

    firstController.abort();
    await expect(first.next()).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });
    await first.return?.(undefined);
    await second.return?.(undefined);

    expect(conversations.messages("busy")).toHaveLength(0);
  });

  it("keeps a third waiter behind the current turn after a queued turn aborts", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new WaitingLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });
    conversations.create({ id: "busy", scope: { kind: "library" }, title: "busy", createdAt: 1, updatedAt: 1 });

    const firstController = new AbortController();
    const first = chat.stream({ conversationId: "busy", message: "first", scope: { kind: "library" } }, firstController.signal)[Symbol.asyncIterator]();
    expect(await first.next()).toMatchObject({ value: { type: "sources" } });
    expect(await first.next()).toMatchObject({ value: { type: "delta", text: "partial" } });

    const secondController = new AbortController();
    const second = chat.stream({ conversationId: "busy", message: "second", scope: { kind: "library" } }, secondController.signal)[Symbol.asyncIterator]();
    const queued = second.next();
    secondController.abort();
    await expect(queued).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });

    const thirdController = new AbortController();
    const third = chat.stream({ conversationId: "busy", message: "third", scope: { kind: "library" } }, thirdController.signal)[Symbol.asyncIterator]();
    const thirdNext = third.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retriever.queries).toHaveLength(1);

    firstController.abort();
    await expect(first.next()).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });
    // The holder releases only when its iterator is closed after the terminal event.
    await first.return?.(undefined);
    await expect(thirdNext).resolves.toMatchObject({ value: { type: "sources" } });

    expect(await third.next()).toMatchObject({ value: { type: "delta", text: "partial" } });
    thirdController.abort();
    await expect(third.next()).resolves.toMatchObject({ value: { type: "error", code: "aborted" } });
    await third.return?.(undefined);
    await second.return?.(undefined);

    expect(conversations.messages("busy")).toHaveLength(0);
  });

  it("rate limits messages per minute and concurrent streams", async () => {
    const limited = fixture({ limits: { ratePerMin: 2 } });
    await collect(limited.chat.stream({ message: "one", scope: { kind: "library" } }, new AbortController().signal));
    await collect(limited.chat.stream({ message: "two", scope: { kind: "library" } }, new AbortController().signal));
    const rateError = await collect(limited.chat.stream({ message: "three", scope: { kind: "library" } }, new AbortController().signal))
      .catch((error: unknown) => error);
    expect(rateError).toBeInstanceOf(ChatRateLimitedError);
    expect((rateError as ChatRateLimitedError).retryAfterSec).toBeGreaterThan(0);

    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const waiting = new WaitingLlmClient();
    const busy = fixture({ llm: waiting, retriever, limits: { ratePerMin: 100 } });
    const first = busy.chat.stream({ message: "first", scope: { kind: "library" } }, new AbortController().signal)[Symbol.asyncIterator]();
    const second = busy.chat.stream({ message: "second", scope: { kind: "library" } }, new AbortController().signal)[Symbol.asyncIterator]();
    await first.next();
    await first.next();
    await second.next();
    await second.next();
    const third = busy.chat.stream({ message: "third", scope: { kind: "library" } }, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(third.next()).rejects.toBeInstanceOf(ChatRateLimitedError);
    await first.return?.(undefined);
    await second.return?.(undefined);
  });

  it("rejects turns before any stream when chat is disabled", async () => {
    const { chat } = fixture({ llm: new NoLlmClient() });
    await expect(collect(chat.stream({ message: "q", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(ChatDisabledError);
  });
});
