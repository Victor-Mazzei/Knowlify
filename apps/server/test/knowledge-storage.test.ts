import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import {
  SqliteBookIndexRepository,
  SqlitePassageRepository,
  toFtsPlan,
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
    expect(toFtsQuery('" OR * NEAR( secret')).toBe('"near"* OR "secret"*');
    expect(() => passages.searchLexical('" OR * NEAR(', 5)).not.toThrow();
    expect(passages.searchLexical('" OR * NEAR(', 5)).toEqual([]);
  });

  it("drops stopwords and short prefixes but keeps significant short terms", () => {
    // English/Portuguese/Spanish stopwords and question scaffolding carry no ranking signal.
    expect(toFtsQuery("a o the focus")).toBe('"focus"*');
    expect(toFtsQuery("a o e")).toBe("");
    expect(toFtsQuery("à é deep")).toBe('"deep"*');
    expect(toFtsQuery("de la the attention")).toBe('"attention"*');
    // Prefix matching starts at three characters; two-character terms are exact.
    expect(toFtsQuery("Go")).toBe('"go"');
    expect(toFtsQuery("attention")).toBe('"attention"*');
    expect(toFtsQuery("C++")).toBe('"c"');
    expect(toFtsQuery("R")).toBe('"r"');
    expect(toFtsQuery("Chapter 7")).toBe('"chapter"* OR "7"');
    // Numbers are exact identifiers even when they are three or more digits.
    expect(toFtsQuery("42")).toBe('"42"');
    expect(toFtsQuery("1990")).toBe('"1990"');
    // Sentence-initial articles and pronouns stay out even when capitalized.
    expect(toFtsQuery("A novel approach")).toBe('"novel"* OR "approach"*');
    expect(toFtsQuery("B C D F G H")).toBe('"b" OR "c" OR "d" OR "f"');
    expect(toFtsQuery("R r r")).toBe('"r"');
  });

  it("plans AND of all informative terms plus the rare OR union by df", () => {
    const plan = (q: string, values: Record<string, number>, totalRows = 1000) =>
      toFtsPlan(q, { documentFrequency: (text) => values[text] ?? 0, totalRows });

    const english = plan("How does deep work relate to attention and focus?", {
      deep: 500, work: 480, attention: 600, focus: 550,
    });
    expect(english.terms).toBe(4);
    expect(english.rare).toBe(0);
    expect(english.primary).toBe('"deep"* AND "work"* AND "attention"* AND "focus"*');
    expect(english.fallback).toBe('"work"* OR "deep"* OR "focus"*');

    // Portuguese stopwords/scaffolding: foco, atenção, leitura.
    const portuguese = plan("Como o foco e a atenção se relacionam com a leitura?", {
      foco: 500, atencao: 600, leitura: 550,
    });
    expect(portuguese.primary).toBe('"foco"* AND "atenção"* AND "leitura"*');
    expect(portuguese.fallback).toBe('"foco"* OR "leitura"* OR "atenção"*');

    // Spanish stopwords/scaffolding: memoria, aprendizaje.
    const spanish = plan("¿Cómo se relaciona la memoria con el aprendizaje?", {
      memoria: 500, aprendizaje: 600,
    });
    expect(spanish.primary).toBe('"memoria"* AND "aprendizaje"*');
    expect(spanish.fallback).toBe('"memoria"* OR "aprendizaje"*');

    // "connect" is content and rare: it enters the union's rare OR.
    const connect = plan("How do memory and learning connect?", {
      memory: 500, learning: 450, connect: 2,
    });
    expect(connect.rare).toBe(1);
    expect(connect.primary).toBe('("memory"* AND "learning"* AND "connect"*) OR ("connect"*)');
    expect(connect.fallback).toBeUndefined();

    // A single short entity stays exact and is in the rare OR; a common entity would be
    // in the AND only (df protection).
    const entity = plan("How do C++ templates improve memory performance?", {
      c: 10, templates: 550, improve: 480, memory: 500, performance: 600,
    });
    expect(entity.primary).toContain('"c"');
    expect(entity.primary).toContain('OR ("c")');
    expect(entity.fallback).toBeUndefined();

    // Two rare entities are covered by the rare OR even though the AND requires them both.
    const comparison = plan("How do C++ and R compare on statistics and plotting?", {
      c: 10, r: 12, statistics: 900, plotting: 850,
    });
    expect(comparison.rare).toBe(2);
    expect(comparison.primary).toContain('("c" OR "r")');
    expect(comparison.primary).toContain('"c" AND "r" AND "statistics"* AND "plotting"*');
    expect(comparison.fallback).toBeUndefined();

    // Short questions use the same rule when df is available.
    const short = plan("Go concurrency channels", { go: 1, concurrency: 10, channels: 50 });
    expect(short.primary).toBe('("go" AND "concurrency"* AND "channels"*) OR ("go" OR "concurrency"*)');
    expect(short.fallback).toBeUndefined();

    // The fifth passage fixture: memory/learning/neuroscience are rare, attention common.
    const fifth = plan("Explain how attention and memory affect learning in neuroscience", {
      attention: 64, memory: 1, learning: 1, neuroscience: 4,
    }, 260);
    expect(fifth.rare).toBe(3);
    expect(fifth.primary).toContain('"attention"* AND "memory"* AND "learning"* AND "neuroscience"*');
    expect(fifth.primary).toContain('("memory"* OR "learning"* OR "neuroscience"*)');
    expect(fifth.primary).not.toContain('"attention"* OR');
    expect(fifth.fallback).toBeUndefined();

    // Absent terms are dropped instead of poisoning the AND.
    const absent = plan("zebraquantum attention", { attention: 600 }, 1000);
    expect(absent.primary).toBe('"attention"*');
    expect(absent.terms).toBe(1);

    // Significant single-character/alphanumeric terms stay exact with df. A common
    // single term is still searched (it is the AND), but it never becomes a broad OR:
    // it would only be in the fallback when the primary is sparse (the documented limit).
    expect(plan("C", { c: 1000 }).primary).toBe('"c"');
    expect(plan("R", { r: 1 }).primary).toBe('"r"');
    expect(plan("7", { "7": 1 }).primary).toBe('"7"');
    expect(plan("C++", { c: 1 }).primary).toBe('"c"');
    expect(plan("C#", { c: 1 }).primary).toBe('"c"');
    expect(plan("Go", { go: 1 }).primary).toBe('"go"');
    const commonEntity = plan("C++ performance", { c: 700, performance: 800 });
    expect(commonEntity.primary).toBe('"c" AND "performance"*');
    expect(commonEntity.fallback).toBe('"c" OR "performance"*');

    // Ten terms maximum, but significant short terms and numbers are preserved.
    const crowdedValues: Record<string, number> = { c: 10, "7": 1 };
    for (const [index, term] of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike"].entries()) {
      crowdedValues[term] = 300 + index;
    }
    const crowded = plan(
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike C 7",
      crowdedValues,
    );
    expect(crowded.terms).toBe(10);
    expect(crowded.primary).toContain('("c" OR "7")');
    expect(crowded.fallback).toBeUndefined();
  });

  it("keeps the differently-worded fifth passage via the rare OR union", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    const items = [];
    for (let index = 0; index < 60; index += 1) {
      items.push({ passage: passage(index, `attention library note ${index}`), vector: null });
    }
    for (let index = 60; index < 200; index += 1) {
      items.push({ passage: passage(index, `neutral library note ${index}`), vector: null });
    }
    for (let index = 0; index < 4; index += 1) {
      items.push({ passage: passage(200 + index, `neuroscience attention study ${index}`), vector: null });
    }
    items.push({ passage: passage(204, "memory learning consolidate during sleep"), vector: null });
    passages.append("book", items);

    const question = "Explain how attention and memory affect learning in neuroscience";
    const hits = passages.searchLexical(question, 10);
    const texts = passages.hydrate(hits.map((hit) => hit.passageId)).map((view) => view.text);
    expect(texts).toHaveLength(5);
    expect(texts).toContain("memory learning consolidate during sleep");
    expect(texts.filter((text) => text.startsWith("neuroscience attention"))).toHaveLength(4);
  });

  it("does not fall back to common terms when rare hits are below five", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    const items = [];
    for (let index = 0; index < 60; index += 1) {
      items.push({ passage: passage(index, `attention library note ${index}`), vector: null });
    }
    for (let index = 60; index < 200; index += 1) {
      items.push({ passage: passage(index, `neutral library note ${index}`), vector: null });
    }
    for (let index = 0; index < 4; index += 1) {
      items.push({ passage: passage(200 + index, `neuroscience attention study ${index}`), vector: null });
    }
    passages.append("book", items);

    const hits = passages.searchLexical("attention neuroscience", 10);
    // Rare neuroscience returns four hits; the 60 attention-only passages must not be ORed.
    expect(hits).toHaveLength(4);
    const texts = passages.hydrate(hits.map((hit) => hit.passageId)).map((view) => view.text);
    expect(texts.every((text) => text.startsWith("neuroscience attention"))).toBe(true);
  });

  it("returns the dense AND match without a common-term OR", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    const question = "how attention reading memory habit works";
    passages.append("book", [
      ...Array.from({ length: 5 }, (_, index) => ({
        passage: passage(index, `attention and reading together ${index}`),
        vector: null,
      })),
      { passage: passage(5, "attention without the other term"), vector: null },
    ]);
    const texts = passages.searchLexical(question, 10)
      .map((hit) => passages.hydrate([hit.passageId])[0]!.text);
    expect(texts).toHaveLength(5);
    expect(texts.every((text) => text.includes("together"))).toBe(true);
  });

  it("drops absent terms and searches the present one", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [{ passage: passage(0, "attention without the rare terms"), vector: null }]);
    const question = "how do zebraquantum and photolithography relate to attention";
    const hits = passages.searchLexical(question, 5);
    expect(passages.hydrate(hits.map((hit) => hit.passageId)).map((view) => view.text))
      .toEqual(["attention without the rare terms"]);
  });

  it("uses the three-term OR only when no terms are rare and the AND is empty", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    const items = [];
    for (let index = 0; index < 5; index += 1) {
      items.push({ passage: passage(index, `attention reading pair ${index}`), vector: null });
      items.push({ passage: passage(10 + index, `attention memory pair ${index}`), vector: null });
      items.push({ passage: passage(20 + index, `reading memory pair ${index}`), vector: null });
    }
    passages.append("book", items);
    // No passage contains all three; the AND is empty and the terms are common, so the
    // documented three-term OR exception runs.
    const question = "how attention reading memory works";
    expect(passages.searchLexical(question, 20).length).toBe(15);
  });

  it("finds single-character languages, grades and symbols without prefix widening", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [
      { passage: passage(0, "C++ templates compile at build time"), vector: null },
      { passage: passage(1, "The R language for statistics"), vector: null },
      { passage: passage(2, "Chapter 7 covers vectors"), vector: null },
      { passage: passage(3, "Cats and dogs sleep"), vector: null },
      { passage: passage(4, "Go language concurrency uses goroutines"), vector: null },
      { passage: passage(5, "Good practices help every project"), vector: null },
    ]);
    const texts = (q: string): string[] =>
      passages.searchLexical(q, 5).map((hit) => passages.hydrate([hit.passageId])[0]!.text);

    expect(texts("C++")).toEqual(["C++ templates compile at build time"]);
    expect(texts("R")).toEqual(["The R language for statistics"]);
    expect(texts("7")).toEqual(["Chapter 7 covers vectors"]);
    // Two-character terms are exact now: "Go" no longer expands to "Good".
    expect(texts("Go")).toEqual(["Go language concurrency uses goroutines"]);
    // Exact matching: the C token finds C++ but not "Cats"; the prefix still works for words.
    expect(texts("C")).toEqual(["C++ templates compile at build time"]);
    expect(texts("cat")).toEqual(["Cats and dogs sleep"]);
  });

  it("invalidates the df cache after its own append", () => {
    const database = db();
    new SqliteBookRepository(database).save(book("book"));
    const passages = new SqlitePassageRepository(database);
    passages.append("book", [{ passage: passage(0, "attention"), vector: null }]);
    expect(passages.searchLexical("neuroscience", 5)).toEqual([]);
    passages.append("book", [{ passage: passage(1, "neuroscience note"), vector: null }]);
    expect(passages.searchLexical("neuroscience", 5)).toHaveLength(1);
  });

  it("returns the same ranking as the explicit chunks join", () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    books.save(book("one")); books.save(book("two"));
    const passages = new SqlitePassageRepository(database);
    passages.append("one", [
      { passage: passage(0, "deep work and attention"), vector: null },
      { passage: passage(1, "deep focus practice"), vector: null },
    ]);
    passages.append("two", [
      { passage: passage(2, "attention without the other term"), vector: null },
    ]);
    const match = toFtsQuery("deep");
    const reference = database.prepare(`
      SELECT c.id AS passageId, bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(match, 5);
    expect(passages.searchLexical("deep", 5)).toEqual(reference);
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

  it("bounds an unrestricted scan to an evenly spread sample and keeps the exact result below it", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    const passages = new SqlitePassageRepository(database);
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) {
      books.save(book(id));
      passages.append(id, [
        { passage: passage(0, `${id} aligned`), vector: vector(1, 0) },
        { passage: passage(1, `${id} orthogonal`), vector: vector(0, 1) },
      ]);
    }
    const store = new SqliteBlobVectorStore(database, { epoch: () => 0 });
    const booksOf = (hits: { passageId: number }[]): string[] =>
      [...new Set(passages.hydrate(hits.map((hit) => hit.passageId)).map((view) => view.bookId))].sort();

    const exact = await store.nearest(vector(1, 0), 10);
    expect(exact).toHaveLength(8);
    expect(booksOf(exact)).toEqual(ids);

    // Eight vectors over four books with a budget of four: every other book is read,
    // two hits each, so the cost is capped without concentrating on the first books.
    const sampled = await store.nearest(vector(1, 0), 10, { maxVectors: 4 });
    expect(sampled).toHaveLength(4);
    expect(booksOf(sampled)).toEqual(["a", "c"]);

    // The fallback book list uses the chunk_vectors_book index, not a full table scan.
    const plan = database.prepare(
      "EXPLAIN QUERY PLAN SELECT DISTINCT book_id FROM chunk_vectors ORDER BY book_id LIMIT 10",
    ).all();
    expect(JSON.stringify(plan)).toContain("chunk_vectors_book");

    // An index that already fits the budget is scanned exactly.
    const withinBudget = await store.nearest(vector(1, 0), 10, { maxVectors: 8 });
    expect(withinBudget).toEqual(exact);
  });

  it("reaches a high-id eligible book through the rotating stride sample", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    const indexes = new SqliteBookIndexRepository(database);
    const passages = new SqlitePassageRepository(database);
    const count = 2_100;
    let highChunkId = 0;
    for (let index = 0; index < count; index += 1) {
      const id = `book-${String(index).padStart(4, "0")}`;
      books.save(book(id));
      indexes.save({
        bookId: id, state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|local:test",
        fingerprint: null, chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null,
        requestedAt: 1, startedAt: 1, finishedAt: 2,
      });
      passages.append(id, [{
        passage: passage(0, `vector ${index}`),
        vector: index === count - 1 ? vector(1, 0) : vector(0, 1),
      }]);
      if (index === count - 1) {
        highChunkId = (database.prepare("SELECT id FROM chunks WHERE book_id = ?").get(id) as { id: number }).id;
      }
    }
    // 2,100 books, 2,100 vectors, budget 100 -> 100 sampled books, stride 21. Epoch 20
    // starts at index 20 and lands on 20 + 99 * 21 = 2,099, the high-id book.
    const store = new SqliteBlobVectorStore(database, { epoch: () => 20 });
    const hits = await store.nearest(vector(1, 0), 5, { maxVectors: 100 });
    expect(hits[0]?.passageId).toBe(highChunkId);
    expect(hits[0]?.score).toBeCloseTo(1, 6);
  });

  it("adds a stride sample to lexical candidates while respecting the budget", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    const indexes = new SqliteBookIndexRepository(database);
    const passages = new SqlitePassageRepository(database);
    const ids = ["a", "b", "c", "d"];
    let highChunkId = 0;
    for (const id of ids) {
      books.save(book(id));
      indexes.save({
        bookId: id, state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|local:test",
        fingerprint: null, chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null,
        requestedAt: 1, startedAt: 1, finishedAt: 2,
      });
      passages.append(id, [{ passage: passage(0, `${id} vector`), vector: id === "d" ? vector(1, 0) : vector(0, 1) }]);
      if (id === "d") highChunkId = (database.prepare("SELECT id FROM chunks WHERE book_id = ?").get(id) as { id: number }).id;
    }
    // Epoch 1 starts at index 1: the stride sample picks b and d; lexical candidates are a.
    const store = new SqliteBlobVectorStore(database, { epoch: () => 1 });
    const hits = await store.nearest(vector(1, 0), 5, {
      bookIds: ["a"], includeSample: true, maxVectors: 3,
    });
    expect(hits[0]?.passageId).toBe(highChunkId);
  });

  it("uses book_index and the cached count for a sampled scan", async () => {
    const database = db();
    const books = new SqliteBookRepository(database);
    const indexes = new SqliteBookIndexRepository(database);
    const passages = new SqlitePassageRepository(database);
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) {
      books.save(book(id));
      indexes.save({
        bookId: id, state: "ready", priority: 0, contentHash: "hash", indexVersion: "1|local:test",
        fingerprint: null, chunkCount: 2, attempts: 0, nextAttemptAt: 0, error: null,
        requestedAt: 1, startedAt: 1, finishedAt: 2,
      });
      passages.append(id, [
        { passage: passage(0, `${id} aligned`), vector: vector(1, 0) },
        { passage: passage(1, `${id} orthogonal`), vector: vector(0, 1) },
      ]);
    }
    const store = new SqliteBlobVectorStore(database, { epoch: () => 0 });
    const count = vi.spyOn(store, "count");
    const hits = await store.nearest(vector(1, 0), 10, { maxVectors: 4 });

    expect(hits).toHaveLength(4);
    expect(count).toHaveBeenCalled();
    // The book list comes from the small book_index table, in book order.
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT book_id FROM book_index ORDER BY book_id LIMIT 10").all();
    expect(JSON.stringify(plan)).toContain("book_index");
  });

  it("caches the vector count per data_version on a connection that does not write", () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-vector-count-"));
    const path = join(root, "count.db");
    const writer = openDb(path);
    let reader: Database.Database | undefined;
    try {
      new SqliteBookRepository(writer).save(book("book"));
      reader = new Database(path, { readonly: true });
      const store = new SqliteBlobVectorStore(reader, { cacheCount: true });
      const passages = new SqlitePassageRepository(writer);

      expect(store.count()).toBe(0);
      passages.append("book", [{ passage: passage(0, "one"), vector: vector(1, 0) }]);
      expect(store.count()).toBe(1);
      expect(store.count()).toBe(1);
      passages.append("book", [{ passage: passage(1, "two"), vector: vector(0, 1) }]);
      expect(store.count()).toBe(2);
      // A cascade delete by the writer must invalidate the cached count too.
      writer.prepare("DELETE FROM books WHERE id = ?").run("book");
      expect(store.count()).toBe(0);
    } finally {
      reader?.close();
      writer.close();
      rmSync(root, { recursive: true, force: true });
    }
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
