import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IndexEpochCounter } from "../src/adapters/runtime/IndexEpochCounter.js";
import { CachedPassageQueryStore } from "../src/adapters/search/CachedPassageQueryStore.js";
import { SearchWorkerStore } from "../src/adapters/search/SearchWorkerStore.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import {
  SqliteBookIndexRepository,
  SqlitePassageRepository,
} from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import { SqlitePassageQueryStore } from "../src/adapters/storage/SqlitePassageQueryStore.js";
import {
  failure,
  unchanged,
  type BookIndex,
  type IndexState,
  type Passage,
} from "../src/domain/knowledge/BookIndex.js";
import type { Book } from "../src/ports/index.js";

const databases: Db[] = [];
const readers: Database.Database[] = [];
const stores: SearchWorkerStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const reader of readers.splice(0)) reader.close();
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const clockOf = () => {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => { value += ms; },
  };
};

const book = (id: string): Book => ({
  id, title: `Title ${id}`, author: "", format: "pdf", path: `/library/${id}.pdf`,
  cover_path: null, size: 10, added_at: 1, source_id: null, mtime: 1, status: "ready",
});

const passage = (ordinal: number, text: string): Passage => ({
  ordinal, text, page: ordinal + 1, section: null,
});

const indexRow = (bookId: string, state: IndexState, chunkCount: number): BookIndex => ({
  bookId, state, priority: 0, contentHash: "hash", indexVersion: "1|local:test",
  fingerprint: null, chunkCount, attempts: 0, nextAttemptAt: 0, error: null,
  requestedAt: 1, startedAt: state === "ready" ? 1 : 2, finishedAt: state === "ready" ? 2 : null,
});

function inMemoryIndex() {
  const db = openDb(":memory:");
  databases.push(db);
  const epoch = new IndexEpochCounter();
  return {
    db,
    epoch,
    books: new SqliteBookRepository(db),
    indexes: new SqliteBookIndexRepository(db, epoch),
    passages: new SqlitePassageRepository(db, epoch),
    vectors: new SqliteBlobVectorStore(db, { epoch: () => epoch.current() }),
  };
}

function seedFileBook(db: Db, id: string, vector: number[]): number {
  db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES (?,?,'A','pdf',?,1,1,'src',1,'ready')`).run(id, `Title ${id}`, `/${id}.pdf`);
  db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
    VALUES (?,'ready',0,1,1,'1|local:test')`).run(id);
  const chunkId = Number(db.prepare(
    "INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES (?,0,?,1,NULL)",
  ).run(id, `${id} text`).lastInsertRowid);
  db.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (?,?,?)")
    .run(chunkId, id, Buffer.from(new Float32Array(vector).buffer));
  return chunkId;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-search-cache-epoch-"));
  roots.push(root);
  return root;
}

function tempDatabaseFile(): { root: string; path: string; writer: Db } {
  const root = tempRoot();
  const path = join(root, "index.db");
  const writer = openDb(path);
  databases.push(writer);
  return { root, path, writer };
}

const incident = "extern C declaration definition function block scope memory code program";

function seedFileLexical(db: Db, text: (ordinal: number) => string, chunks: number): void {
  db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES ('book','Book','A','pdf','/book.pdf',1,1,'src',1,'ready')`).run();
  db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
    VALUES ('book','ready',0,?,1,'1|lexical')`).run(chunks);
  const insert = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES ('book',?,?,1,NULL)");
  for (let ordinal = 0; ordinal < chunks; ordinal += 1) insert.run(ordinal, text(ordinal));
}

