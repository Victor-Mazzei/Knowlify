import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteMergeLogRepository,
} from "../src/adapters/storage/repositories.js";
import type { Book } from "../src/ports/index.js";

const hash = (char: string) => char.repeat(64);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  title: id,
  author: "",
  format: "epub",
  path: `/library/${id}.epub`,
  cover_path: null,
  size: 100,
  added_at: 1,
  source_id: "source",
  mtime: 10,
  status: "ready",
  ...overrides,
});

function memoryDb(): Db {
  const db = openDb(":memory:");
  cleanup.push(() => db.close());
  return db;
}

function seedV7Books() {
  const dir = mkdtempSync(join(tmpdir(), "knowlify-v7-"));
  const file = join(dir, "knowlify.db");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', format TEXT NOT NULL,
      path TEXT NOT NULL, cover_path TEXT, size INTEGER NOT NULL, added_at INTEGER NOT NULL,
      source_id TEXT, mtime INTEGER, status TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE UNIQUE INDEX books_path ON books(path);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '', quote TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE web_progress (book_id TEXT PRIMARY KEY, position TEXT NOT NULL, percentage REAL NOT NULL, updated_at INTEGER NOT NULL);
    PRAGMA user_version = 7;
  `);
  raw.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES ('old','Old Book','Author','epub','/library/old.epub',321,123,'source',456,'ready')`).run();
  raw.prepare("INSERT INTO notes (id,book_id,body,created_at,updated_at) VALUES ('note','old','keep me',1,1)").run();
  raw.close();
  return file;
}

describe("v8 migration", () => {
  it("adds content identity objects to a populated v7 database without touching rows", () => {
    const file = seedV7Books();
    const db = openDb(file);
    cleanup.push(() => db.close());

    expect(db.pragma("user_version", { simple: true })).toBe(11);
    expect(db.prepare("SELECT * FROM books").get()).toMatchObject({
      id: "old", title: "Old Book", size: 321, mtime: 456, status: "ready", content_hash: null,
    });
    expect(db.prepare("SELECT body FROM notes WHERE id='note'").get()).toEqual({ body: "keep me" });
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[];
    const names = new Set(objects.map((row) => row.name));
    for (const name of ["book_duplicates", "book_merge_log", "books_size", "books_content_hash", "book_duplicates_book", "book_duplicates_source"]) {
      expect(names.has(name)).toBe(true);
    }

    // Reopening an already migrated database is a no-op.
    db.close();
    const reopened = openDb(file);
    cleanup.push(() => reopened.close());
    expect(reopened.pragma("user_version", { simple: true })).toBe(11);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 1 });
  });
});

