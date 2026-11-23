import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteConversationRepository,
  SqliteIgnoredBookRepository,
  SqliteMergeLogRepository,
  SqliteNoteRepository,
  SqliteProgressRepository,
  SqliteUnitOfWork,
} from "../src/adapters/storage/repositories.js";
import { SqliteFavoriteRepository } from "../src/adapters/storage/SqliteFavoriteRepository.js";
import {
  SqliteBookIndexRepository,
  SqlitePassageRepository,
} from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { IndexEpochCounter } from "../src/adapters/runtime/IndexEpochCounter.js";
import { BookRemoval } from "../src/use-cases/BookRemoval.js";
import { BookLocks } from "../src/use-cases/BookLocks.js";
import { DuplicateFinder } from "../src/use-cases/DuplicateFinder.js";
import { IgnoredBooks } from "../src/use-cases/IgnoredBooks.js";
import { Indexing } from "../src/use-cases/Indexing.js";
import { contentGroupKey } from "../src/domain/library/ContentIdentity.js";
import type { Book } from "../src/ports/index.js";
import type { IgnoredBook } from "../src/domain/library/IgnoredBook.js";
import type { Passage } from "../src/domain/knowledge/BookIndex.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const database = (): Db => {
  const db = openDb(":memory:");
  databases.push(db);
  return db;
};

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id, title: `Title ${id}`, author: "Author", format: "pdf", path: `/library/${id}.pdf`,
  cover_path: null, size: 10, added_at: 1, source_id: "source", mtime: 1, status: "ready", ...overrides,
});

const passage = (ordinal: number, text: string): Passage => ({
  ordinal, text, page: ordinal + 1, section: null,
});

const hash = "a".repeat(64);

function seedBook(db: Db, id = "book", bookHash: string | null = hash): void {
  new SqliteBookRepository(db).save(book(id, { content_hash: bookHash }));
  new SqliteBookIndexRepository(db).upsertPending({ bookId: id, priority: 0, fingerprint: "10:1", now: 1, resetAttempts: false });
}

describe("IndexEpoch write inventory", () => {
  it("bumps when passages and vectors are appended", () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    seedBook(db);
    new SqlitePassageRepository(db, epoch).append("book", [{ passage: passage(0, "text"), vector: new Float32Array([1, 0]) }]);
    expect(epoch.current()).toBe(1);
  });

  it("bumps when a book's chunks are cleared (reindex, failure cleanup or no_text)", () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const passages = new SqlitePassageRepository(db, epoch);
    seedBook(db);
    passages.append("book", [{ passage: passage(0, "text"), vector: null }]);
    passages.clear("book");
    expect(epoch.current()).toBe(2);
  });

  it("bumps on book deletion, the path used by removal and tombstones", () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const books = new SqliteBookRepository(db, epoch);
    seedBook(db);
    books.delete("book");
    expect(epoch.current()).toBe(1);
  });

  it("bumps through the removal use case and writes the tombstone", async () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const books = new SqliteBookRepository(db, epoch);
    const ignored = new SqliteIgnoredBookRepository(db);
    seedBook(db);
    const removal = new BookRemoval(
      books,
      { deleteForBook: vi.fn(), countForBooks: () => 0 },
      { deleteForBook: vi.fn() },
      ignored,
      { statsForBooks: () => new Map(), aliasesForBook: () => [] },
      { byIds: () => [], count: () => 0, matchingIds: () => [] },
      new SqliteUnitOfWork(db),
      { removeManaged: async () => false, statIfExists: async () => null },
      { invalidate: async () => {} },
      { now: () => 1 },
      { next: () => "ignored-1" },
      { info: () => {}, error: () => {} },
      new BookLocks(),
    );

    await removal.removeOne("book");
    expect(books.get("book")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM ignored_books").get()).toEqual({ n: 1 });
    expect(epoch.current()).toBe(1);
  });

  it("bumps when the duplicate merge drops the duplicate book and its index", async () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const books = new SqliteBookRepository(db, epoch);
    const duplicates = new SqliteBookDuplicateRepository(db);
    books.save(book("canonical", { content_hash: hash, added_at: 1 }));
    books.save(book("duplicate", { content_hash: hash, added_at: 2 }));
    db.prepare("INSERT INTO book_index (book_id,state,requested_at) VALUES ('duplicate','ready',1)").run();
    db.prepare("INSERT INTO chunks (book_id,ordinal,text) VALUES ('duplicate',0,'duplicate text')").run();
    const finder = new DuplicateFinder(
      books,
      duplicates,
      { hash: async () => hash },
      { byPath: () => undefined } as never,
      new SqliteNoteRepository(db),
      new SqliteConversationRepository(db),
      new SqliteProgressRepository(db),
      {
        removeManaged: async () => false,
        statIfExists: async (path: string) => {
          const row = books.byPath(path);
          return row ? { size: row.size, mtime: row.mtime ?? 1 } : null;
        },
      },
      new SqliteUnitOfWork(db),
      new SqliteMergeLogRepository(db),
      { now: () => 1_000 },
      { next: () => "merge-1" },
      { info: () => {}, error: () => {} },
      { bootDelayMs: 0, hashConcurrency: 1 },
      undefined,
      new SqliteFavoriteRepository(db),
    );

    const result = await finder.merge({
      groups: [{ key: contentGroupKey(10, hash), canonicalId: "canonical" }],
      dryRun: false,
    });

    expect(result.booksRemoved).toBe(1);
    expect(books.get("duplicate")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id='duplicate'").get()).toEqual({ n: 0 });
    expect(epoch.current()).toBe(1);
  });

  it("bumps when a tombstone is restored (the book will be reindexed from scratch)", () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const ignored = new SqliteIgnoredBookRepository(db);
    const tombstone: IgnoredBook = {
      id: "ignored-1", path: "/library/book.pdf", sourceId: "source", contentHash: hash,
      size: 10, title: "Book", author: "", format: "pdf", managed: false, ignoredAt: 1,
    };
    ignored.saveMany([tombstone]);
    const books = new IgnoredBooks(ignored, () => {}, epoch);
    expect(books.restore(["ignored-1"]).restored).toBe(1);
    expect(epoch.current()).toBe(1);
  });

  it("bumps on a manual reindex and on a library-wide requeue (embedding/model change)", () => {
    const db = database();
    const epoch = new IndexEpochCounter();
    const books = new SqliteBookRepository(db, epoch);
    const indexes = new SqliteBookIndexRepository(db);
    seedBook(db);
    indexes.save({
      bookId: "book", state: "ready", priority: 0, contentHash: hash, indexVersion: "1|lexical",
      fingerprint: "10:1", chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null,
      requestedAt: 1, startedAt: 1, finishedAt: 1,
    });
    const indexing = new Indexing(
      indexes,
      new SqlitePassageRepository(db, epoch),
      books,
      {
        run: async () => { throw new Error("not used"); },
        embedQuery: async () => null,
        embeddings: () => ({ mode: "none", model: null, state: "off" }),
        indexVersion: () => "1|lexical",
        onEmbeddingsReady: () => {},
        close: async () => {},
      },
      { now: () => 1 },
      { enabled: true, maxBytes: 1_000_000, concurrency: 1, backfill: "off" },
      { info: () => {}, error: () => {} },
      epoch,
    );

    expect(indexing.reindex("book")).toBe("pending");
    expect(epoch.current()).toBe(1);
    indexing.reindexAll("all");
    expect(epoch.current()).toBe(2);
  });
});
