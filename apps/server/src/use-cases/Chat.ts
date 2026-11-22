import {
  assertSameScope,
  conversationTitle,
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
  normalizeExcerpt,
  normalizeQuestion,
  type ChatMessage,
  type ChatScope,
  type Citation,
  type Conversation,
} from "../domain/assistant/Conversation.js";
import {
  ChatDisabledError,
  ChatRateLimitedError,
  ConversationFullError,
  LibraryChatUnavailableError,
} from "../domain/assistant/errors.js";
import { NotFoundError } from "../domain/errors.js";
import {
  buildTutorMessages,
  MAX_PASSAGES,
  promptVersionFor,
  TUTOR_PROMPT_VERSION,
  type TutorMessage,
  type TutorPassage,
} from "../domain/assistant/tutorPrompt.js";
import {
  buildRetrievalQueries,
  dropCannedPairs,
  stripCitationMarkers,
} from "../domain/assistant/sessionContext.js";
import { LlmError } from "../ports/assistant.js";
import type { ConversationRepository, LlmClient, PassageRetriever } from "../ports/assistant.js";
import type { Book, BookRepository, Clock, IdGenerator, Logger } from "../ports/index.js";

export { TUTOR_PROMPT_VERSION as CHAT_PROMPT_VERSION };

export type ChatRetrieval = "hybrid" | "semantic" | "lexical" | "none";

export type ChatErrorCode =
  | "llm_unavailable"
  | "llm_timeout"
  | "llm_rejected"
  | "llm_protocol"
  | "llm_empty"
  | "search_failed"
  | "aborted";

export type ChatEvent =
  | { type: "sources"; conversationId: string; retrieval: ChatRetrieval; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "done"; conversationId: string; messageId: string; title: string; finishReason: "stop" | "length" }
  | { type: "error"; code: ChatErrorCode; message: string; detail?: string };

export interface ChatStatus {
  enabled: boolean;
  model: string | null;
  host: string | null;
  promptVersion: string;
  scopes: { library: boolean; book: boolean };
}

export interface ChatLimits {
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  /** Library retrieval needs the index; book scope can still use the reader excerpt. */
  libraryScope: boolean;
}

export const MAX_CONCURRENT_STREAMS = 2;

export type ChatRequestScope =
  | { kind: "library" }
  | {
      kind: "book";
      bookId: string;
      excerpt?: string;
      excerptKind?: "selection" | "visible";
      page?: number;
      section?: string;
    };

export interface ChatTurnInput {
  conversationId?: string;
  message: string;
  scope: ChatRequestScope;
}

const PUBLIC_ERRORS: Record<ChatErrorCode, string> = {
  llm_unavailable: "The language model is unavailable right now",
  llm_timeout: "The language model took too long to answer",
  llm_rejected: "The language model rejected the request",
  llm_protocol: "The language model returned an unexpected response",
  llm_empty: "The language model returned no answer",
  search_failed: "The library search failed",
  aborted: "The request was cancelled",
};

const RATE_WINDOW_MS = 60_000;

interface RetrievalOutcome {
  mode: ChatRetrieval;
  hits: { passageId: number; bookId: string; bookTitle: string; text: string; location: { page: number | null; section: string | null } }[];
}

interface TurnContext {
  conversation: Conversation | undefined;
  conversationId: string;
  scope: ChatScope;
  excerpt: string | undefined;
  excerptKind: "selection" | "visible" | undefined;
  bookTitle: string | undefined;
  page: number | undefined;
  section: string | undefined;
}

/**
 * Assistant use case: validates the turn, retrieves grounding passages, streams the
 * provider answer and persists the turn only after it completes successfully. All I/O
 * goes through ports, so the HTTP layer only translates events.
 */
export class Chat {
  private readonly recentRequests: number[] = [];
  private readonly turns = new ConversationMutex();
  private activeStreams = 0;

