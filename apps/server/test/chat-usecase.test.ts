import { afterEach, describe, expect, it } from "vitest";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION } from "../src/domain/assistant/Conversation.js";
import { ChatDisabledError, ChatRateLimitedError, ConversationFullError, ConversationLimitError, ConversationScopeMismatchError, InvalidModeError, LibraryChatUnavailableError } from "../src/domain/assistant/errors.js";
import { composeSystemPrompt, promptVersionFor } from "../src/domain/assistant/tutorPrompt.js";
import { NO_PASSAGES_ANSWER } from "../src/domain/assistant/sessionContext.js";
import { NO_PASSAGES_BLOCK } from "../src/domain/assistant/tutorPrompt.js";
import { LIBRARY_NOT_USED_BLOCK, REPLY_TO_CHECK_QUESTION_BLOCK, SEARCH_PARTIAL_BLOCK, SEARCH_TIMED_OUT_BLOCK } from "../src/domain/assistant/tutorPrompt.js";
import { NotFoundError } from "../src/domain/errors.js";
import { LlmError } from "../src/ports/assistant.js";
import type { LlmClient, LlmEvent, LlmRequest, PassageRetriever } from "../src/ports/assistant.js";
import type { Logger } from "../src/ports/index.js";
import type { ChatEvent } from "../src/use-cases/Chat.js";
import {
  BOOK,
  BlockingRetriever,
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
    const { chat, sessions } = fixture({ llm: new NoLlmClient(), limits: { libraryScope: true } });
    expect(chat.status()).toEqual({
      enabled: false,
      model: null,
      host: null,
      promptVersion: "feynman-5",
      scopes: { library: false, book: false },
      modes: ["ask", "session"],
      features: { recommendations: true },
      sessionLimits: { maxSessions: 200, count: 0, maxMessages: 100 },
    });
  });

  it("exposes the model host without the URL path or key and follows the index state", () => {
    const { chat, sessions } = fixture();
    expect(chat.status()).toEqual({
      enabled: true,
      model: "fake-model",
      host: "llm.example",
      promptVersion: "feynman-5",
      scopes: { library: true, book: true },
      modes: ["ask", "session"],
      features: { recommendations: true },
      sessionLimits: { maxSessions: 200, count: 0, maxMessages: 100 },
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
    const { chat, sessions, conversations } = fixture({ llm, retriever });

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

    const detail = sessions.get(sources.conversationId);
    expect(detail?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(detail?.messages[0].content).toBe("What is deep work?");
    expect(detail?.messages[1]).toMatchObject({
      id: done.messageId,
      content: "Hello there",
      citations: sources.citations,
      promptVersion: "feynman-5",
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
    const { chat, sessions } = fixture({ llm, retriever, systemPrompt: () => persona });

    const first = await collect(chat.stream({ message: "First question", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    expect(llm.requests[0].messages[0]).toEqual({ role: "system", content: composeSystemPrompt(null) });
    expect(chat.status().promptVersion).toBe("feynman-5");

    persona = "Answer as a pirate.";
    await collect(chat.stream({ conversationId, message: "Second question", scope: { kind: "library" } }, new AbortController().signal));
    const customVersion = promptVersionFor(persona);
    expect(customVersion).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(llm.requests[1].messages[0]).toEqual({ role: "system", content: composeSystemPrompt(persona) });
    expect(chat.status().promptVersion).toBe(customVersion);

    const messages = sessions.get(conversationId)?.messages ?? [];
    expect(messages.map((message) => message.promptVersion)).toEqual([
      null,
      "feynman-5",
      null,
      customVersion,
    ]);
  });

  it("continues a conversation with the same scope and sends history to the provider", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, sessions } = fixture({ llm, retriever });

    const first = await collect(chat.stream({ message: "What is deep work?", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;

    const second = await collect(chat.stream({
      conversationId,
      message: "And how do I practice it?",
      scope: { kind: "library" },
    }, new AbortController().signal));
    expect((second[0] as Extract<ChatEvent, { type: "sources" }>).conversationId).toBe(conversationId);
    expect(sessions.get(conversationId)?.messages).toHaveLength(4);

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
    const { chat, sessions } = fixture({ retriever });
    const first = await collect(chat.stream({ message: "Explain the concept of deep work in this book", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;

    await collect(chat.stream({ conversationId, message: "why?", scope: { kind: "library" } }, new AbortController().signal));
    expect(retriever.queries.at(-1)?.q).toBe("Explain the concept of deep work in this book why?");
  });

  it("answers from the reader excerpt when the index is off", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat, sessions } = fixture({ llm, retriever, limits: { libraryScope: false } });

    const events = await collect(chat.stream({
      message: "Explain this excerpt",
      scope: { kind: "book", bookId: BOOK.id, excerpt: "Focus is the new IQ.", excerptKind: "selection", page: 4 },
    }, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "sources", retrieval: "none", citations: [] });
    expect(events.at(-1)?.type).toBe("done");
    expect(retriever.queries).toEqual([]);
    expect(llm.requests[0].messages.at(-1)?.content).toContain("Focus is the new IQ.");
  });

  it("answers a short reply to the tutor from the conversation even without passages", async () => {
    class TutorQuestionLlm implements LlmClient {
      readonly configured = true;
      readonly model = "fake-model";
      readonly host = "llm.example";
      readonly requests: LlmRequest[] = [];
      async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
        this.requests.push(request);
        const answer = this.requests.length === 1
          ? "Which part of deep work would you like to practice first?"
          : "Start with one focused block.";
        yield { type: "delta", text: answer };
        yield { type: "done", finishReason: "stop" };
      }
    }
    const llm = new TutorQuestionLlm();
    const retriever = new FakeRetriever();
    const { chat, sessions } = fixture({ llm, retriever });

    const first = await collect(chat.stream({ message: "Explain deep work", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages.at(-1)?.content).toContain(NO_PASSAGES_BLOCK);

    const second = await collect(chat.stream({
      conversationId,
      message: "The focus part.",
      scope: { kind: "library" },
    }, new AbortController().signal));
    expect(second.map((event) => event.type)).toEqual(["sources", "delta", "done"]);
    expect(llm.requests).toHaveLength(2);

    const prompt = llm.requests[1].messages;
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(prompt[2]?.content).toBe("Which part of deep work would you like to practice first?");
    expect(prompt.at(-1)?.content).toContain(NO_PASSAGES_BLOCK);
    expect(prompt.at(-1)?.content).toContain("Question: The focus part.");
    const followUpQueries = retriever.queries.slice(-2).map((query) => query.q);
    expect(followUpQueries[0]).toContain("Which part of deep work would you like to practice first?");
    expect(followUpQueries[0]).toContain("The focus part.");
    expect(followUpQueries[1]).toBe("The focus part.");

    const assistant = sessions.get(conversationId)?.messages.at(-1);
    expect(assistant?.content).toBe("Start with one focused block.");
    expect(assistant?.content).not.toBe(NO_PASSAGES_ANSWER);
    expect(assistant?.promptVersion).toBe("feynman-5");
  });

  it("stamps a reply-as-feedback turn with feynman-5 and never logs the question", async () => {
    class TutorQuestionLlm implements LlmClient {
      readonly configured = true;
      readonly model = "fake-model";
      readonly host = "llm.example";
      readonly requests: LlmRequest[] = [];
      async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
        this.requests.push(request);
        yield {
          type: "delta",
          text: this.requests.length === 1
            ? "What makes a declaration inside extern \"C\" different?"
            : "No problem — let's go step by step.",
        };
        yield { type: "done", finishReason: "stop" };
      }
    }
    const llm = new TutorQuestionLlm();
    const retriever = new FakeRetriever();
    const logs: string[] = [];
    const log: Logger = {
      info: (message) => logs.push(message),
      error: (_error, message) => logs.push(message),
      warn: (message) => logs.push(message),
    };
    const { chat, sessions } = fixture({ llm, retriever, log });
    const sentinel = "zebraquantum-nao-sei";

    const first = await collect(chat.stream({ message: "Explique extern C em C++", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    const second = await collect(chat.stream({
      conversationId,
      message: `nao sei ${sentinel}`,
      scope: { kind: "library" },
    }, new AbortController().signal));

    expect(second.at(-1)?.type).toBe("done");
    expect(llm.requests).toHaveLength(2);
    const prompt = llm.requests[1].messages;
    expect(prompt[0]?.content).toContain("Turn rule");
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(prompt[2]?.content).toBe("What makes a declaration inside extern \"C\" different?");
    expect(prompt[0]?.content).toContain("Check questions are optional");
    expect(prompt.at(-1)?.content).toContain(REPLY_TO_CHECK_QUESTION_BLOCK);
    expect(prompt.at(-1)?.content).toContain(`Question: nao sei ${sentinel}`);
    expect(sessions.get(conversationId)?.messages.at(-1)?.promptVersion).toBe("feynman-5");
    expect(logs.join("\n")).not.toContain(sentinel);
  });

  it("marks a timed-out search in the prompt and still streams the provider answer", async () => {
    const llm = new FakeLlmClient();
    llm.chunks = ["The library search was slow. ", "A general-knowledge answer."];
    const retriever = new FakeRetriever();
    retriever.unavailable = true;
    const logs: string[] = [];
    const log: Logger = {
      info: (message) => logs.push(message),
      error: (_error, message) => logs.push(message),
      warn: (message) => logs.push(message),
    };
    const { chat, sessions } = fixture({ llm, retriever, log });
    const sentinel = "zebraquantum-question";

    const events = await collect(chat.stream({
      message: `What is ${sentinel}?`,
      scope: { kind: "library" },
    }, new AbortController().signal));

    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "done"]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain(SEARCH_TIMED_OUT_BLOCK);
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
    expect(prompt).toContain(`Question: What is ${sentinel}?`);

    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    expect(sources).toMatchObject({ type: "sources", retrieval: "none", citations: [] });
    expect(Object.keys(sources)).toEqual(["type", "conversationId", "retrieval", "citations", "mode", "persisted"]);
    const assistant = sessions.get(sources.conversationId)?.messages.at(-1);
    expect(assistant?.content).toBe("The library search was slow. A general-knowledge answer.");
    expect(logs.join("\n")).not.toContain(sentinel);
  });

  it("distinguishes a book-only turn where the library was not used", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat, sessions } = fixture({ llm, retriever, limits: { libraryScope: false } });

    const events = await collect(chat.stream({
      message: "Explain this book",
      scope: { kind: "book", bookId: BOOK.id },
    }, new AbortController().signal));

    expect(events.at(-1)?.type).toBe("done");
    expect(retriever.queries).toEqual([]);
    expect(llm.requests[0].messages.at(-1)?.content).toContain(LIBRARY_NOT_USED_BLOCK);
    expect(llm.requests[0].messages.at(-1)?.content).not.toContain(NO_PASSAGES_BLOCK);
  });

  it("keeps the not-used marker when a book-only turn carries a reader excerpt", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat, sessions } = fixture({ llm, retriever, limits: { libraryScope: false } });

    await collect(chat.stream({
      message: "Explain this passage",
      scope: { kind: "book", bookId: BOOK.id, excerpt: "A highlighted sentence." },
    }, new AbortController().signal));

    expect(retriever.queries).toEqual([]);
    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain(LIBRARY_NOT_USED_BLOCK);
    expect(prompt).toContain("A highlighted sentence.");
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
    expect(prompt).not.toContain(SEARCH_TIMED_OUT_BLOCK);
  });

  it("answers 'nao sei' after its own question on a clean no-match without a library mention", async () => {
    class TutorQuestionLlm implements LlmClient {
      readonly configured = true;
      readonly model = "fake-model";
      readonly host = "llm.example";
      readonly requests: LlmRequest[] = [];
      async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
        this.requests.push(request);
        yield {
          type: "delta",
          text: this.requests.length === 1
            ? "What does `extern \"C\"` change about linkage?"
            : "No problem. Linkage controls how names are matched.",
        };
        yield { type: "done", finishReason: "stop" };
      }
    }
    const llm = new TutorQuestionLlm();
    const retriever = new FakeRetriever();
    const { chat, sessions } = fixture({ llm, retriever });

    const first = await collect(chat.stream({
      message: "Explique `extern \"C\"` em C++.",
      scope: { kind: "library" },
    }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    const second = await collect(chat.stream({
      conversationId,
      message: "nao sei",
      scope: { kind: "library" },
    }, new AbortController().signal));

    expect(second.at(-1)?.type).toBe("done");
    expect(llm.requests).toHaveLength(2);
    const messages = llm.requests[1].messages;
    const user = messages.at(-1)?.content ?? "";
    expect(user).toContain(NO_PASSAGES_BLOCK);
    expect(user).not.toContain(SEARCH_TIMED_OUT_BLOCK);
    expect(user).not.toContain(LIBRARY_NOT_USED_BLOCK);
    expect(messages.some((message) => message.role === "assistant" && message.content.includes("extern \"C\""))).toBe(true);
    const system = messages[0]?.content ?? "";
    expect(system).toContain("missing passages are not a reason to refuse");
    expect(system).toContain("a conversational reply or Feynman feedback (rules 1b and 1c) needs no library mention");
    expect(system).not.toContain("say that you could not find it in the library (rule 1) and mark any general-knowledge answer as such");
  });

  it("keeps a lexical result after the embedding fallback without a timeout note", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    retriever.mode = "lexical";
    retriever.hits = [passage({ text: "A lexical passage survives." })];
    const { chat, sessions } = fixture({ llm, retriever });

    await collect(chat.stream({ message: "Find this in my library", scope: { kind: "library" } }, new AbortController().signal));

    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain("A lexical passage survives.");
    expect(prompt).not.toContain(SEARCH_TIMED_OUT_BLOCK);
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
  });

  it("keeps grounding and the partial timeout warning together", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    retriever.unavailable = true;
    retriever.hits = [passage({ text: "Grounding survives a partial timeout." })];
    const { chat, sessions } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "Find grounding", scope: { kind: "library" } }, new AbortController().signal));

    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain(SEARCH_PARTIAL_BLOCK);
    expect(prompt).not.toContain(SEARCH_TIMED_OUT_BLOCK);
    expect(prompt).toContain("Grounding survives a partial timeout.");
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    expect(sources.citations).toHaveLength(1);
  });

  it("uses grounding from a later query instead of a partial timeout from an earlier one", async () => {
    class FollowUpLlm implements LlmClient {
      readonly configured = true;
      readonly model = "fake-model";
      readonly host = "llm.example";
      readonly requests: LlmRequest[] = [];
      async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
        this.requests.push(request);
        yield {
          type: "delta",
          text: this.requests.length === 1
            ? "Which part of deep work should we study?"
            : "Use the grounded passage.",
        };
        yield { type: "done", finishReason: "stop" };
      }
    }
    class TwoAttemptRetriever implements PassageRetriever {
      calls = 0;
      async search(): Promise<{ mode: string; hits: ReturnType<typeof passage>[]; unavailable?: boolean }> {
        this.calls += 1;
        if (this.calls === 1) return { mode: "hybrid", hits: [passage()] };
        if (this.calls === 2) return { mode: "lexical", hits: [], unavailable: true };
        return { mode: "lexical", hits: [passage({ text: "second attempt grounding" })] };
      }
    }
    const llm = new FollowUpLlm();
    const retriever = new TwoAttemptRetriever();
    const { chat, sessions } = fixture({ llm, retriever });

    const first = await collect(chat.stream({ message: "Explain deep work", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId;
    const second = await collect(chat.stream({
      conversationId,
      message: "The focus part.",
      scope: { kind: "library" },
    }, new AbortController().signal));

    expect(second.map((event) => event.type)).toEqual(["sources", "delta", "done"]);
    expect(retriever.calls).toBeGreaterThanOrEqual(3);
    const prompt = llm.requests[1].messages.at(-1)?.content ?? "";
    expect(prompt).toContain(SEARCH_PARTIAL_BLOCK);
    expect(prompt).not.toContain(SEARCH_TIMED_OUT_BLOCK);
    expect(prompt).toContain("second attempt grounding");
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
    expect((second[0] as Extract<ChatEvent, { type: "sources" }>).citations).toHaveLength(1);
  });

  it("sends a single-character question to the retriever with the internal short-query option", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    retriever.hits = [passage({ text: "The R language for statistics." })];
    const { chat, sessions } = fixture({ llm, retriever });

    await collect(chat.stream({ message: "R", scope: { kind: "library" } }, new AbortController().signal));

    expect(retriever.queries[0]).toMatchObject({ q: "R", allowShortQuery: true });
    expect(llm.requests).toHaveLength(1);
    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain("The R language for statistics.");
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
  });

  it("still calls the provider when retrieval returns irrelevant passages", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    retriever.hits = [passage({ text: "A recipe for bread." })];
    const { chat, sessions } = fixture({ llm, retriever });

    const events = await collect(chat.stream({ message: "What is deep work?", scope: { kind: "library" } }, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["sources", "delta", "delta", "done"]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].messages.at(-1)?.content).toContain("A recipe for bread.");
    expect(llm.requests[0].messages.at(-1)?.content).not.toContain(NO_PASSAGES_BLOCK);
    expect(sessions.get((events[0] as Extract<ChatEvent, { type: "sources" }>).conversationId)?.messages.at(-1)?.content)
      .toBe("Hello there");
  });

  it("answers an Ask turn without a conversation row and without history", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, sessions, conversations } = fixture({ llm, retriever });

    const first = await collect(chat.stream({ message: "First saved question", scope: { kind: "library" } }, new AbortController().signal));
    const conversationId = (first[0] as Extract<ChatEvent, { type: "sources" }>).conversationId as string;
    expect(conversations.countAll()).toBe(1);

    const events = await collect(chat.stream({
      message: "Quick ephemeral question",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));

    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(sources).toMatchObject({
      type: "sources",
      conversationId: null,
      mode: "ask",
      persisted: false,
      useLibrary: true,
    });
    expect(done).toMatchObject({
      type: "done",
      conversationId: null,
      mode: "ask",
      persisted: false,
      useLibrary: true,
      title: "",
    });
    expect(conversations.countAll()).toBe(1);
    expect(sessions.get(conversationId)?.messages).toHaveLength(2);

    const askPrompt = llm.requests[1].messages;
    expect(askPrompt.map((message) => message.role)).toEqual(["system", "user"]);
    expect(askPrompt[0]?.content).toContain("When there is no earlier conversation");
    expect(askPrompt.at(-1)?.content).not.toContain(REPLY_TO_CHECK_QUESTION_BLOCK);
    expect(askPrompt.at(-1)?.content).toContain("Question: Quick ephemeral question");
  });

  it("Ask without the library never calls the retriever and keeps the reader excerpt", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({
      message: "What does this mean?",
      scope: {
        kind: "book",
        bookId: BOOK.id,
        excerpt: "Attached reader text.",
        excerptKind: "selection",
      },
      mode: "ask",
      useLibrary: false,
    }, new AbortController().signal));

    expect(retriever.queries).toEqual([]);
    expect(conversations.countAll()).toBe(0);
    const sources = events[0] as Extract<ChatEvent, { type: "sources" }>;
    expect(sources).toMatchObject({ retrieval: "none", citations: [], useLibrary: false, persisted: false });
    const prompt = llm.requests[0].messages.at(-1)?.content ?? "";
    expect(prompt).toContain(LIBRARY_NOT_USED_BLOCK);
    expect(prompt).toContain("<excerpt");
    expect(prompt).toContain("Attached reader text.");
    expect(prompt).not.toContain("<passage");
    expect(prompt).not.toContain(NO_PASSAGES_BLOCK);
  });

  it("Ask without the library works in library scope even when the index is off", async () => {
    const retriever = new FakeRetriever();
    const llm = new FakeLlmClient();
    const { chat, conversations } = fixture({ llm, retriever, limits: { libraryScope: false } });

    const events = await collect(chat.stream({
      message: "General question",
      scope: { kind: "library" },
      mode: "ask",
      useLibrary: false,
    }, new AbortController().signal));

    expect(events.at(-1)).toMatchObject({ type: "done", persisted: false, useLibrary: false });
    expect(retriever.queries).toEqual([]);
    expect(conversations.countAll()).toBe(0);
    expect(llm.requests[0].messages.at(-1)?.content).toContain(LIBRARY_NOT_USED_BLOCK);

    await expect(collect(chat.stream({
      message: "Library question",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal))).rejects.toBeInstanceOf(LibraryChatUnavailableError);
  });

  it("rejects invalid mode combinations", async () => {
    const { chat } = fixture();
    await expect(collect(chat.stream({
      conversationId: "some-conversation",
      message: "q",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal))).rejects.toBeInstanceOf(InvalidModeError);

    for (const mode of [undefined, "session"] as const) {
      await expect(collect(chat.stream({
        message: "q",
        scope: { kind: "library" },
        ...(mode === undefined ? {} : { mode }),
        useLibrary: false,
      }, new AbortController().signal))).rejects.toBeInstanceOf(InvalidModeError);
    }
  });

  it("leaves no row when an Ask turn fails", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    llm.error = new LlmError("timeout", "slow provider");
    const { chat, conversations } = fixture({ llm, retriever });

    const events = await collect(chat.stream({
      message: "Failing question",
      scope: { kind: "library" },
      mode: "ask",
    }, new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "llm_timeout" });
    expect(conversations.countAll()).toBe(0);
  });

  it("sends history with citation markers and no legacy canned pairs", async () => {
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    const { chat, sessions, conversations } = fixture({ llm, retriever });
    conversations.create({ id: "clean", scope: { kind: "library" }, title: "Clean", createdAt: 1, updatedAt: 1 });
    const saveTurn = (question: string, answer: string) => conversations.saveTurn({
      conversationId: "clean",
      newConversation: null,
      user: { id: `u-${question}`, role: "user", content: question, citations: null, promptVersion: null, createdAt: 1 },
      assistant: { id: `a-${question}`, role: "assistant", content: answer, citations: null, promptVersion: "feynman-2", createdAt: 1 },
    }, CAPS, 1);
    saveTurn("What is deep work?", "Deep work is focus [1].");
    saveTurn("Tell me what the tutor said.", NO_PASSAGES_ANSWER);
    saveTurn("Explain deliberate practice", "Which aspect of deliberate practice [2] interests you?");

    await collect(chat.stream({ conversationId: "clean", message: "How do I start?", scope: { kind: "library" } }, new AbortController().signal));

    const history = llm.requests[0].messages.slice(1, -1);
    expect(history).toEqual([
      { role: "user", content: "What is deep work?" },
      // Earlier `[n]` markers are legitimate text: the prompt keeps them instead of
      // rewriting the stored turn. Only the legacy canned pair is dropped.
      { role: "assistant", content: "Deep work is focus [1]." },
      { role: "user", content: "Explain deliberate practice" },
      { role: "assistant", content: "Which aspect of deliberate practice [2] interests you?" },
    ]);
    expect(JSON.stringify(history)).not.toContain(NO_PASSAGES_ANSWER);
    expect(JSON.stringify(history)).toContain("[1]");
    expect(JSON.stringify(history)).toContain("[2]");
  });

  it("reports search failures after sources and persists nothing", async () => {
    const retriever = new FakeRetriever();
    retriever.error = new Error("index exploded");
    const llm = new FakeLlmClient();
    const { chat, sessions, conversations } = fixture({ llm, retriever });

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
    const { chat, sessions, conversations } = fixture({ llm, retriever });

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
    const { chat, sessions, conversations } = fixture({ llm, retriever });

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
    const { chat, sessions } = fixture({
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
    const { chat, sessions, conversations } = fixture({ llm, retriever });
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
    const { chat, sessions, conversations } = fixture();
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

  it("blocks a new conversation at the cap instead of dropping the oldest", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const llm = new FakeLlmClient();
    const { chat, sessions, conversations } = fixture({ llm, retriever });
    for (let index = 0; index < 200; index += 1) {
      conversations.create({ id: `old-${index}`, scope: { kind: "library" }, title: "old", createdAt: index, updatedAt: index });
    }
    await expect(collect(chat.stream({ message: "new conversation", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(ConversationLimitError);
    expect(conversations.countAll()).toBe(200);
    expect(conversations.get("old-0")).toBeDefined();
    expect(retriever.queries).toEqual([]);
    expect(llm.requests).toEqual([]);
  });

  it("serializes concurrent turns so only one passes the message cap", async () => {
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, sessions, conversations } = fixture({ retriever });
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
    const { chat, sessions, conversations } = fixture({ llm, retriever });
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
    const { chat, sessions, conversations } = fixture({ llm, retriever });
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

  it("releases a cancelled turn while retrieval is still running", async () => {
    const retriever = new BlockingRetriever();
    const llm = new FakeLlmClient();
    const { chat, sessions, conversations } = fixture({ llm, retriever });
    const controller = new AbortController();
    const iterator = chat.stream({ message: "grounded question", scope: { kind: "library" } }, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    await retriever.started;

    controller.abort();
    const result = await Promise.race([
      next,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    if (result === "timeout") {
      retriever.release();
      await next;
      throw new Error("the aborted turn waited for retrieval to settle");
    }
    expect(result).toMatchObject({ value: { type: "error", code: "aborted" } });
    retriever.release();
    await iterator.return?.(undefined);

    expect(llm.requests).toEqual([]);
    expect(conversations.countAll()).toBe(0);
  });

  it("reports an empty answer from a reasoning model instead of persisting a blank turn", async () => {
    class ReasoningOnlyLlm implements LlmClient {
      readonly configured = true;
      readonly model = "reasoning-model";
      readonly host = "llm.example";
      async *stream(): AsyncIterable<LlmEvent> {
        yield { type: "done", finishReason: "length" };
      }
    }
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const { chat, sessions, conversations } = fixture({ llm: new ReasoningOnlyLlm(), retriever });

    const events = await collect(chat.stream({ message: "grounded question", scope: { kind: "library" } }, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["sources", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "llm_empty",
      message: "The language model returned no answer",
      detail: "length",
    });
    expect(conversations.countAll()).toBe(0);
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
    const { chat, sessions } = fixture({ llm: new NoLlmClient() });
    await expect(collect(chat.stream({ message: "q", scope: { kind: "library" } }, new AbortController().signal)))
      .rejects.toBeInstanceOf(ChatDisabledError);
  });
});
