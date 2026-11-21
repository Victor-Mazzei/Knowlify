import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import {
  SqliteBookIndexRepository,
  SqlitePassageRepository,
  toFtsQuery,
} from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import type { Book } from "../src/ports/index.js";
import type { Passage } from "../src/domain/knowledge/BookIndex.js";

const databases: Db[] = [];
const db = (): Db => {
  const database = openDb(":memory:");
  databases.push(database);
  return database;
};
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string, status: Book["status"] = "ready"): Book => ({
  id, title: `Title ${id}`, author: "Author", format: "pdf", path: `/${id}.pdf`,
  cover_path: null, size: 10, added_at: 1, source_id: null, mtime: 1, status,
});
const passage = (ordinal: number, text: string): Passage => ({ ordinal, text, page: ordinal + 1, section: ordinal === 0 ? "Intro" : null });
const vector = (...values: number[]): Float32Array => new Float32Array(values);

describe("knowledge migration", () => {
  it("upgrades a v3 database additively and keeps existing books", () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-v4-"));
    const path = join(root, "legacy.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE books (id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',format TEXT NOT NULL,
        path TEXT NOT NULL,cover_path TEXT,size INTEGER NOT NULL,added_at INTEGER NOT NULL,source_id TEXT,mtime INTEGER,
        status TEXT NOT NULL DEFAULT 'ready');
        INSERT INTO books VALUES ('book','Title','','pdf','/book.pdf',NULL,10,1,NULL,1,'ready');
        PRAGMA user_version = 3;`);
      legacy.close();
      const migrated = openDb(path);
      expect(migrated.pragma("user_version", { simple: true })).toBe(11);
      expect(new SqliteBookRepository(migrated).get("book")?.title).toBe("Title");
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name IN ('book_index','chunks','chunks_fts','chunk_vectors') ORDER BY name").all())
        .toEqual([{ name: "book_index" }, { name: "chunk_vectors" }, { name: "chunks" }, { name: "chunks_fts" }]);
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cascades book deletion through index rows, chunks, vectors and FTS", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const indexes = new SqliteBookIndexRepository(database);
    const passages = new SqlitePassageRepository(database);
    indexes.upsertPending({ bookId: "book", priority: 1, fingerprint: "10:1", now: 1, resetAttempts: false });
    passages.append("book", [{ passage: passage(0, "searchable content"), vector: vector(1, 0) }]);
    expect(passages.searchLexical("searchable", 5)).toHaveLength(1);

    database.prepare("DELETE FROM books WHERE id = ?").run("book");
    expect(indexes.get("book")).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM chunk_vectors").get()).toEqual({ n: 0 });
    expect(passages.searchLexical("searchable", 5)).toEqual([]);
  });
});

describe("SqliteBookIndexRepository", () => {
  it("claims the highest priority then the oldest request, atomically", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("low"));
    new SqliteBookRepository(database).save(book("high"));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.upsertPending({ bookId: "low", priority: 0, fingerprint: "10:1", now: 10, resetAttempts: false });
    indexes.upsertPending({ bookId: "high", priority: 1, fingerprint: "10:1", now: 20, resetAttempts: false });

    expect(indexes.claimNext(50)?.bookId).toBe("high");
    expect(indexes.get("high")).toMatchObject({ state: "indexing", startedAt: 50 });
    expect(indexes.claimNext(50)?.bookId).toBe("low");
    expect(indexes.claimNext(50)).toBeUndefined();
  });

  it("does not claim a retry before it is due and reports the next due time", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.upsertPending({ bookId: "book", priority: 0, fingerprint: "10:1", now: 10, resetAttempts: false });
    const claimed = indexes.claimNext(10)!;
    indexes.save({ ...claimed, state: "pending", nextAttemptAt: 100, startedAt: null });
    expect(indexes.claimNext(99)).toBeUndefined();
    expect(indexes.nextDueAt()).toBe(100);
    expect(indexes.claimNext(100)?.bookId).toBe("book");
  });

  it("resets attempts and the known hash on a forced reindex", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.save({
      bookId: "book", state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|none", fingerprint: "10:1",
      chunkCount: 3, attempts: 2, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 2, finishedAt: 3,
    });
    indexes.upsertPending({ bookId: "book", priority: 1, fingerprint: "10:2", now: 50, resetAttempts: true });
    expect(indexes.get("book")).toMatchObject({
      state: "pending", priority: 1, contentHash: null, fingerprint: "10:2", attempts: 0, chunkCount: 3, requestedAt: 50,
    });
  });

  it("resumes interrupted jobs, batches states and counts by state", () => {
    const database = db();
    for (const id of ["a", "b", "c"]) new SqliteBookRepository(database).save(book(id));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.upsertPending({ bookId: "a", priority: 0, fingerprint: null, now: 1, resetAttempts: false });
    indexes.upsertPending({ bookId: "b", priority: 0, fingerprint: null, now: 1, resetAttempts: false });
    indexes.claimNext(10);
    expect(indexes.counts().indexing).toBe(1);
    expect(indexes.resetInterrupted()).toBe(1);
    expect(indexes.counts().pending).toBe(2);
    expect(indexes.statesFor(["a", "b", "missing"]).size).toBe(2);
    expect(indexes.revision()).toBeGreaterThan(0);
  });

  it("requeues failed and ready rows and finds stale versions and unindexed books", () => {
    const database = db();
    for (const id of ["ready", "failed", "unindexed"]) new SqliteBookRepository(database).save(book(id));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.save({
      bookId: "ready", state: "ready", priority: 0, contentHash: "h", indexVersion: "1|none", fingerprint: null,
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    indexes.save({
      bookId: "failed", state: "error", priority: 0, contentHash: null, indexVersion: null, fingerprint: null,
      chunkCount: 0, attempts: 3, nextAttemptAt: 0, error: { code: "unknown", message: "x" }, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    expect(indexes.staleIds("1|none")).toEqual([]);
    expect(indexes.staleIds("2|none").sort()).toEqual(["ready"]);
    expect(indexes.unindexedReadyBookIds()).toEqual(["unindexed"]);
    expect(indexes.requeue("failed", 10)).toBe(1);
    expect(indexes.get("failed")).toMatchObject({ state: "pending", priority: 1, attempts: 0, error: null });
    expect(indexes.requeue("all", 20)).toBe(1);
    expect(indexes.counts()).toMatchObject({ pending: 2, ready: 0, error: 0 });
  });

  it("does not consider a lexical-by-choice version stale when a vector embedder appears", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    for (const id of ["lexical", "degraded", "vector"]) books.save(book(id));
    const indexes = new SqliteBookIndexRepository(database);
    const row = (bookId: string, indexVersion: string, chunkCount = 1) => ({
      bookId, state: "ready" as const, priority: 0 as const, contentHash: "h", indexVersion, fingerprint: null,
      chunkCount, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    indexes.save(row("lexical", "1|lexical"));
    indexes.save(row("degraded", "1|none", 3));
    expect(indexes.staleIds("1|http:model")).toEqual(["degraded"]);
    expect(indexes.staleIds("1|lexical").sort()).toEqual(["degraded"]);
    // A provider outage must not erase books that already have a complete vector index.
    indexes.save(row("vector", "1|http:model", 2));
    expect(indexes.staleIds("1|none")).toEqual([]);
    expect(indexes.staleIds("1|http:model")).toEqual(["degraded"]);
    expect(indexes.vectorBookCount()).toBe(1);
    indexes.save(row("degraded", "1|http:model", 3));
    expect(indexes.vectorBookCount()).toBe(2);
    expect(indexes.averageChunkCount()).toBe(2);
  });

  it("bulk-inserts pending rows in one transaction and keeps priority/fingerprint semantics", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    for (const id of ["a", "b", "c"]) books.save(book(id));
    const indexes = new SqliteBookIndexRepository(database);
    indexes.save({
      bookId: "a", state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|lexical", fingerprint: "10:1",
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    indexes.upsertPendingMany([
      { bookId: "a", priority: 1, fingerprint: "10:2", now: 10, resetAttempts: true },
      { bookId: "b", priority: 0, fingerprint: "10:1", now: 10, resetAttempts: false },
      { bookId: "c", priority: 0, fingerprint: null, now: 10, resetAttempts: false },
    ]);
    expect(indexes.get("a")).toMatchObject({
      state: "pending", priority: 1, contentHash: null, fingerprint: "10:2", attempts: 0, requestedAt: 10,
    });
    expect(indexes.counts().pending).toBe(3);
    expect(indexes.revision()).toBeGreaterThan(0);
  });
});

describe("SqlitePassageRepository", () => {
  it("keeps FTS in sync after append, clear and delete", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [
      { passage: passage(0, "Café com leite e pão"), vector: vector(1, 0) },
      { passage: { ordinal: 1, text: "Outro texto qualquer", page: null, section: null }, vector: null },
    ]);
    expect(passages.searchLexical("cafe", 5)).toHaveLength(1);
    expect(passages.searchLexical("pao", 5)).toHaveLength(1);
    expect(passages.searchLexical("texto", 5)[0]?.passageId).toBeGreaterThan(0);
    passages.clear("book");
    expect(passages.searchLexical("cafe", 5)).toEqual([]);
  });

  it("hydrates in the requested order with the book title", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [
      { passage: passage(0, "first"), vector: null },
      { passage: passage(1, "second"), vector: null },
    ]);
    const found = passages.searchLexical("first", 5);
    const id = found[0]!.passageId;
    const views = passages.hydrate([id]);
    expect(views).toEqual([{ passageId: id, bookId: "book", bookTitle: "Title book", text: "first", page: 1, section: "Intro" }]);
    expect(passages.hydrate([id, 999])).toHaveLength(1);
  });

  it("rejects arbitrary FTS syntax by tokenizing and quoting the query", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [{ passage: passage(0, "safe text"), vector: null }]);
    expect(toFtsQuery('" OR * NEAR( secret')).toBe('"or"* OR "near"* OR "secret"*');
    expect(() => passages.searchLexical('" OR * NEAR(', 5)).not.toThrow();
    expect(passages.searchLexical('" OR * NEAR(', 5)).toEqual([]);
  });

  it("restricts lexical search to one book", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("one")); books.save(book("two"));
    const passages = new SqlitePassageRepository(database);
    passages.append("one", [{ passage: passage(0, "shared word"), vector: null }]);
    passages.append("two", [{ passage: passage(0, "shared word too"), vector: null }]);
    expect(passages.searchLexical("shared", 10)).toHaveLength(2);
    expect(passages.searchLexical("shared", 10, "two")).toHaveLength(1);
  });
});

describe("SqliteBlobVectorStore", () => {
  it("returns the exact top-k by cosine and respects the book filter", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("one")); books.save(book("two"));
    const passages = new SqlitePassageRepository(database);
    passages.append("one", [
      { passage: passage(0, "x"), vector: vector(1, 0) },
      { passage: { ordinal: 1, text: "y", page: null, section: null }, vector: vector(0.6, 0.8) },
      { passage: { ordinal: 2, text: "z", page: null, section: null }, vector: vector(0, 1) },
    ]);
    passages.append("two", [{ passage: passage(0, "other"), vector: vector(1, 0) }]);
    const store = new SqliteBlobVectorStore(database);
    return store.nearest(vector(1, 0), 2, { bookId: "one" }).then((hits) => {
      expect(hits).toHaveLength(2);
      expect(hits[0]!.score).toBeCloseTo(1, 6);
      expect(hits[1]!.score).toBeCloseTo(0.6, 6);
      return store.nearest(vector(1, 0), 10, { bookId: "two" });
    }).then((filtered) => {
      expect(filtered).toHaveLength(1);
    });
  });

  it("counts vectors and restricts the scan to a lexical pre-filter selection", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("one")); books.save(book("two")); books.save(book("three"));
    const passages = new SqlitePassageRepository(database);
    passages.append("one", [{ passage: passage(0, "alpha"), vector: vector(0, 1) }]);
    passages.append("two", [{ passage: passage(1, "beta"), vector: vector(1, 0) }]);
    passages.append("three", [{ passage: passage(2, "gamma"), vector: vector(1, 0) }]);
    const store = new SqliteBlobVectorStore(database);
    expect(store.count()).toBe(3);

    const all = await store.nearest(vector(1, 0), 3);
    expect(all.map((hit) => hit.passageId)).toEqual([2, 3, 1]);
    const prefiltered = await store.nearest(vector(1, 0), 3, { bookIds: ["one", "three"] });
    expect(prefiltered).toHaveLength(2);
    expect(prefiltered[0]!.passageId).toBe(3);
    expect(prefiltered[1]!.passageId).toBe(1);
    expect(await store.nearest(vector(1, 0), 3, { bookIds: [] })).toEqual([]);
  });

  it("produces the same top-k as the readFloatLE reference implementation", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("book"));
    const passages = new SqlitePassageRepository(database);
    const values = [[0.1, 0.9], [0.9, 0.1], [0.5, 0.5], [-1, 0], [0.3, -0.7]];
    passages.append("book", values.map((value, ordinal) => ({
      passage: passage(ordinal, `passage ${ordinal}`),
      vector: new Float32Array(value),
    })));
    const reference = (query: Float32Array): { passageId: number; score: number }[] => {
      const rows = database.prepare("SELECT chunk_id, vec FROM chunk_vectors").all() as { chunk_id: number; vec: Buffer }[];
      return rows
        .map((row) => {
          let score = 0;
          for (let index = 0; index < query.length; index += 1) score += query[index]! * row.vec.readFloatLE(index * 4);
          return { passageId: row.chunk_id, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    };
    const store = new SqliteBlobVectorStore(database);
    const query = new Float32Array([0.6, 0.8]);
    const expected = reference(query);
    const actual = await store.nearest(query, 3);
    expect(actual.map((hit) => hit.passageId)).toEqual(expected.map((hit) => hit.passageId));
    actual.forEach((hit, index) => expect(hit.score).toBeCloseTo(expected[index]!.score, 12));
  });

  it("ignores vectors from a different dimension", async () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [
      { passage: passage(0, "two dims"), vector: vector(1, 0) },
      { passage: passage(1, "three dims"), vector: vector(1, 0, 0) },
    ]);
    const hits = await new SqliteBlobVectorStore(database).nearest(vector(1, 0, 0), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeCloseTo(1, 6);
  });
});
