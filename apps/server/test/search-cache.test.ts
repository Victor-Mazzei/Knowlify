import { afterEach, describe, expect, it } from "vitest";

import { IndexEpochCounter } from "../src/adapters/runtime/IndexEpochCounter.js";
import { CachedPassageQueryStore, withSearchCache } from "../src/adapters/search/CachedPassageQueryStore.js";
import type { ClosablePassageQueryStore } from "../src/adapters/search/CachedPassageQueryStore.js";
import { QueryCache } from "../src/adapters/search/QueryCache.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import { SqlitePassageQueryStore } from "../src/adapters/storage/SqlitePassageQueryStore.js";
import type {
  LexicalHit,
  LexicalQueryResult,
  PassageView,
  ScoredPassage,
  VectorFilter,
} from "../src/ports/knowledge.js";

interface FakeHandlers {
  lexical?: (q: string, limit: number, bookId?: string) => Promise<LexicalHit[]>;
  /** Defaults to true; false simulates a cheap layer that skipped the full plan. */
  lexicalComplete?: boolean;
  hydrate?: (ids: number[]) => Promise<PassageView[]>;
  nearest?: (vector: Float32Array, limit: number, filter?: VectorFilter) => Promise<ScoredPassage[]>;
  vectorCount?: () => Promise<number>;
}

class FakeStore {
  calls = { lexical: 0, hydrate: 0, nearest: 0, vectorCount: 0 };
  closed = false;
  constructor(private readonly handlers: FakeHandlers = {}) {}

  searchLexical(q: string, limit: number, bookId?: string): Promise<LexicalHit[]> {
    this.calls.lexical += 1;
    return this.handlers.lexical?.(q, limit, bookId) ?? Promise.resolve([]);
  }

  async searchLexicalResult(q: string, limit: number, bookId?: string): Promise<LexicalQueryResult> {
    return { hits: await this.searchLexical(q, limit, bookId), complete: this.handlers.lexicalComplete ?? true };
  }

  hydrate(ids: number[]): Promise<PassageView[]> {
    this.calls.hydrate += 1;
    return this.handlers.hydrate?.(ids) ?? Promise.resolve([]);
  }

  nearest(vector: Float32Array, limit: number, filter?: VectorFilter): Promise<ScoredPassage[]> {
    this.calls.nearest += 1;
    return this.handlers.nearest?.(vector, limit, filter) ?? Promise.resolve([]);
  }