describe("CachedPassageQueryStore epoch invalidation", () => {
  it("drops a cached vector sample when a book becomes eligible after the quiet window", async () => {
    const x = inMemoryIndex();
    x.books.save(book("a"));
    x.books.save(book("b"));
    const clock = clockOf();
    const inner = new SqlitePassageQueryStore(x.passages, x.vectors);
    const uncached = new SqlitePassageQueryStore(x.passages, x.vectors);
    const cached = new CachedPassageQueryStore(inner, {
      epoch: x.epoch, maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 0, quietMs: 5_000, now: clock.now,
    });

    // The cache is live while indexing writes arrive; its quiet window starts when it
    // observes the append/save epoch below.
    x.passages.append("a", [
      { passage: passage(0, "a one"), vector: new Float32Array([0, 1]) },
      { passage: passage(1, "a two"), vector: new Float32Array([0, 1]) },
    ]);
    x.passages.append("b", [
      { passage: passage(0, "b one"), vector: new Float32Array([1, 0]) },
      { passage: passage(1, "b two"), vector: new Float32Array([0, 1]) },
    ]);
    x.indexes.save(indexRow("a", "ready", 2));
    x.indexes.save(indexRow("b", "indexing", 2));
    await cached.vectorCount();
    clock.advance(5_001);

    const query = new Float32Array([1, 0]);
    const filter = { maxVectors: 2 };
    const first = await cached.nearest(query, 5, filter);
    expect(first).toEqual(await uncached.nearest(query, 5, filter));
    expect(first.every((hit) => hit.score === 0)).toBe(true);
    expect(cached.stats().entries).toBeGreaterThan(0);

    clock.advance(1);
    // The runner took more than five seconds to promote the finished append, and the
    // promotion changes the eligible book list without touching chunk_vectors.
    x.indexes.save(indexRow("b", "ready", 2));

    const second = await cached.nearest(query, 5, filter);
    expect(second).toEqual(await uncached.nearest(query, 5, filter));
    expect(second).not.toEqual(first);
    expect(second[0]?.score).toBeCloseTo(1, 6);
  });

  it("drops a cached vector sample when a book leaves the list after a failed job", async () => {
    const x = inMemoryIndex();
    for (const id of ["a", "b", "c", "d"]) {
      x.books.save(book(id));
      x.passages.append(id, [{
        passage: passage(0, `${id} vector`),
        vector: new Float32Array(id === "a" ? [1, 0] : [0, 1]),
      }]);
      x.indexes.save(indexRow(id, "ready", 1));
    }
    const clock = clockOf();
    const uncached = new SqlitePassageQueryStore(x.passages, x.vectors);
    const cached = new CachedPassageQueryStore(new SqlitePassageQueryStore(x.passages, x.vectors), {
      epoch: x.epoch, maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 0, quietMs: 0, now: clock.now,
    });
    const query = new Float32Array([1, 0]);
    const filter = { maxVectors: 1 };

    const first = await cached.nearest(query, 5, filter);
    expect(first.map((hit) => hit.score)).toEqual([1]);
    expect(cached.stats().entries).toBeGreaterThan(0);

    x.indexes.save(failure(x.indexes.get("a")!, "no_text", "no text", 2));

    const second = await cached.nearest(query, 5, filter);
    expect(second).toEqual(await uncached.nearest(query, 5, filter));
    expect(second).not.toEqual(first);
  });

  it("does not rotate the sample or drop the cache on an unrelated commit from another connection", async () => {
    const { path, writer } = tempDatabaseFile();
    const chunkIds = ["book-0", "book-1", "book-2", "book-3"].map((id, index) =>
      seedFileBook(writer, id, index === 0 ? [1, 0] : [0, 1]),
    );
    const probe = new Database(path, { readonly: true });
    readers.push(probe);

    const epoch = new IndexEpochCounter();
    const worker = new SearchWorkerStore({ file: path, epoch });
    stores.push(worker);
    const cached = new CachedPassageQueryStore(worker, {
      epoch, maxEntries: 8, maxBytes: 1_000_000, admissionMs: 0, quietMs: 0,
    });
    const query = new Float32Array([1, 0]);
    const filter = { maxVectors: 1 };

    const first = await cached.nearest(query, 5, filter);
    expect(first.map((hit) => hit.passageId)).toEqual([chunkIds[0]!]);
    expect(cached.stats().entries).toBeGreaterThan(0);

    // A reader that still derives the offset from data_version rotates on any commit;
    // this proves the scenario detects the old behavior.
    const legacy = new SqliteBlobVectorStore(probe, {
      cacheCount: true,
      epoch: () => probe.pragma("data_version", { simple: true }) as number,
    });
    const legacyBefore = await legacy.nearest(query, 5, filter);
    writer.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('unrelated', '1')").run();
    const legacyAfter = await legacy.nearest(query, 5, filter);
    expect(legacyAfter).not.toEqual(legacyBefore);

    const cachedAgain = await cached.nearest(query, 5, filter);
    const fresh = await worker.nearest(query, 5, filter);
    expect(cachedAgain).toEqual(first);
    expect(fresh).toEqual(first);
  });

  it("keeps concurrent worker vector scans on their captured epoch", async () => {
    const { path, writer } = tempDatabaseFile();
    for (const [index, id] of ["book-0", "book-1", "book-2", "book-3"].entries()) {
      seedFileBook(writer, id, index === 0 ? [1, 0] : [0, 1]);
    }
    const epoch = new IndexEpochCounter();
    const worker = new SearchWorkerStore({ file: path, epoch });
    stores.push(worker);
    const query = new Float32Array([1, 0]);
    const filter = { maxVectors: 1 };

    const atZero = worker.nearest(query, 5, filter);
    epoch.bump();
    const atOne = worker.nearest(query, 5, filter);
    const [zero, one] = await Promise.all([atZero, atOne]);

    const memory = new SqliteBlobVectorStore(writer);
    expect(zero).toEqual(await memory.nearest(query, 5, filter, 0));
    expect(one).toEqual(await memory.nearest(query, 5, filter, 1));
    expect(zero).not.toEqual(one);
  });
});

