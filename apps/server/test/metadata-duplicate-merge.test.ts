import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteConversationRepository,
  SqliteMergeLogRepository,
  SqliteNoteRepository,
  SqliteProgressRepository,
  SqliteSourceRepository,
  SqliteUnitOfWork,
} from "../src/adapters/storage/repositories.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import { contentGroupKey } from "../src/domain/library/ContentIdentity.js";
import { BookLocks } from "../src/use-cases/BookLocks.js";
import { BookMetadata } from "../src/use-cases/BookMetadata.js";
import { DuplicateFinder } from "../src/use-cases/DuplicateFinder.js";
import type { Book, FileStore } from "../src/ports/index.js";
import type { CustomCoverStore } from "../src/ports/library-metadata.js";

const hash = createHash("sha256").update("same bytes").digest("hex");

const book = (id: string, path: string, overrides: Partial<Book> = {}): Book => ({
  id, title: id, author: "", format: "epub", path, cover_path: `/covers/${id}.jpg`,
  size: 10, added_at: 1, source_id: "src", mtime: 1, status: "ready", content_hash: hash, ...overrides,
});

const override = (bookId: string, title: string, coverPath: string | null) => ({
  bookId, title, author: null, description: null, isbn10: null, isbn13: null, year: null,
  publisher: null, language: null, series: null, seriesIndex: null, coverPath,
  source: "manual" as const, updatedAt: 1,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function setup() {
  const database = openDb(":memory:");
  const books = new SqliteBookRepository(database);
  const metadata = new SqliteBookMetadataRepository(database);
  const locks = new BookLocks();
  const duplicates = new SqliteBookDuplicateRepository(database);
  const files = {
    statIfExists: vi.fn(async () => ({ size: 10, mtime: 1 })),
    removeManaged: vi.fn(async (_path: string) => true),
  } as Pick<FileStore, "statIfExists" | "removeManaged">;
  const customCovers: CustomCoverStore = {
    save: vi.fn(async (bookId: string) => `/covers/custom/${bookId}.jpg`),
    remove: vi.fn(async () => {}),
    move: vi.fn(async (from: string, to: string) => `/covers/custom/${to}.jpg`),
  };
  const finder = new DuplicateFinder(
    books,
    duplicates,
    { hash: async () => hash },
    new SqliteSourceRepository(database),
    new SqliteNoteRepository(database),
    new SqliteConversationRepository(database),
    new SqliteProgressRepository(database),
    files,
    new SqliteUnitOfWork(database),
    new SqliteMergeLogRepository(database),
    { now: () => 1_000 },
    { next: () => "id" },
    { info: () => {}, error: () => {}, warn: () => {} },
    { bootDelayMs: 0 },
    undefined,
    undefined,
    metadata,
    customCovers,
    locks,
  );
  return { database, books, metadata, duplicates, files, customCovers, finder, locks };
}

const mergePair = (s: ReturnType<typeof setup>) => s.finder.merge({
  groups: [{ key: contentGroupKey(10, hash) }],
  dryRun: false,
});

describe("duplicate merge moves metadata overrides", () => {
  it("adopts the duplicate override when the canonical has none, moving the custom cover", async () => {
    const s = setup();
    s.books.save(book("canonical", "/library/a.epub", { added_at: 1 }));
    s.books.save(book("duplicate", "/library/b.epub", { added_at: 2 }));
    s.metadata.save(override("duplicate", "User title", "/covers/custom/duplicate.jpg"));

    const result = await mergePair(s);
    expect(result).toMatchObject({ merged: 1, booksRemoved: 1 });
    expect(s.books.get("duplicate")).toBeUndefined();
    expect(s.books.get("canonical")).toMatchObject({
      title: "User title",
      cover_path: "/covers/custom/canonical.jpg",
      cover_rev: 1_000,
      file_title: "canonical",
      file_cover_path: "/covers/canonical.jpg",
    });
    expect(s.metadata.get("duplicate")).toBeNull();
    expect(s.metadata.get("canonical")).toMatchObject({
      title: "User title",
      coverPath: "/covers/custom/canonical.jpg",
    });
    expect(s.customCovers.move).toHaveBeenCalledWith("duplicate", "canonical");
    expect(s.files.removeManaged).not.toHaveBeenCalledWith("/covers/custom/duplicate.jpg");
  });

  it("discards the duplicate override when the canonical already has one", async () => {
    const s = setup();
    s.books.save(book("canonical", "/library/a.epub", { added_at: 1 }));
    s.books.save(book("duplicate", "/library/b.epub", { added_at: 2 }));
    s.metadata.save(override("canonical", "Canonical title", null));
    s.metadata.save(override("duplicate", "Duplicate title", "/covers/custom/duplicate.jpg"));

    const result = await mergePair(s);
    expect(result).toMatchObject({ merged: 1, booksRemoved: 1 });
    expect(s.books.get("canonical")).toMatchObject({
      title: "Canonical title",
      cover_path: "/covers/canonical.jpg",
    });
    expect(s.metadata.get("duplicate")).toBeNull();
    expect(s.metadata.get("canonical")).toMatchObject({ title: "Canonical title", coverPath: null });
    expect(s.customCovers.move).not.toHaveBeenCalled();
    expect(s.files.removeManaged).toHaveBeenCalledWith("/covers/custom/duplicate.jpg");
  });

  it("keeps the override without a custom cover and removes the duplicate's file cover", async () => {
    const s = setup();
    s.books.save(book("canonical", "/library/a.epub", { added_at: 1 }));
    s.books.save(book("duplicate", "/library/b.epub", { added_at: 2 }));
    s.metadata.save(override("duplicate", "User title", null));

    await mergePair(s);
    expect(s.books.get("canonical")).toMatchObject({ title: "User title", cover_path: "/covers/canonical.jpg" });
    expect(s.metadata.get("canonical")).toMatchObject({ title: "User title", coverPath: null });
    expect(s.customCovers.move).not.toHaveBeenCalled();
    expect(s.files.removeManaged).toHaveBeenCalledWith("/covers/duplicate.jpg");
  });

  it("serializes a cover upload with a merge of the same book", async () => {
    const s = setup();
    s.books.save(book("canonical", "/library/a.epub", { added_at: 1 }));
    s.books.save(book("duplicate", "/library/b.epub", { added_at: 2 }));
    s.metadata.save(override("duplicate", "User title", "/covers/custom/duplicate.jpg"));

    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const covers: CustomCoverStore = {
      save: vi.fn(async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
        return "/covers/custom/duplicate.jpg";
      }),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => null),
    };
    const bookMetadata = new BookMetadata(
      s.books,
      s.metadata,
      covers,
      { invalidate: async () => {} },
      { now: () => 2_000 },
      {},
      s.locks,
    );

    const setting = bookMetadata.setCover("duplicate", Buffer.from("new"));
    await uploadStarted.promise;

    let moveCalled = false;
    s.customCovers.move = vi.fn(async (): Promise<string | null> => {
      moveCalled = true;
      return "/covers/custom/canonical.jpg";
    });
    const merging = mergePair(s);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The upload holds the per-book lock; the merge cannot delete the row or move the file
    // until it finishes, so the cover the user picked is the one adopted by the canonical.
    expect(moveCalled).toBe(false);
    expect(s.books.get("duplicate")).toBeDefined();

    releaseUpload.resolve();
    expect(await setting).not.toBeNull();
    await merging;
    expect(moveCalled).toBe(true);
    expect(s.books.get("canonical")?.cover_path).toBe("/covers/custom/canonical.jpg");
    expect(s.metadata.get("canonical")?.coverPath).toBe("/covers/custom/canonical.jpg");
  });
});
