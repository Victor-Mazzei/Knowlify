import { describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteConversationRepository } from "../src/adapters/storage/SqliteConversationRepository.js";
import { NoLlmClient } from "../src/adapters/llm/NoLlmClient.js";
import { SwitchableLlmClient } from "../src/adapters/llm/SwitchableLlmClient.js";
import { Chat, type ChatLimits } from "../src/use-cases/Chat.js";
import type { LlmClient, LlmEvent, LlmRequest } from "../src/ports/assistant.js";
import { BOOK, FakeLlmClient, FakeRetriever, passage } from "./chat-helpers.js";

const requestFor = { message: "Explain deep work", scope: { kind: "book" as const, bookId: BOOK.id } };
const signal = new AbortController().signal;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class GatedClient implements LlmClient {
  readonly configured = true;
  readonly model = "gated";
  readonly host = "gated.example";

  constructor(private readonly label: string, private readonly gate?: Promise<void>) {}

  async *stream(_request: LlmRequest, _signal: AbortSignal): AsyncIterable<LlmEvent> {
    yield { type: "delta", text: `${this.label}-first` };
    if (this.gate) await this.gate;
    yield { type: "delta", text: `${this.label}-second` };
    yield { type: "done", finishReason: "stop" };
  }
}

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("SwitchableLlmClient", () => {
  it("finishes the running stream on the old client and uses the new client next", async () => {
    const gate = deferred();
    const first = new GatedClient("old", gate.promise);
    const second = new GatedClient("new");
    const switchable = new SwitchableLlmClient(() => new NoLlmClient(), first);
    expect(switchable.configured).toBe(true);
    expect(switchable.model).toBe("gated");

    const iterator = switchable.stream({ messages: [], maxTokens: 1, temperature: 0 }, signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "delta", text: "old-first" } });
    switchable.commit(second);
    gate.release();
    const rest: LlmEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest).toEqual([
      { type: "delta", text: "old-second" },
      { type: "done", finishReason: "stop" },
    ]);

    const nextTurn = await collect(switchable.stream({ messages: [], maxTokens: 1, temperature: 0 }, signal));
    expect(nextTurn).toEqual([
      { type: "delta", text: "new-first" },
      { type: "delta", text: "new-second" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("keeps the previous client when the candidate cannot be built", () => {
    const current = new GatedClient("current");
    const switchable = new SwitchableLlmClient(() => { throw new Error("invalid candidate"); }, current);
    expect(() => switchable.prepare(null)).toThrow("invalid candidate");
    expect(switchable.configured).toBe(true);
    expect(switchable.model).toBe("gated");
  });
});

describe("Chat limits function", () => {
  it("applies max tokens and rate limit changes on the next message without restarting", async () => {
    const db = openDb(":memory:");
    const books = new SqliteBookRepository(db);
    books.save(BOOK);
    const conversations = new SqliteConversationRepository(db);
    const llm = new FakeLlmClient();
    const retriever = new FakeRetriever();
    retriever.hits = [passage()];
    const limits: ChatLimits = { maxTokens: 100, timeoutSec: 5, ratePerMin: 20, libraryScope: true };
    let now = 1_000;
    let sequence = 0;
    const chat = new Chat(
      llm,
      retriever,
      conversations,
      books,
      { now: () => now },
      { next: () => `id-${++sequence}` },
      () => limits,
      () => null,
    );
    try {
      const first = [];
      for await (const event of chat.stream(requestFor, signal)) first.push(event);
      expect(first.at(-1)).toMatchObject({ type: "done" });
      expect(llm.requests[0]?.maxTokens).toBe(100);

      limits.maxTokens = 300;
      limits.ratePerMin = 1;
      // Clear the previous rate window so the new per-minute cap is what applies.
      now += 60_001;
      const second = [];
      for await (const event of chat.stream(requestFor, signal)) second.push(event);
      expect(second.at(-1)).toMatchObject({ type: "done" });
      expect(llm.requests[1]?.maxTokens).toBe(300);
      expect(chat.status().scopes).toEqual({ library: true, book: true });

      now += 1_000;
      await expect(async () => {
        for await (const _event of chat.stream(requestFor, signal)) {
          // consume
        }
      }).rejects.toMatchObject({ code: "rate_limited" });
    } finally {
      db.close();
    }
  });
});
