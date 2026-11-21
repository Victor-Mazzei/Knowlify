import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import { BookLocks } from "../src/use-cases/BookLocks.js";
import { BookMetadata } from "../src/use-cases/BookMetadata.js";
import type { Book } from "../src/ports/index.js";
import type { CustomCoverStore } from "../src/ports/library-metadata.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string): Book => ({
  id, title: "File title", author: "File author", format: "epub", path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.jpg`, size: 10, added_at: 1, source_id: "src", mtime: 1, status: "ready",
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const customPath = (bookId: string) => `/covers/custom/${bookId}.jpg`;

/** Tracks the real files and can hold `remove` until the test releases it. */
class ControlledCovers implements CustomCoverStore {
  readonly files = new Set<string>();
  saveCalls = 0;
  removeCalls = 0;
  private removeGate: Promise<void> | null = null;

  blockRemove(): () => void {
    const gate = deferred();
    this.removeGate = gate.promise;
    return gate.resolve;
  }

  async save(bookId: string): Promise<string> {
    this.saveCalls += 1;
    const path = customPath(bookId);
    this.files.add(path);
    return path;
  }

  async remove(bookId: string): Promise<void> {
    this.removeCalls += 1;
    if (this.removeGate) await this.removeGate;
    this.files.delete(customPath(bookId));
  }

  async move(): Promise<string | null> {
    return null;
  }
}

function setup() {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const repository = new SqliteBookMetadataRepository(database);
  const covers = new ControlledCovers();
  const metadata = new BookMetadata(
    books,
    repository,
    covers,
    { invalidate: async () => {} },
    { now: () => 1_700_000_000_000 },
    {},
    new BookLocks(),
  );
  return { books, repository, covers, metadata };
}

describe("BookMetadata cover concurrency", () => {
  it("keeps the new cover when a set races a clear waiting for the old file removal", async () => {
    const s = setup();
    s.books.save(book("b"));
    await s.metadata.setCover("b", Buffer.from("old"));
    expect(s.covers.files.has(customPath("b"))).toBe(true);

    const release = s.covers.blockRemove();
    const clearing = s.metadata.clearCover("b");
    await tick();
    expect(s.covers.removeCalls).toBe(1);

    const setting = s.metadata.setCover("b", Buffer.from("new"));
    // The clear is still holding the book lock while its file removal runs, so the new
    // upload must not have started yet.
    expect(s.covers.saveCalls).toBe(1);

    release();
    const [cleared, updated] = await Promise.all([clearing, setting]);
    expect(cleared).not.toBeNull();
    expect(updated).not.toBeNull();

    const detail = s.metadata.detail("b")!;
    expect(detail.metadata.overridden.cover).toBe(true);
    expect(detail.book.cover_path).toBe(customPath("b"));
    expect(detail.book.cover_rev).not.toBeNull();
    // The file that the database references still exists: without the lock the clear's
    // later `remove` deleted the file saved by `setCover`.
    expect(s.covers.files.has(customPath("b"))).toBe(true);
  });

  it("keeps the new cover when a set races a reset waiting for the old file removal", async () => {
    const s = setup();
    s.books.save(book("b"));
    await s.metadata.setCover("b", Buffer.from("old"));
    s.metadata.patch("b", { title: "User title" });

    const release = s.covers.blockRemove();
    const resetting = s.metadata.reset("b");
    const setting = s.metadata.setCover("b", Buffer.from("new"));
    expect(s.covers.saveCalls).toBe(1);

    release();
    const [reset, updated] = await Promise.all([resetting, setting]);
    expect(reset).not.toBeNull();
    expect(updated).not.toBeNull();

    const detail = s.metadata.detail("b")!;
    expect(detail.metadata.title).toBe("File title");
    expect(detail.metadata.overridden.cover).toBe(true);
    expect(detail.book.cover_path).toBe(customPath("b"));
    expect(detail.book.cover_rev).not.toBeNull();
    expect(s.covers.files.has(customPath("b"))).toBe(true);
  });

  it("still deletes the custom file when clear is the last operation", async () => {
    const s = setup();
    s.books.save(book("b"));
    await s.metadata.setCover("b", Buffer.from("old"));

    const detail = (await s.metadata.clearCover("b"))!;
    expect(detail.metadata.overridden.cover).toBe(false);
    expect(detail.book.cover_path).toBe("/covers/b.jpg");
    expect(s.covers.files.has(customPath("b"))).toBe(false);
  });
});