describe("CachedPassageQueryStore completeness admission", () => {
  it("does not cache a real worker result that skipped the full plan", async () => {
    const { path, writer } = tempDatabaseFile();
    seedFileLexical(writer, (ordinal) => `${incident} passage ${ordinal}`, 200);
    const epoch = new IndexEpochCounter();
    // The short worker ceiling forces the cheap layer and skips the full pass.
    const worker = new SearchWorkerStore({ file: path, epoch, timeoutMs: 500 });
    stores.push(worker);

    const direct = await worker.searchLexicalResult(incident, 10);
    expect(direct.complete).toBe(false);

    const spy = vi.spyOn(worker, "searchLexicalResult");
    let tick = 0;
    const cached = new CachedPassageQueryStore(worker, {
      epoch, maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 50, quietMs: 0, now: () => { tick += 60; return tick; },
    });
    // The fake clock makes the read look slower than the 50 ms threshold; only
    // completeness may keep it out of the cache.
    await cached.searchLexical(incident, 10);
    expect(cached.stats().entries).toBe(0);

    await cached.searchLexical(incident, 10);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(cached.stats().entries).toBe(0);
  });

  it("does not cache a lexical read that timed out", async () => {
    const root = tempRoot();
    const workerPath = join(root, "stuck.worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort.on("message", () => {});',
    ].join("\n"));
    const epoch = new IndexEpochCounter();
    const worker = new SearchWorkerStore({
      file: join(root, "unused.db"), workerPath, timeoutMs: 50,
    });
    stores.push(worker);
    let tick = 0;
    const cached = new CachedPassageQueryStore(worker, {
      epoch, maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 0, quietMs: 0, now: () => { tick += 60; return tick; },
    });

    await expect(cached.searchLexical("secretneedle", 4)).rejects.toThrow();
    expect(cached.stats().entries).toBe(0);
    await expect(cached.searchLexical("secretneedle", 4)).rejects.toThrow();
    expect(cached.stats().entries).toBe(0);
  });

  it("caches a real worker result when the full plan completed", async () => {
    const { path, writer } = tempDatabaseFile();
    seedFileLexical(writer, (ordinal) => `${incident} passage ${ordinal}`, 200);
    const epoch = new IndexEpochCounter();
    const worker = new SearchWorkerStore({ file: path, epoch, timeoutMs: 5_000 });
    stores.push(worker);

    const direct = await worker.searchLexicalResult(incident, 10);
    expect(direct.complete).toBe(true);

    const spy = vi.spyOn(worker, "searchLexicalResult");
    let tick = 0;
    const cached = new CachedPassageQueryStore(worker, {
      epoch, maxEntries: 8, maxBytes: 1_000_000,
      admissionMs: 50, quietMs: 0, now: () => { tick += 60; return tick; },
    });
    await cached.searchLexical(incident, 10);
    expect(cached.stats().entries).toBe(1);

    await cached.searchLexical(incident, 10);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cached.stats().entries).toBe(1);
  });
});

describe("book_index transitions and the retrieval epoch", () => {
  it("bumps the epoch on every queue and eligibility transition", () => {
    const db = openDb(":memory:");
    databases.push(db);
    const epoch = new IndexEpochCounter();
    new SqliteBookRepository(db).save(book("book"));
    const indexes = new SqliteBookIndexRepository(db, epoch);
    const pending = { bookId: "book", priority: 0 as const, fingerprint: "10:1", now: 1, resetAttempts: false };
    const hash = "a".repeat(64);

    let before = epoch.current();
    indexes.upsertPending(pending);
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    const claimed = indexes.claimNext(0)!;
    expect(claimed.state).toBe("indexing");
    expect(epoch.current()).toBe(before + 1);

    const readyRow: BookIndex = {
      ...claimed, state: "ready", contentHash: hash, indexVersion: "1|lexical",
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, finishedAt: 2,
    };
    before = epoch.current();
    indexes.save(readyRow);
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    indexes.save(unchanged(readyRow, { contentHash: hash, indexVersion: "1|lexical" }, 3));
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    indexes.save(failure(readyRow, "no_text", "no text", 4));
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    indexes.save({ ...readyRow, state: "indexing", startedAt: 5 });
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    expect(indexes.resetInterrupted()).toBe(1);
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    indexes.save(readyRow);
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    expect(indexes.requeue("all", 6)).toBe(1);
    expect(epoch.current()).toBe(before + 1);

    before = epoch.current();
    indexes.upsertPendingMany([pending]);
    expect(epoch.current()).toBe(before + 1);
  });
});
