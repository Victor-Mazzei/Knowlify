import {
  assertSameScope,
  conversationTitle,
  CHAT_MODES,
  MAX_MESSAGES_PER_CONVERSATION,
  normalizeExcerpt,
  normalizeQuestion,
  type ChatMessage,
  type ChatMode,
  type ChatScope,
  type Citation,
  type Conversation,
} from "../domain/assistant/Conversation.js";
import {
  ChatDisabledError,
  ChatRateLimitedError,
  ConversationFullError,
  ConversationLimitError,
  InvalidModeError,
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
  | {
      type: "sources";
      /** `null` in Ask mode: the turn is ephemeral and has no saved conversation. */
      conversationId: string | null;
      retrieval: ChatRetrieval;
      citations: Citation[];
      mode: ChatMode;
      persisted: boolean;
      /** Ask only: whether this turn used the library. */
      useLibrary?: boolean;
    }
  | { type: "delta"; text: string }
  | {
      type: "done";
      conversationId: string | null;
      messageId: string;
      title: string;
      finishReason: "stop" | "length";
      mode: ChatMode;
      persisted: boolean;
      /** Ask only: whether this turn used the library. */
      useLibrary?: boolean;
    }
  | { type: "error"; code: ChatErrorCode; message: string; detail?: string };

export interface ChatSessionLimits {
  maxSessions: number;
  count: number;
  maxMessages: number;
}

export interface ChatStatus {
  enabled: boolean;
  model: string | null;
  host: string | null;
  promptVersion: string;
  scopes: { library: boolean; book: boolean };
  /** Additive capability marker so a new client never sends `mode` to an old server. */
  modes: ChatMode[];
  sessionLimits: ChatSessionLimits;
}

export interface ChatLimits {
  maxTokens: number;
  timeoutSec: number;
  ratePerMin: number;
  /** Library retrieval needs the index; book scope can still use the reader excerpt. */
  libraryScope: boolean;
  /** Blocking cap on saved sessions; reaching it never deletes an existing session. */
  maxConversations: number;
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
  /** Omitted keeps the legacy behaviour: a saved Session. */
  mode?: ChatMode;
  /** Ask only; defaults to `true`. A Session always uses the library. */
  useLibrary?: boolean;
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
  /** `timed_out` is preserved even when partial citations were found. */
  search: "used" | "not_used" | "timed_out";
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
  /** New Sessions already admitted by the in-process cap check but not yet committed. */
  private pendingNewSessions = 0;

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
      modes: [...CHAT_MODES],
      sessionLimits: {
        maxSessions: limits.maxConversations,
        count: this.conversations.countAll(),
        maxMessages: MAX_MESSAGES_PER_CONVERSATION,
      },
    };
  }

  /** Active answer streams; background warm-up reads must yield to them. */
  busyStreams(): number {
    return this.activeStreams;
  }

  async *stream(input: ChatTurnInput, signal: AbortSignal): AsyncIterable<ChatEvent> {
    if (!this.llm.configured) throw new ChatDisabledError();
    const question = normalizeQuestion(input.message);
    const mode = resolveMode(input);
    const useLibrary = mode === "ask" ? input.useLibrary ?? true : true;
    const excerpt = input.scope.kind === "book" ? normalizeExcerpt(input.scope.excerpt) : undefined;
    const book = input.scope.kind === "book" ? this.books.get(input.scope.bookId) : undefined;
    if (input.scope.kind === "book" && !book) throw new NotFoundError("Book not found");
    // Ask without the library needs neither the index nor a searchable scope (ADR-3).
    if (useLibrary && input.scope.kind === "library" && !this.limits().libraryScope) {
      throw new LibraryChatUnavailableError("Library chat needs the search index");
    }

    const persisted = mode === "session";
    const conversationId = persisted ? input.conversationId ?? this.ids.next() : this.ids.next();

    // A continued conversation is serialized end to end: the next turn must read the
    // history and the message cap after this one commits. Abandoned waiters give up.
    let releaseTurn: (() => void) | undefined;
    if (persisted && input.conversationId) {
      try {
        releaseTurn = await this.turns.acquire(conversationId, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        yield this.errorEvent("aborted");
        return;
      }
    }
    try {
      yield* this.streamTurn(
        input,
        { conversationId, question, excerpt, book, mode, useLibrary, persisted },
        signal,
      );
    } finally {
      releaseTurn?.();
    }
  }

  private async *streamTurn(
    input: ChatTurnInput,
    resolved: {
      conversationId: string;
      question: string;
      excerpt: string | undefined;
      book: Book | undefined;
      mode: ChatMode;
      useLibrary: boolean;
      persisted: boolean;
    },
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const { conversationId, question, excerpt, book, mode, useLibrary, persisted } = resolved;
    // Snapshot once per turn: the answer keeps consistent limits and prompt version even
    // if the user saves new settings while it streams.
    const limits = this.limits();
    const systemPrompt = this.systemPrompt();
    const promptVersion = promptVersionFor(systemPrompt);
    if (signal.aborted) {
      yield this.errorEvent("aborted");
      return;
    }

    // A new Session is checked before the rate limit, retrieval and provider call, so a
    // turn that cannot be saved never spends a response. The reservation covers turns
    // already in flight in this process; the repository re-checks inside its transaction.
    const startsSession = persisted && input.conversationId === undefined;
    if (startsSession) this.reserveNewSession(limits);

    let existing: Conversation | undefined;
    let existingMessages: ChatMessage[] = [];
    if (persisted && input.conversationId) {
      existing = this.loadConversation(conversationId);
      existingMessages = this.conversations.messages(existing.id);
      assertSameScope(existing.scope, input.scope);
      if (existingMessages.length + 2 > MAX_MESSAGES_PER_CONVERSATION) {
        throw new ConversationFullError();
      }
    }

    const now = this.clock.now();
    try {
      this.consumeRateLimit(now, limits.ratePerMin);
    } catch (error) {
      // The reservation was taken before the rate limit so a 409 never consumes quota;
      // release it when the turn stops before the streaming block owns the counter.
      if (startsSession) this.pendingNewSessions -= 1;
      throw error;
    }
    // Ask has no memory of earlier questions (ADR-3), so the provider receives no history.
    const history = persisted ? cleanHistory(existingMessages) : [];
    const title = persisted ? existing?.title ?? conversationTitle(question) : "";
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

      let retrieval: RetrievalOutcome = { mode: "none", hits: [], search: "not_used" };
      let searchFailed = false;
      try {
        retrieval = await this.retrieve(input.scope, question, history, limits.libraryScope, useLibrary, signal);
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
      yield {
        type: "sources",
        conversationId: persisted ? conversationId : null,
        retrieval: citations.length > 0 ? retrieval.mode : "none",
        citations,
        mode,
        persisted,
        ...(mode === "ask" ? { useLibrary } : {}),
      };
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
        librarySearch: retrieval.search,
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
      // Ask is ephemeral: no conversation row, no messages, nothing to delete.
      if (persisted) this.persistTurn(turn, question, title, assistant, now, limits.maxConversations);
      yield {
        type: "done",
        conversationId: persisted ? conversationId : null,
        messageId: assistantId,
        title,
        finishReason,
        mode,
        persisted,
        ...(mode === "ask" ? { useLibrary } : {}),
      };
    } finally {
      this.activeStreams -= 1;
      if (startsSession) this.pendingNewSessions -= 1;
    }
  }

  /** Synchronous check-and-reserve, so concurrent turns cannot both pass the cap. */
  private reserveNewSession(limits: ChatLimits): void {
    const count = this.conversations.countAll();
    if (count + this.pendingNewSessions >= limits.maxConversations) {
      throw new ConversationLimitError(limits.maxConversations, count);
    }
    this.pendingNewSessions += 1;
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
    useLibrary: boolean,
    signal: AbortSignal,
  ): Promise<RetrievalOutcome> {
    // Ask with the library off must not touch the retriever at all (ADR-3); the prompt
    // receives "Library: not used for this question." and the excerpt stays allowed.
    if (!useLibrary) return { mode: "none", hits: [], search: "not_used" };
    const searchable = scope.kind === "library" || libraryScope;
    if (!searchable) return { mode: "none", hits: [], search: "not_used" };
    let attempted = false;
    let unavailable = false;
    for (const query of buildRetrievalQueries(question, history)) {
      if (!query) continue;
      attempted = true;
      // The retriever is in-process today, but an embedding query can wait behind a busy
      // worker. A cancelled turn must not hold the conversation mutex until it settles.
      const result = await untilAborted(
        this.retriever.search({
          q: query,
          ...(scope.kind === "book" ? { bookId: scope.bookId } : {}),
          limit: MAX_PASSAGES,
        }, { allowShortQuery: true }),
        signal,
      );
      unavailable ||= result.unavailable === true;
      const hits = result.hits.slice(0, MAX_PASSAGES);
      if (hits.length > 0) {
        // Keep the partial warning: a prior read was unavailable, so the search may have
        // missed results even though these citations are valid and must be preserved.
        return { mode: toRetrievalMode(result.mode), hits, search: unavailable ? "timed_out" : "used" };
      }
    }
    if (!attempted) return { mode: "none", hits: [], search: "not_used" };
    // A completed search that found nothing is "used"; any unavailable attempt wins over
    // that clean no-match so the prompt never claims the library has no such passage.
    return { mode: "none", hits: [], search: unavailable ? "timed_out" : "used" };
  }

  private persistTurn(
    turn: TurnContext,
    question: string,
    title: string,
    assistant: ChatMessage,
    now: number,
    maxConversations: number,
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
      { maxConversations, maxMessagesPerConversation: MAX_MESSAGES_PER_CONVERSATION },
      now,
    );
  }

  private errorEvent(code: ChatErrorCode, detail?: string): ChatEvent {
    return { type: "error", code, message: PUBLIC_ERRORS[code], ...(detail ? { detail } : {}) };
  }
}

function resolveMode(input: ChatTurnInput): ChatMode {
  const mode = input.mode ?? "session";
  if (!(CHAT_MODES as readonly string[]).includes(mode)) {
    throw new InvalidModeError("mode must be ask or session");
  }
  if (mode === "ask" && input.conversationId !== undefined) {
    throw new InvalidModeError("Ask mode does not keep a conversation");
  }
  if (input.useLibrary !== undefined && mode !== "ask") {
    throw new InvalidModeError("useLibrary is only valid in ask mode");
  }
  return mode;
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
