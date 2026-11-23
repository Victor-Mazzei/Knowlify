import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import { SqlitePassageQueryStore } from "../src/adapters/storage/SqlitePassageQueryStore.js";
import { PassageSearch, PassageSearchDisabledError } from "../src/use-cases/PassageSearch.js";
import { ValidationError } from "../src/domain/errors.js";
import type { Book } from "../src/ports/index.js";
import type { EmbeddingsStatus, EmbedQueryOptions, IngestJob, IngestOutcome, IngestSink, IngestionRunner } from "../src/ports/knowledge.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); vi.restoreAllMocks(); });

const book = (id: string): Book => ({
  id, title: `Title ${id}`, author: "", format: "pdf", path: `/${id}.pdf`, cover_path: null,
  size: 10, added_at: 1, source_id: null, mtime: 1, status: "ready",
});
const passage = (ordinal: number, text: string, page: number | null = null, section: string | null = null) =>
  ({ ordinal, text, page, section });

class SearchRunner implements IngestionRunner {
  status: EmbeddingsStatus = { mode: "none", model: null, state: "off" };
  queryVector: Float32Array | null = new Float32Array([1, 0]);
  fail = false;
  async run(_job: IngestJob, _sink: IngestSink): Promise<IngestOutcome> { throw new Error("not used"); }
  async embedQuery(_text: string, _options?: EmbedQueryOptions): Promise<Float32Array | null> {
    if (this.fail) throw new Error("model unavailable");
    return this.queryVector;
  }
  embeddings(): EmbeddingsStatus { return this.status; }
  indexVersion(): string { return "1|none"; }
  onEmbeddingsReady(): void {}
  async close(): Promise<void> {}
}

function setup(options: { enabled?: boolean } = {}) {
  const db = openDb(":memory:");
  databases.push(db);
  const books = new SqliteBookRepository(db);
  const indexes = new SqliteBookIndexRepository(db);
  const passages = new SqlitePassageRepository(db);
  const vectors = new SqliteBlobVectorStore(db);
  const runner = new SearchRunner();
  const log = { info: vi.fn(), error: vi.fn() };
  const store = new SqlitePassageQueryStore(passages, vectors);
  const search = new PassageSearch(store, runner, books, indexes, { enabled: options.enabled ?? true }, log);
  return { db, books, indexes, passages, vectors, store, runner, log, search };
}

const markReady = (indexes: SqliteBookIndexRepository, id: string): void => {
  indexes.save({
    bookId: id, state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|none", fingerprint: null,
    chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
  });
};

