import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteConversationRepository } from "../src/adapters/storage/SqliteConversationRepository.js";
import { Chat, type ChatEvent, type ChatLimits } from "../src/use-cases/Chat.js";
import type { Book, Logger } from "../src/ports/index.js";
import {
  LlmError,
  type ConversationRepository,
  type LlmClient,
  type LlmEvent,
  type LlmRequest,
  type PassageRetriever,
} from "../src/ports/assistant.js";
import type { PassageSearchHit } from "../src/use-cases/PassageSearch.js";

export const BOOK: Book = {
  id: "book-1",
  title: "Deep Work",
  author: "Cal Newport",
  format: "pdf",
  path: "/library/deep-work.pdf",
  cover_path: null,
  size: 10,
  added_at: 1,
  source_id: null,
  mtime: null,
  status: "ready",
};

export function passage(overrides: Partial<PassageSearchHit> = {}): PassageSearchHit {
  return {
    passageId: 1,
    bookId: BOOK.id,
    bookTitle: BOOK.title,
    text: "Deep work is the ability to focus without distraction.",
    location: { page: 12, section: "Chapter 1" },
    score: 1,
    ...overrides,
  };
}

/** Configurable streaming client; records every request so prompt wiring is observable. */
export class FakeLlmClient implements LlmClient {
  configured = true;
  model: string | null = "fake-model";
  host: string | null = "llm.example";
  chunks: string[] = ["Hello", " there"];
  error: Error | null = null;
  readonly requests: LlmRequest[] = [];
  readonly signals: AbortSignal[] = [];

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    this.signals.push(signal);
    for (const text of this.chunks) {
      if (signal.aborted) throw new LlmError("aborted", "The chat request was cancelled");
      yield { type: "delta", text };
    }
    if (this.error) throw this.error;
    yield { type: "done", finishReason: "stop" };
  }
}

/** Holds the stream after the first delta so tests can abort or exhaust concurrency. */
export class WaitingLlmClient implements LlmClient {
  configured = true;
  model: string | null = "waiting-model";
  host: string | null = "waiting.example";
  readonly signals: AbortSignal[] = [];
  readonly aborted: Promise<void>;
  private resolveAborted!: () => void;
  private readonly gates: Array<() => void> = [];

  constructor() {
    this.aborted = new Promise((resolve) => {
      this.resolveAborted = resolve;
    });
  }

  release(): void {
    this.gates.shift()?.();
  }

  async *stream(_request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.signals.push(signal);
    const gate = new Promise<void>((resolve) => this.gates.push(resolve));
    const onAbort = () => {
      this.resolveAborted();
      this.release();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      yield { type: "delta", text: "partial" };
      await gate;
      if (signal.aborted) throw new LlmError("aborted", "The chat request was cancelled");
      yield { type: "done", finishReason: "stop" };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class FakeRetriever implements PassageRetriever {
  mode = "hybrid";
  hits: PassageSearchHit[] = [];
  error: Error | null = null;
  readonly queries: { q: string; bookId?: string; limit: number }[] = [];

  async search(query: { q: string; bookId?: string; limit: number }): Promise<{ mode: string; hits: PassageSearchHit[] }> {
    this.queries.push(query);
    if (this.error) throw this.error;
    return { mode: this.mode, hits: this.hits };
  }
}

/** Holds retrieval so a test can disconnect the client before the first event. */
export class BlockingRetriever implements PassageRetriever {
  mode = "hybrid";
  hits: PassageSearchHit[] = [passage()];
  readonly started: Promise<void>;
  readonly finished: Promise<void>;
  private releaseSearch!: () => void;
  private markStarted!: () => void;
  private markFinished!: () => void;

  constructor() {
    this.started = new Promise((resolve) => { this.markStarted = resolve; });
    this.finished = new Promise((resolve) => { this.markFinished = resolve; });
  }

  async search(): Promise<{ mode: string; hits: PassageSearchHit[] }> {
    this.markStarted();
    await new Promise<void>((resolve) => { this.releaseSearch = resolve; });
    this.markFinished();
    return { mode: this.mode, hits: this.hits };
  }

  release(): void {
    this.releaseSearch();
  }
}

export interface ChatFixtureOptions {
  llm?: LlmClient;
  retriever?: PassageRetriever;
  limits?: Partial<ChatLimits>;
  books?: Book[];
  log?: Logger;
  /** Mutable provider, so tests can change the persona between turns. */
  systemPrompt?: () => string | null;
}

export interface ChatFixture {
  db: Db;
  chat: Chat;
  conversations: ConversationRepository;
  llm: LlmClient;
  retriever: PassageRetriever;
  advance(ms: number): void;
}

export function createChatFixture(options: ChatFixtureOptions = {}): ChatFixture {
  const db = openDb(":memory:");
  const books = new SqliteBookRepository(db);
  for (const book of options.books ?? [BOOK]) books.save(book);
  const conversations = new SqliteConversationRepository(db);
  const llm = options.llm ?? new FakeLlmClient();
  const retriever = options.retriever ?? new FakeRetriever();
  let now = 1_000;
  let sequence = 0;
  const limits: ChatLimits = { maxTokens: 256, timeoutSec: 5, ratePerMin: 20, libraryScope: true, ...options.limits };
  const chat = new Chat(
    llm,
    retriever,
    conversations,
    books,
    { now: () => now },
    { next: () => `id-${++sequence}` },
    () => limits,
    options.systemPrompt ?? (() => null),
    options.log,
  );
  return { db, chat, conversations, llm, retriever, advance: (ms) => { now += ms; } };
}

export async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const collected: ChatEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function parseSseEvents(body: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload) events.push(JSON.parse(payload) as ChatEvent);
    }
  }
  return events;
}