  constructor(
    private readonly llm: LlmClient,
    private readonly retriever: PassageRetriever,
    private readonly conversations: ConversationRepository,
    private readonly books: BookRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    /** Read on every turn so a settings change applies without restarting the process. */
    private readonly limits: () => ChatLimits,
    /** Effective persona for the next turn; `null` uses the default. Read per turn. */
    private readonly systemPrompt: () => string | null,
    private readonly log: Logger = { info: () => {}, error: () => {} },
  ) {}

  status(): ChatStatus {
    const enabled = this.llm.configured;
    const limits = this.limits();
    return {
      enabled,
      model: enabled ? this.llm.model : null,
      host: enabled ? this.llm.host : null,
      promptVersion: promptVersionFor(this.systemPrompt()),
      scopes: { library: enabled && limits.libraryScope, book: enabled },
    };
  }

  async *stream(input: ChatTurnInput, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (!this.llm.configured) throw new ChatDisabledError();
    const question = normalizeQuestion(input.message);
    const excerpt = input.scope.kind === "book" ? normalizeExcerpt(input.scope.excerpt) : undefined;
    const book = input.scope.kind === "book" ? this.books.get(input.scope.bookId) : undefined;
    if (input.scope.kind === "book" && !book) throw new NotFoundError("Book not found");
    if (input.scope.kind === "library" && !this.limits().libraryScope) {
      throw new LibraryChatUnavailableError("Library chat needs the search index");
    }

    const conversationId = input.conversationId ?? this.ids.next();

    // A continued conversation is serialized end to end: the next turn must read the
    // history and the message cap after this one commits. Abandoned waiters give up.
    let releaseTurn: (() => void) | undefined;
    if (input.conversationId) {
      try {
        releaseTurn = await this.turns.acquire(conversationId, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        yield this.errorEvent("aborted");
        return;
      }
    }
    try {
      yield* this.streamTurn(input, { conversationId, question, excerpt, book }, signal);
    } finally {
      releaseTurn?.();
    }
  }

  private async *streamTurn(
    input: ChatTurnInput,
    resolved: { conversationId: string; question: string; excerpt: string | undefined; book: Book | undefined },
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const { conversationId, question, excerpt, book } = resolved;
    // Snapshot once per turn: the answer keeps consistent limits and prompt version even
    // if the user saves new settings while it streams.
    const limits = this.limits();
    const systemPrompt = this.systemPrompt();
    const promptVersion = promptVersionFor(systemPrompt);
    if (signal.aborted) {
      yield this.errorEvent("aborted");
      return;
    }

    const existing = input.conversationId ? this.loadConversation(conversationId) : undefined;
    const existingMessages = existing ? this.conversations.messages(existing.id) : [];
    if (existing) {
      assertSameScope(existing.scope, input.scope);
      if (existingMessages.length + 2 > MAX_MESSAGES_PER_CONVERSATION) {
        throw new ConversationFullError();
      }
    }

    const now = this.clock.now();
    this.consumeRateLimit(now, limits.ratePerMin);
    const history = cleanHistory(existingMessages);
    const title = existing?.title ?? conversationTitle(question);
    const turn: TurnContext = {
      conversation: existing,
      conversationId,
      scope: input.scope,
      excerpt,
      excerptKind: input.scope.kind === "book" ? input.scope.excerptKind : undefined,
      bookTitle: book?.title,
      page: input.scope.kind === "book" ? input.scope.page : undefined,
      section: input.scope.kind === "book" ? input.scope.section : undefined,
    };

    this.activeStreams += 1;
    try {
      if (this.activeStreams > MAX_CONCURRENT_STREAMS) {
        throw new ChatRateLimitedError("Too many chats are streaming right now", 1);
      }

      let retrieval: RetrievalOutcome = { mode: "none", hits: [] };
      let searchFailed = false;
      try {
        retrieval = await this.retrieve(input.scope, question, history, limits.libraryScope, signal);
      } catch (error) {
        // Cancellation is not a search failure: release the turn (and the conversation
        // mutex) without logging or waiting for the in-flight search to settle.
        if (signal.aborted) {
          yield this.errorEvent("aborted");
          return;
        }
        this.log.error(error, "chat retrieval failed");
        searchFailed = true;
      }
      if (signal.aborted) {
        yield this.errorEvent("aborted");
        return;
      }

      const citations = retrieval.hits.map((hit, index) => ({
        n: index + 1,
        passageId: hit.passageId,
        bookId: hit.bookId,
        bookTitle: hit.bookTitle,
        page: hit.location.page,
        section: hit.location.section,
      }));
      yield { type: "sources", conversationId, retrieval: citations.length > 0 ? retrieval.mode : "none", citations };
      if (searchFailed) {
        yield this.errorEvent("search_failed");
        return;
      }

      const assistantId = this.ids.next();
      const passages: TutorPassage[] = retrieval.hits.map((hit, index) => ({
        n: index + 1,
        bookTitle: hit.bookTitle,
        page: hit.location.page,
        section: hit.location.section,
        text: hit.text,
      }));
      const messages = buildTutorMessages({
        question,
        passages,
        history,
        systemPrompt,
        ...(excerpt !== undefined
          ? {
              excerpt: {
                text: excerpt,
                ...(turn.excerptKind !== undefined ? { kind: turn.excerptKind } : {}),
                ...(turn.bookTitle !== undefined ? { bookTitle: turn.bookTitle } : {}),
                ...(turn.page !== undefined ? { page: turn.page } : {}),
                ...(turn.section !== undefined ? { section: turn.section } : {}),
              },
            }
          : {}),
      });

      let answer = "";
      let finishReason: "stop" | "length" = "stop";
      try {
        for await (const event of this.llm.stream(
          { messages, maxTokens: limits.maxTokens, temperature: 0.3, sessionId: conversationId },
          signal,
        )) {
          if (event.type === "delta") {
            answer += event.text;
            yield { type: "delta", text: event.text };
          } else {
            finishReason = event.finishReason;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield this.errorEvent("aborted");
          return;
        }
        const code = error instanceof LlmError ? llmErrorCode(error.code) : "llm_protocol";
        const detail = error instanceof LlmError ? error.providerDetail : undefined;
        if (error instanceof LlmError) {
          // Log only the allowlisted fields: provider detail is a fixed category, never text.
          this.log.error(
            {
              llmErrorCode: error.code,
              providerStatus: error.providerStatus,
              providerDiagnostic: error.providerDetail,
            },
            "chat completion failed",
          );
        } else {
          this.log.error(error, "chat completion failed unexpectedly");
        }
        yield this.errorEvent(code, detail);
        return;
      }
      if (signal.aborted) {
        yield this.errorEvent("aborted");
        return;
      }
      if (!answer) {
        // A reasoning model can spend the whole token budget before emitting content.
        // Say so instead of presenting an empty assistant turn.
        yield this.errorEvent("llm_empty", finishReason === "length" ? "length" : undefined);
        return;
      }

      const assistant: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: answer,
        citations: citations.length > 0 ? citations : null,
        promptVersion,
        createdAt: this.clock.now(),
      };
      this.persistTurn(turn, question, title, assistant, now);
      yield { type: "done", conversationId, messageId: assistantId, title, finishReason };
    } finally {
      this.activeStreams -= 1;
    }
  }

  list(input: { bookId?: string; limit?: number } = {}): Conversation[] {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20) || 20, 1), 50);
    return this.conversations.list(input.bookId ? { kind: "book", bookId: input.bookId } : { kind: "library" }, limit);
  }

  get(id: string): { conversation: Conversation; messages: ChatMessage[] } | undefined {
    const conversation = this.conversations.get(id);
    return conversation ? { conversation, messages: this.conversations.messages(id) } : undefined;
  }

  remove(id: string): boolean {
    return this.conversations.delete(id);
  }

  private loadConversation(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new NotFoundError("Conversation not found");
    return conversation;
  }

  private consumeRateLimit(now: number, ratePerMin: number): void {
    const since = now - RATE_WINDOW_MS;
    while (this.recentRequests.length > 0 && (this.recentRequests[0] ?? now) <= since) this.recentRequests.shift();
    const limit = Math.max(1, ratePerMin);
    if (this.recentRequests.length >= limit) {
      const oldest = this.recentRequests[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000));
      throw new ChatRateLimitedError("Too many chat messages; retry shortly", retryAfterSec);
    }
    this.recentRequests.push(now);
  }

  private async retrieve(
    scope: ChatScope,
    question: string,
    history: TutorMessage[],
    libraryScope: boolean,
    signal: AbortSignal,
  ): Promise<RetrievalOutcome> {
    const searchable = scope.kind === "library" || libraryScope;
    if (!searchable) return { mode: "none", hits: [] };
    for (const query of buildRetrievalQueries(question, history)) {
      if (query.length < 2) continue;
      // The retriever is in-process today, but an embedding query can wait behind a busy
      // worker. A cancelled turn must not hold the conversation mutex until it settles.
      const result = await untilAborted(
        this.retriever.search({
          q: query,
          ...(scope.kind === "book" ? { bookId: scope.bookId } : {}),
          limit: MAX_PASSAGES,
        }),
        signal,
      );
      const hits = result.hits.slice(0, MAX_PASSAGES);
      if (hits.length > 0) return { mode: toRetrievalMode(result.mode), hits };
    }
    return { mode: "none", hits: [] };
  }

  private persistTurn(
    turn: TurnContext,
    question: string,
    title: string,
    assistant: ChatMessage,
    now: number,
  ): void {
    const user: ChatMessage = {
      id: this.ids.next(),
      role: "user",
      content: question,
      citations: null,
      promptVersion: null,
      createdAt: now,
    };
    this.conversations.saveTurn(
      {
        conversationId: turn.conversationId,
        newConversation: turn.conversation
          ? null
          : { id: turn.conversationId, scope: turn.scope, title, createdAt: now, updatedAt: now },
        user,
        assistant,
      },
      { maxConversations: MAX_CONVERSATIONS, maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION },
      now,
    );
  }

  private errorEvent(code: ChatErrorCode, detail?: string): ChatEvent {
    return { type: "error", code, message: PUBLIC_ERRORS[code], ...(detail ? { detail } : {}) };
  }
}