  vectorCount(): Promise<number> {
    this.calls.vectorCount += 1;
    return this.handlers.vectorCount?.() ?? Promise.resolve(0);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const clockOf = () => {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => { value += ms; },
  };
};

const decorate = <T extends ClosablePassageQueryStore>(
  inner: T,
  options: { epoch?: IndexEpochCounter; admissionMs?: number; quietMs?: number; ttlMs?: number; maxEntries?: number; maxBytes?: number } = {},
) => {
  const clock = clockOf();
  const epoch = options.epoch ?? new IndexEpochCounter();
  const store = new CachedPassageQueryStore(inner, {
    epoch,
    maxEntries: options.maxEntries ?? 32,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    admissionMs: options.admissionMs ?? 0,
    quietMs: options.quietMs ?? 0,
    ttlMs: options.ttlMs ?? 600_000,
    now: clock.now,
  });
  return { store, epoch, clock, inner };
};

const hits: LexicalHit[] = [{ passageId: 7, rank: -1 }, { passageId: 9, rank: -2 }];

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

/**
 * Real FTS5 store: the cache must agree with the planner and tokenizer that it decorates,
 * so key collisions are exercised end to end instead of through a fake that echoes input.
 */
function realStore(): SqlitePassageQueryStore {
  const db = openDb(":memory:");
  databases.push(db);
  new SqliteBookRepository(db).save({
    id: "book", title: "Book", author: "", format: "pdf", path: "/library/book.pdf",
    cover_path: null, size: 10, added_at: 1, source_id: null, mtime: 1, status: "ready",
  });
  const passages = new SqlitePassageRepository(db);
  passages.append("book", [
    { passage: { ordinal: 0, text: "C++ templates and the C language", page: 1, section: null }, vector: null },
    { passage: { ordinal: 1, text: "um \u00e4b exemplo", page: 2, section: null }, vector: null },
  ]);
  return new SqlitePassageQueryStore(passages, new SqliteBlobVectorStore(db));
}

describe("CachedPassageQueryStore", () => {
  it("returns exactly the uncached result and reuses it", async () => {
    const inner = new FakeStore({ lexical: async () => hits, nearest: async () => [{ passageId: 7, score: 0.9 }] });
    const { store } = decorate(inner);
    expect(await store.searchLexical("Deep Work", 4)).toEqual(hits);
    expect(await store.searchLexical("  Deep   Work ", 4)).toEqual(hits);
    expect(inner.calls.lexical).toBe(1);
    expect(await store.nearest(new Float32Array([1, 0]), 4)).toEqual([{ passageId: 7, score: 0.9 }]);
    expect(await store.nearest(new Float32Array([1, 0]), 4)).toEqual([{ passageId: 7, score: 0.9 }]);
    expect(inner.calls.nearest).toBe(1);
  });

  it("does not cache a lexical result that skipped the full plan", async () => {
    const inner = new FakeStore({ lexical: async () => hits, lexicalComplete: false });
    const { store } = decorate(inner);
    await store.searchLexical("partial", 4);
    expect(store.stats().entries).toBe(0);
    await store.searchLexical("partial", 4);
    expect(inner.calls.lexical).toBe(2);
  });

  it("keeps queries whose case changes the FTS plan apart, in either cache order", async () => {
    // A significant single-character term is case-sensitive in the planner: `C` searches
    // the exact token while `c` is dropped as low signal and matches nothing.
    for (const queryOrder of [["C", "c"], ["c", "C"]] as const) {
      const { store } = decorate(realStore());
      const results = new Map<string, LexicalHit[]>();
      for (const query of queryOrder) results.set(query, await store.searchLexical(query, 8));
      expect(results.get("C")?.map((hit) => hit.passageId)).toEqual([1]);
      expect(results.get("c")).toEqual([]);
      await store.close();
    }
  });

  it("keeps NFC and NFD spellings apart, in either cache order", async () => {
    // The planner tokenizes before any normalization, so these two forms are not
    // interchangeable: `a\u0308b` is two one-letter tokens, `äb` is one two-letter token.
    const nfc = "\u00e4b";
    const nfd = "a\u0308b";
    for (const queryOrder of [[nfc, nfd], [nfd, nfc]] as const) {
      const { store } = decorate(realStore());
      const results = new Map<string, LexicalHit[]>();
      for (const query of queryOrder) results.set(query, await store.searchLexical(query, 8));
      expect(results.get(nfc)?.map((hit) => hit.passageId)).toEqual([2]);
      expect(results.get(nfd)).toEqual([]);
      await store.close();
    }
  });

  it("keeps the scope, limit and filter in the key", async () => {
    const inner = new FakeStore({ lexical: async () => hits, nearest: async () => [] });
    const { store } = decorate(inner);
    await store.searchLexical("deep", 4);
    await store.searchLexical("deep", 4, "book-a");
    await store.searchLexical("deep", 8);
    expect(inner.calls.lexical).toBe(3);
    await store.nearest(new Float32Array([1, 0]), 4, { bookIds: ["b", "a"] });
    await store.nearest(new Float32Array([1, 0]), 4, { bookIds: ["a", "b"] });
    expect(inner.calls.nearest).toBe(2);
  });

  it("admits only stages that cost at least the threshold", async () => {
    const clock = clockOf();
    const inner = new FakeStore({
      lexical: async () => {
        clock.advance(60);
        return hits;
      },
    });
    const store = new CachedPassageQueryStore(inner, {
      epoch: new IndexEpochCounter(), maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 50, quietMs: 0, now: clock.now,
    });
    await store.searchLexical("slow", 4);
    await store.searchLexical("slow", 4);
    expect(inner.calls.lexical).toBe(1);

    const fast = new FakeStore({
      lexical: async () => {
        clock.advance(5);
        return hits;
      },
    });
    const fastStore = new CachedPassageQueryStore(fast, {
      epoch: new IndexEpochCounter(), maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 50, quietMs: 0, now: clock.now,
    });
    await fastStore.searchLexical("fast", 4);
    await fastStore.searchLexical("fast", 4);
    expect(fast.calls.lexical).toBe(2);
  });

  it("expires entries after the TTL", async () => {
    const { store, clock, inner } = decorate(new FakeStore({ lexical: async () => hits }), { ttlMs: 1_000 });
    await store.searchLexical("expiring", 4);
    await store.searchLexical("expiring", 4);
    expect(inner.calls.lexical).toBe(1);
    clock.advance(1_001);
    await store.searchLexical("expiring", 4);
    expect(inner.calls.lexical).toBe(2);
  });

  it("invalidates on an epoch bump and refuses admission during the quiet window", async () => {
    const { store, epoch, clock, inner } = decorate(
      new FakeStore({ lexical: async () => hits }),
      { quietMs: 5_000 },
    );
    await store.searchLexical("indexed", 4);
    epoch.bump();
    await store.searchLexical("indexed", 4);
    await store.searchLexical("indexed", 4);
    // Both calls after the bump read the store: the first observes the new epoch and the
    // second is not admitted because the write is recent.
    expect(inner.calls.lexical).toBe(3);
    clock.advance(5_001);
    await store.searchLexical("indexed", 4);
    await store.searchLexical("indexed", 4);
    expect(inner.calls.lexical).toBe(4);
  });

  it("never stores a result whose read crossed an epoch change", async () => {
    const epoch = new IndexEpochCounter();
    let bumped = false;
    const inner = new FakeStore({
      lexical: async () => {
        if (!bumped) {
          bumped = true;
          epoch.bump();
        }
        return hits;
      },
    });
    const { store } = decorate(inner, { epoch });
    expect(await store.searchLexical("moving", 4)).toEqual(hits);
    await store.searchLexical("moving", 4);
    expect(inner.calls.lexical).toBe(2);
  });

  it("does not cache a nearest result whose read crossed an eligibility change", async () => {
    let release: ((value: ScoredPassage[]) => void) | undefined;
    let reads = 0;
    const inner = new FakeStore({
      nearest: () => {
        reads += 1;
        if (reads > 1) return Promise.resolve([{ passageId: 7, score: 1 }]);
        return new Promise<ScoredPassage[]>((resolve) => { release = resolve; });
      },
    });
    const { store, epoch } = decorate(inner);
    const pending = store.nearest(new Float32Array([1, 0]), 4, { maxVectors: 8 });
    epoch.bump();
    release?.([{ passageId: 7, score: 1 }]);
    expect(await pending).toEqual([{ passageId: 7, score: 1 }]);
    // The in-flight result was not admitted: the next call reads the store again.
    await store.nearest(new Float32Array([1, 0]), 4, { maxVectors: 8 });
    expect(inner.calls.nearest).toBe(2);
  });

  it("does not cache a rejection", async () => {
    let fail = true;
    const inner = new FakeStore({
      lexical: async () => {
        if (fail) throw new Error("worker timed out");
        return hits;
      },
    });
    const { store } = decorate(inner);
    await expect(store.searchLexical("retry", 4)).rejects.toThrow("worker timed out");
    fail = false;
    expect(await store.searchLexical("retry", 4)).toEqual(hits);
    expect(inner.calls.lexical).toBe(2);
  });

  it("shares one round-trip between concurrent identical misses", async () => {
    let release: ((value: LexicalHit[]) => void) | undefined;
    const inner = new FakeStore({
      lexical: () => new Promise<LexicalHit[]>((resolve) => { release = resolve; }),
    });
    const { store } = decorate(inner);
    const [first, second] = [store.searchLexical("shared", 4), store.searchLexical("shared", 4)];
    release?.(hits);
    expect(await first).toEqual(hits);
    expect(await second).toEqual(hits);
    expect(inner.calls.lexical).toBe(1);
  });

  it("caches the vector count for the whole epoch, even when it is cheap", async () => {
    let count = 10;
    const inner = new FakeStore({ vectorCount: async () => count });
    const { store, epoch } = decorate(inner);
    expect(await store.vectorCount()).toBe(10);
    count = 11;
    expect(await store.vectorCount()).toBe(10);
    expect(inner.calls.vectorCount).toBe(1);
    epoch.bump();
    expect(await store.vectorCount()).toBe(11);
    expect(inner.calls.vectorCount).toBe(2);
  });

  it("does not cache hydration and keeps the store closable", async () => {
    const views: PassageView[] = [{ passageId: 1, bookId: "b", bookTitle: "T", text: "x", page: null, section: null }];
    const inner = new FakeStore({ hydrate: async () => views });
    const { store } = decorate(inner);
    await store.hydrate([1]);
    await store.hydrate([1]);
    expect(inner.calls.hydrate).toBe(2);
    await store.close();
    expect(inner.closed).toBe(true);
  });

  it("bounds entries and bytes and reports only counters", async () => {
    const inner = new FakeStore({ lexical: async () => hits });
    const { store } = decorate(inner, { maxEntries: 2 });
    for (const term of ["one", "two", "three", "secretneedle"]) await store.searchLexical(term, 4);
    const stats = store.stats();
    expect(stats.entries).toBeLessThanOrEqual(2);
    expect(stats.maxEntries).toBe(2);
    expect(stats.usedBytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.hits + stats.misses).toBe(4);
    expect(JSON.stringify(stats)).not.toContain("secretneedle");
  });
});

describe("withSearchCache", () => {
  it("returns the inner store untouched when the cache is off", async () => {
    const inner = new FakeStore({ lexical: async () => hits });
    const store = withSearchCache(inner, null);
    expect(store).toBe(inner);
    await store.searchLexical("direct", 4);
    await store.searchLexical("direct", 4);
    expect(inner.calls.lexical).toBe(2);
  });
});

describe("QueryCache", () => {
  it("evicts the least recently used entry and accounts bytes", () => {
    let now = 0;
    const cache = new QueryCache<number>({ maxEntries: 2, maxBytes: 100, ttlMs: 1_000, now: () => now });
    cache.set("a", 1, 10);
    cache.set("b", 2, 20);
    expect(cache.get("a")).toBe(1); // a becomes recent
    cache.set("c", 3, 30);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.usedBytes).toBe(40);
    cache.set("too-big", 4, 101);
    expect(cache.get("too-big")).toBeUndefined();
    now = 1_001;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1); // "c" is also expired but only dropped when read
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