describe("SqliteBookRepository content identity", () => {
  it("invalidates content_hash only when size or mtime changes", () => {
    const db = memoryDb();
    const books = new SqliteBookRepository(db);
    books.save(book("a", { content_hash: hash("a") }));

    books.save(book("a", { title: "Metadata update" }));
    expect(books.get("a")?.content_hash).toBe(hash("a"));

    books.save(book("a", { size: 101 }));
    expect(books.get("a")?.content_hash).toBeNull();

    books.save(book("a", { size: 101, content_hash: hash("b") }));
    expect(books.get("a")?.content_hash).toBe(hash("b"));

    books.save(book("a", { mtime: 11 }));
    expect(books.get("a")?.content_hash).toBeNull();

    books.save(book("a", { mtime: 11, content_hash: hash("c") }));
    books.save(book("a", { mtime: 12, content_hash: hash("d") }));
    expect(books.get("a")?.content_hash).toBe(hash("d"));
  });

  it("finds same-size candidates, reports present sizes and guards hash writes", () => {
    const db = memoryDb();
    const books = new SqliteBookRepository(db);
    books.save(book("a", { size: 10 }));
    books.save(book("b", { size: 10 }));
    books.save(book("c", { size: 20 }));

    expect(books.bySize(10).map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(books.bySize(10, "/library/a.epub").map((row) => row.id)).toEqual(["b"]);
    expect([...books.sizesPresent([10, 20, 30])].sort()).toEqual([10, 20]);

    expect(books.setContentHashIfCurrent("a", hash("f"), 10, 10)).toBe(true);
    expect(books.get("a")?.content_hash).toBe(hash("f"));
    expect(books.setContentHashIfCurrent("b", hash("f"), 11, 10)).toBe(false);
    expect(books.setContentHashIfCurrent("b", hash("f"), 10, 11)).toBe(false);
    expect(books.get("b")?.content_hash).toBeNull();
  });

  it("seeds content_hash from a matching book_index fingerprint only", () => {
    const db = memoryDb();
    const books = new SqliteBookRepository(db);
    books.save(book("matching", { size: 100, mtime: 10 }));
    books.save(book("stale", { size: 200, mtime: 20 }));
    const insert = db.prepare(`INSERT INTO book_index (book_id, state, content_hash, fingerprint, requested_at)
      VALUES (?, 'ready', ?, ?, 1)`);
    insert.run("matching", hash("1"), "100:10");
    insert.run("stale", hash("2"), "200:21");

    books.seedContentHashes(100);
    books.seedContentHashes(200);

    expect(books.get("matching")?.content_hash).toBe(hash("1"));
    expect(books.get("stale")?.content_hash).toBeNull();
  });
});

describe("SqliteBookDuplicateRepository", () => {
  it("stores aliases per source and promotes one while keeping the book id", () => {
    const db = memoryDb();
    const books = new SqliteBookRepository(db);
    const duplicates = new SqliteBookDuplicateRepository(db);
    books.save(book("canonical", { path: "/library/a.epub", size: 10, mtime: 1 }));
    books.save(book("other", { path: "/library/other.epub" }));

    duplicates.upsertAlias({ path: "/library/copy.epub", bookId: "canonical", sourceId: "source",
      size: 10, mtime: 2, contentHash: hash("a"), detectedAt: 5 });
    duplicates.upsertAlias({ path: "/library/copy.epub", bookId: "canonical", sourceId: "source",
      size: 10, mtime: 3, contentHash: hash("a"), detectedAt: 6 });

    expect(duplicates.aliasSnapshotForSource("source").get("/library/copy.epub"))
      .toMatchObject({ bookId: "canonical", size: 10, mtime: 3, contentHash: hash("a") });
    expect(duplicates.aliasSnapshotForSource("missing").size).toBe(0);
    expect(duplicates.aliasesForBook("canonical")).toHaveLength(1);

    expect(duplicates.promoteAlias("canonical", "/library/copy.epub")).toBe(true);
    expect(books.get("canonical")).toMatchObject({ path: "/library/copy.epub", size: 10, mtime: 3, content_hash: hash("a") });
    expect(duplicates.aliasesForBook("canonical")).toEqual([]);

    // A path already owned by another book is never stolen.
    duplicates.upsertAlias({ path: "/library/other.epub", bookId: "canonical", sourceId: "source",
      size: 10, mtime: 4, contentHash: hash("a"), detectedAt: 7 });
    expect(duplicates.promoteAlias("canonical", "/library/other.epub")).toBe(false);
    expect(books.get("canonical")?.path).toBe("/library/copy.epub");
  });

  it("groups content, reports counts and gathers stats for merge decisions", () => {
    const db = memoryDb();
    const books = new SqliteBookRepository(db);
    const duplicates = new SqliteBookDuplicateRepository(db);
    books.save(book("a", { size: 50, content_hash: hash("a") }));
    books.save(book("b", { size: 50, content_hash: hash("a") }));
    books.save(book("c", { size: 50, content_hash: hash("b") }));
    books.save(book("d", { size: 60, content_hash: hash("c") }));
    books.save(book("e", { size: 61, content_hash: null }));

    expect(duplicates.sizeGroups()).toEqual([{ size: 50, count: 3 }]);
    expect(duplicates.contentGroups(null, 10)).toEqual([{ size: 50, contentHash: hash("a") }]);
    expect(duplicates.contentGroups({ size: 50, contentHash: hash("a") }, 10)).toEqual([]);
    expect(duplicates.contentGroupCounts()).toEqual({ groups: 1, redundantBooks: 1 });

    db.prepare("INSERT INTO notes (id,book_id,body,created_at,updated_at) VALUES ('n1','b','x',1,1)").run();
    db.prepare("INSERT INTO notes (id,book_id,body,created_at,updated_at) VALUES ('n2','b','x',1,1)").run();
    db.prepare("INSERT INTO conversations (id,scope_kind,book_id,title,created_at,updated_at) VALUES ('c','book','b','t',1,1)").run();
    db.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES ('b','p',0.5,99)").run();
    db.prepare("INSERT INTO book_index (book_id,state,requested_at) VALUES ('b','ready',1)").run();
    db.prepare("INSERT INTO chunks (book_id,ordinal,text) VALUES ('b',0,'hello')").run();
    db.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (1,'b',x'0102')").run();

    expect(duplicates.statsForBooks(["a", "b", "missing"]).get("b")).toEqual({
      notes: 2, conversations: 1, hasProgress: true, progressUpdatedAt: 99, indexState: "ready",
    });
    expect(duplicates.statsForBooks(["a"]).get("a")).toEqual({
      notes: 0, conversations: 0, hasProgress: false, progressUpdatedAt: null, indexState: "none",
    });
    expect(duplicates.reclaimableBytes(["b"])).toBe(7);
    expect(duplicates.reclaimableBytes(["a"])).toBe(0);
    duplicates.upsertAlias({ path: "/library/b-alias.epub", bookId: "b", sourceId: "source",
      size: 50, mtime: 1, contentHash: hash("a"), detectedAt: 1 });
    expect(duplicates.aliasesForBooks(["a", "b"])).toEqual(new Map([["b", ["/library/b-alias.epub"]]]));
  });

  it("keeps the merge log for 90-day retention and prunes older entries", () => {
    const db = memoryDb();
    const log = new SqliteMergeLogRepository(db);
    const entry = { id: "m1", canonicalId: "a", duplicateId: "b", duplicatePath: "/library/b.epub",
      sourceId: "source", contentHash: hash("a"), noteIds: ["n1"], progress: null, mergedAt: 1000 };
    log.save(entry);
    expect(db.prepare("SELECT * FROM book_merge_log WHERE id='m1'").get()).toMatchObject({
      canonical_id: "a", duplicate_id: "b", note_ids_json: "[\"n1\"]", progress_json: null,
    });
    expect(log.prune(1001)).toBe(1);
  });
});