function cleanHistory(messages: readonly ChatMessage[]): TutorMessage[] {
  return dropCannedPairs(messages).map((message) => ({
    role: message.role,
    content: message.role === "assistant" ? stripCitationMarkers(message.content) : message.content,
  }));
}

function toRetrievalMode(mode: string): ChatRetrieval {
  return mode === "hybrid" || mode === "semantic" || mode === "lexical" ? mode : "none";
}

function llmErrorCode(code: LlmError["code"]): ChatErrorCode {
  switch (code) {
    case "unavailable": return "llm_unavailable";
    case "timeout": return "llm_timeout";
    case "rejected": return "llm_rejected";
    case "aborted": return "aborted";
    default: return "llm_protocol";
  }
}

/**
 * In-process mutex per conversation. A continued turn holds it from the history read
 * through the commit, so a double submit cannot both pass the message cap. The
 * repository transaction still guards the write across processes.
 */
class ConversationMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);

    try {
      await untilAborted(previous, signal);
    } catch (error) {
      releaseHeld();
      // Keep the tail queued behind the current holder so a third waiter cannot
      // enter while the holder still owns the turn; clear it once the chain settles.
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseHeld();
      // A later waiter may already own the tail; only the last one clears the key.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

/** Resolves with the work or rejects as soon as the turn is cancelled. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("The chat turn was aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("The chat turn was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