describe("PassageSearch", () => {
  it("falls back to lexical search when embeddings are off", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.passages.append("book", [
      { passage: passage(0, "The quick brown fox", 1, "One"), vector: null },
      { passage: passage(1, "Another quick note", 2, null), vector: null },
    ]);
    const result = await x.search.search({ q: "quick", limit: 8 });
    expect(result.mode).toBe("lexical");
    expect(result.unavailable).toBe(false);
    expect(result.coverage).toEqual({ indexed: 1, total: 1 });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((hit) => hit.text)).toEqual(expect.arrayContaining(["The quick brown fox", "Another quick note"]));
    const fox = result.hits.find((hit) => hit.text === "The quick brown fox")!;
    expect(fox).toMatchObject({
      bookId: "book", bookTitle: "Title book",
      location: { page: 1, section: "One" },
    });
    expect(result.hits.map((hit) => hit.score)).toEqual([1, expect.any(Number)]);
  });

  it("merges lexical and vector rankings with RRF", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [
      { passage: passage(0, "text about indexing", 1, null), vector: new Float32Array([0.8, 0.6]) },
      { passage: passage(1, "indexing without the word", 2, null), vector: new Float32Array([1, 0]) },
    ]);
    const result = await x.search.search({ q: "indexing", limit: 8 });
    expect(result.mode).toBe("hybrid");
    // Passage 0 appears in both lists and wins; scores are normalized to the best hit.
    expect(result.hits[0]!.text).toBe("text about indexing");
    expect(result.hits[0]!.score).toBe(1);
    expect(result.hits.every((hit) => hit.score <= 1 && hit.score > 0)).toBe(true);
  });

  it("returns semantic hits when the query has no lexical match", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [{ passage: passage(0, "totally unrelated words", 3, null), vector: new Float32Array([1, 0]) }]);
    const result = await x.search.search({ q: "semantic query", limit: 8 });
    expect(result.mode).toBe("semantic");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.location).toEqual({ page: 3, section: null });
  });

  it("stays lexical when the embedder is ready but no vectors were stored", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [{ passage: passage(0, "lexical survivor", 1, null), vector: null }]);
    const result = await x.search.search({ q: "lexical", limit: 8 });
    expect(result.mode).toBe("lexical");
    expect(result.hits).toHaveLength(1);
  });

  it("falls back to lexical when the embedder throws", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.runner.fail = true;
    x.passages.append("book", [{ passage: passage(0, "resilient search", 1, null), vector: null }]);
    const result = await x.search.search({ q: "resilient", limit: 8 });
    expect(result.mode).toBe("lexical");
    expect(result.hits).toHaveLength(1);
    expect(x.log.error).toHaveBeenCalled();
  });

  it("degrades to lexical search when the embedder exceeds its ceiling", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    // A model load, a download or a busy ingestion worker can take minutes.
    x.runner.embedQuery = () => new Promise(() => {});
    x.search = new PassageSearch(x.store, x.runner, x.books, x.indexes, { enabled: true, embedTimeoutMs: 20 }, x.log);
    x.passages.append("book", [{ passage: passage(0, "secretneedle passage", 1, null), vector: null }]);

    const started = performance.now();
    const result = await x.search.search({ q: "secretneedle", limit: 8 });

    expect(result.mode).toBe("lexical");
    expect(result.hits).toHaveLength(1);
    expect(result.unavailable).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(x.log.error).toHaveBeenCalled();
    // Timeout diagnostics never carry the question, a passage or provider text.
    expect(JSON.stringify(x.log.error.mock.calls)).not.toContain("secretneedle");
  });

  it("aborts the embedding on timeout and recovers on the next search", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [{ passage: passage(0, "secretneedle passage", 1, null), vector: new Float32Array([1, 0]) }]);
    const signals: AbortSignal[] = [];
    x.runner.embedQuery = (_text: string, options?: EmbedQueryOptions) => new Promise<Float32Array | null>((resolve) => {
      if (options?.signal) {
        signals.push(options.signal);
        options.signal.addEventListener("abort", () => resolve(null), { once: true });
      }
    });
    x.search = new PassageSearch(x.store, x.runner, x.books, x.indexes, { enabled: true, embedTimeoutMs: 20 }, x.log);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await x.search.search({ q: "secretneedle", limit: 8 });
      expect(result.mode).toBe("lexical");
      expect(result.hits).toHaveLength(1);
    }
    // Every timeout actually aborted the request, so the runner can drop it instead of
    // completing abandoned work later.
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(x.log.error).toHaveBeenCalledTimes(3);

    x.runner.embedQuery = async () => new Float32Array([1, 0]);
    const recovered = await x.search.search({ q: "secretneedle", limit: 8 });
    expect(recovered.mode).toBe("hybrid");
    expect(recovered.hits).toHaveLength(1);
  });

  it("answers with fewer sources when the retrieval store fails", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.passages.append("book", [{ passage: passage(0, "unreachable passage", 1, null), vector: null }]);
    x.store.searchLexical = async () => { throw new Error("search worker timed out"); };

    const result = await x.search.search({ q: "unreachable", limit: 8 });

    expect(result.hits).toEqual([]);
    expect(result.mode).toBe("lexical");
    expect(result.unavailable).toBe(true);
    expect(x.log.error).toHaveBeenCalled();
  });

  it("marks a vector read failure as unavailable", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [{ passage: passage(0, "vector target", 1, null), vector: new Float32Array([1, 0]) }]);
    x.store.searchLexical = async () => [];
    x.store.nearest = async () => { throw new Error("search worker timed out"); };

    const result = await x.search.search({ q: "vector", limit: 8 });

    expect(result.hits).toEqual([]);
    expect(result.unavailable).toBe(true);
    expect(x.log.error).toHaveBeenCalled();
  });

  it("keeps lexical hits and flags a partial vector failure", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("book", [{ passage: passage(0, "lexical survivor", 1, null), vector: new Float32Array([1, 0]) }]);
    x.store.nearest = async () => { throw new Error("search worker timed out"); };

    const result = await x.search.search({ q: "lexical", limit: 8 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.text).toBe("lexical survivor");
    // The grounding is valid, but the state still records that a read was unavailable.
    expect(result.unavailable).toBe(true);
  });

  it("supports a single-character query only through the internal chat option", async () => {
    const x = setup();
    x.books.save(book("book"));
    markReady(x.indexes, "book");
    x.passages.append("book", [
      { passage: passage(0, "The R language for statistics", 1, null), vector: null },
      { passage: passage(1, "C++ templates and the C language", 2, null), vector: null },
      { passage: passage(2, "Chapter 7 covers vectors", 3, null), vector: null },
    ]);

    await expect(x.search.search({ q: "R", limit: 8 })).rejects.toThrow(ValidationError);

    const r = await x.search.search({ q: "R", limit: 8 }, { allowShortQuery: true });
    expect(r.hits.map((hit) => hit.text)).toContain("The R language for statistics");

    const seven = await x.search.search({ q: "7", limit: 8 }, { allowShortQuery: true });
    expect(seven.hits.map((hit) => hit.text)).toContain("Chapter 7 covers vectors");

    // A lowercase Latin single letter remains low signal and does not become a broad scan.
    const lowercase = await x.search.search({ q: "r", limit: 8 }, { allowShortQuery: true });
    expect(lowercase.hits).toEqual([]);
  });

  it("validates query length and limit boundaries", async () => {
    const x = setup();
    await expect(x.search.search({ q: " a ", limit: 8 })).rejects.toThrow(ValidationError);
    await expect(x.search.search({ q: "x".repeat(501), limit: 8 })).rejects.toThrow(ValidationError);
    const result = await x.search.search({ q: "ok", limit: 999 });
    expect(result.hits).toEqual([]);
  });

  it("restricts hits and coverage to one book", async () => {
    const x = setup();
    x.books.save(book("one")); x.books.save(book("two"));
    markReady(x.indexes, "one");
    x.passages.append("one", [{ passage: passage(0, "shared term", 1, null), vector: null }]);
    x.passages.append("two", [{ passage: passage(0, "shared term", 2, null), vector: null }]);
    const all = await x.search.search({ q: "shared", limit: 8 });
    expect(all.hits).toHaveLength(2);
    expect(all.coverage).toEqual({ indexed: 1, total: 2 });
    const filtered = await x.search.search({ q: "shared", limit: 8, bookId: "two" });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]!.bookId).toBe("two");
    expect(filtered.coverage).toEqual({ indexed: 0, total: 1 });
    const missing = await x.search.search({ q: "shared", limit: 8, bookId: "missing" });
    expect(missing.hits).toEqual([]);
    expect(missing.coverage).toEqual({ indexed: 0, total: 0 });
  });

  it("counts coverage without loading the whole library", async () => {
    const x = setup();
    x.books.save(book("one")); x.books.save(book("two"));
    markReady(x.indexes, "one");
    x.passages.append("one", [{ passage: passage(0, "needle", 1, null), vector: null }]);
    x.books.list = () => { throw new Error("coverage must not list books"); };
    const result = await x.search.search({ q: "needle", limit: 8 });
    expect(result.coverage).toEqual({ indexed: 1, total: 2 });
  });

  it("above the vector scan ceiling restricts hits to lexically matched books or a bounded sample", async () => {
    const x = setup();
    x.search = new PassageSearch(x.store, x.runner, x.books, x.indexes, {
      enabled: true, vectorScanMax: 1,
    });
    x.books.save(book("one")); x.books.save(book("two"));
    markReady(x.indexes, "one"); markReady(x.indexes, "two");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("one", [{ passage: passage(0, "alpha passage", 1, null), vector: new Float32Array([0, 1]) }]);
    x.passages.append("two", [{ passage: passage(0, "beta passage", 2, null), vector: new Float32Array([1, 0]) }]);

    const degraded = await x.search.search({ q: "alpha", limit: 8 });
    expect(degraded.mode).toBe("hybrid");
    // The lexical candidates are always scanned; the rotating stride sample may add the
    // other eligible book within the same ceiling budget.
    expect(degraded.hits.length).toBeGreaterThan(0);
    expect(degraded.hits.every((hit) => ["one", "two"].includes(hit.bookId))).toBe(true);

    // A question with no lexical overlap still gets a semantic hit: the bounded scan
    // samples books evenly (the rotating offset picks one of the two).
    const noLexical = await x.search.search({ q: "gamma", limit: 8 });
    expect(noLexical.mode).toBe("semantic");
    expect(noLexical.hits).toHaveLength(1);
    expect(["one", "two"]).toContain(noLexical.hits[0]!.bookId);

    const below = new PassageSearch(x.store, x.runner, x.books, x.indexes, {
      enabled: true, vectorScanMax: 100,
    });
    const semantic = await below.search({ q: "gamma", limit: 8 });
    expect(semantic.hits[0]!.bookId).toBe("two");
    expect(semantic.mode).toBe("semantic");
  });

  it("passes the scan ceiling as the vector budget when no lexical neighbourhood exists", async () => {
    const x = setup();
    x.search = new PassageSearch(x.store, x.runner, x.books, x.indexes, { enabled: true, vectorScanMax: 1 });
    x.books.save(book("one")); x.books.save(book("two"));
    markReady(x.indexes, "one"); markReady(x.indexes, "two");
    x.runner.status = { mode: "local", model: "m", state: "ready" };
    x.passages.append("one", [{ passage: passage(0, "unrelated text", 1, null), vector: new Float32Array([1, 0]) }]);
    x.passages.append("two", [{ passage: passage(0, "other text", 2, null), vector: new Float32Array([0, 1]) }]);
    let captured: unknown;
    const nearest = x.store.nearest.bind(x.store);
    x.store.nearest = async (query, limit, filter) => {
      captured = filter;
      return nearest(query, limit, filter);
    };

    await x.search.search({ q: "gamma", limit: 8 });

    expect(captured).toEqual({ maxVectors: 1 });
  });

  it("truncates passage text to 1200 characters", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.passages.append("book", [{ passage: passage(0, `needle ${"x".repeat(2_000)}`, null, null), vector: null }]);
    const result = await x.search.search({ q: "needle", limit: 8 });
    expect(result.hits[0]!.text).toHaveLength(1_200);
  });

  it("refuses search while indexing is off", async () => {
    const x = setup({ enabled: false });
    await expect(x.search.search({ q: "anything", limit: 8 })).rejects.toThrow(PassageSearchDisabledError);
  });
});
