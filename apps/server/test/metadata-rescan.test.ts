import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookDuplicateRepository } from "../src/adapters/storage/SqliteBookDuplicateRepository.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import { SqliteNoteRepository } from "../src/adapters/storage/SqliteNoteRepository.js";
import { SqliteFavoriteRepository } from "../src/adapters/storage/SqliteFavoriteRepository.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { DiskFileStore } from "../src/adapters/files/FileStore.js";
import { Library } from "../src/use-cases/Library.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import type { Book, FileEntry, FileStore, MetadataExtractor, Source } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-metadata-rescan-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const book = (id: string): Book => ({
  id,
  title: "File title",
  author: "File author",
  format: "epub",
  path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.jpg`,
  size: 10,
  added_at: 100,
  source_id: "src",
  mtime: 1,
  status: "ready",
  content_hash: null,
});

const entry = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path, directory: false, file: true, symlink: false });

function scannerSetup(database: Db, extract: (path: string) => Promise<{ title?: string; author?: string }>) {
  const books = new SqliteBookRepository(database);
  const metadataRepository = new SqliteBookMetadataRepository(database);
  const files = {
    extension: (path: string) => path.split(".").at(-1)!,
    title: (path: string) => path,
    join: (...parts: string[]) => parts.join("/"),
    resolve: (path: string) => path,
    realpath: async (path: string) => path,
    parent: () => "/",
    isRoot: () => false,
    isWindows: false,
    home: "/home",
    isDirectory: async () => true,
    accessible: async () => true,
    entries: vi.fn(async () => [entry("/library/book.epub")]),
    stat: vi.fn(async () => ({ size: 20, mtime: 2 })),
    statIfExists: vi.fn(async () => ({ size: 20, mtime: 2 })),
    managedPath: (id: string, format: string) => `/books/${id}.${format}`,
    moveUpload: async (_tmp: string, id: string, format: string) => `/books/${id}.${format}`,
    writeCover: async (id: string) => `/covers/${id}.jpg`,
    remove: async () => {},
    removeManaged: async () => false,
  } satisfies FileStore;
  const metadata: Record<Book["format"], MetadataExtractor> = {
    epub: { extract: vi.fn(extract) },
    pdf: { extract: vi.fn(extract) },
  };
  const sources = {
    list: () => [{ id: "src", path: "/library" }] satisfies Source[],
    byPath: () => undefined,
    save: () => {},
    delete: () => false,
  };
  const scanner = new Scanner(
    books, sources, files, { now: () => 200 }, { next: () => "new" }, metadata,
    { info: () => {}, error: () => {}, warn: () => {} },
    undefined, [], { writeBlockSize: 10, pendingReadBatch: 10 },
  );
  return { books, metadataRepository, files, scanner, metadata };
}

async function settle(scanner: Scanner, books: SqliteBookRepository): Promise<void> {
  await scanner.scan();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await scanner.processPending();
    if (books.pendingCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("scan did not settle");
}

describe("scanner rescan keeps the override (ADR-2)", () => {
  it("updates file_title/file_author from the changed file while title/author stay overridden", async () => {
    const database = openDb(":memory:");
    const { books, metadataRepository, scanner } = scannerSetup(database, async () => ({ title: "Extracted title", author: "Extracted author" }));
    books.save(book("book"));
    metadataRepository.save({
      bookId: "book", title: "User title", author: "User author", description: null, isbn10: null,
      isbn13: null, year: null, publisher: null, language: null, series: null, seriesIndex: null,
      coverPath: null, source: "manual", updatedAt: 1,
    });

    await settle(scanner, books);

    expect(books.get("book")).toMatchObject({
      title: "User title",
      author: "User author",
      file_title: "Extracted title",
      file_author: "Extracted author",
      status: "ready",
      mtime: 2,
      size: 20,
    });
    database.close();
  });

  it("does not promote the override when metadata extraction fails", async () => {
    const database = openDb(":memory:");
    const { books, metadataRepository, scanner } = scannerSetup(database, async () => { throw new Error("broken file"); });
    books.save(book("book"));
    metadataRepository.save({
      bookId: "book", title: "User title", author: "User author", description: null, isbn10: null,
      isbn13: null, year: null, publisher: null, language: null, series: null, seriesIndex: null,
      coverPath: null, source: "manual", updatedAt: 1,
    });

    await settle(scanner, books);

    expect(books.get("book")).toMatchObject({
      title: "User title",
      author: "User author",
      file_title: "File title",
      file_author: "File author",
      status: "error",
    });
    database.close();
  });
});

describe("scanner rescan keeps the favorite", () => {
  it("leaves favorite untouched when the file changed and the row is rewritten", async () => {
    const database = openDb(":memory:");
    const { books, scanner } = scannerSetup(database, async () => ({ title: "Extracted title", author: "Extracted author" }));
    const favorites = new SqliteFavoriteRepository(database);
    books.save(book("book"));
    expect(favorites.set("book", true)).toBe(true);

    await settle(scanner, books);

    expect(books.get("book")).toMatchObject({ file_title: "Extracted title", mtime: 2, size: 20, status: "ready" });
    expect(database.prepare("SELECT favorite FROM books WHERE id = ?").get("book")).toEqual({ favorite: 1 });

    await settle(scanner, books);
    expect(database.prepare("SELECT favorite FROM books WHERE id = ?").get("book")).toEqual({ favorite: 1 });
    database.close();
  });
});

describe("moved imports keep the override", () => {
  it("Library.finishImport falls back to file values, not effective ones", async () => {
    const database = openDb(":memory:");
    const dataDir = join(root, "import");
    const books = new SqliteBookRepository(database);
    const metadataRepository = new SqliteBookMetadataRepository(database);
    const files = new DiskFileStore(join(dataDir, "books"), join(dataDir, "covers"));
    books.save(book("existing"));
    metadataRepository.save({
      bookId: "existing", title: "User title", author: "User author", description: null, isbn10: null,
      isbn13: null, year: null, publisher: null, language: null, series: null, seriesIndex: null,
      coverPath: null, source: "manual", updatedAt: 1,
    });
    const tmp = join(dataDir, "tmp-upload");
    await mkdir(dataDir, { recursive: true });
    await writeFile(tmp, Buffer.alloc(10));
    const library = new Library(
      books,
      new SqliteNoteRepository(database),
      files,
      { now: () => 300 },
      { next: () => "new-id" },
      {
        epub: { extract: async () => ({ title: "Imported title", author: "Imported author" }) },
        pdf: { extract: async () => ({ title: "Imported title", author: "Imported author" }) },
      },
      undefined,
      undefined,
      undefined,
      {
        resolve: async () => ({
          kind: "moved",
          bookId: "existing",
          book: book("existing"),
        }),
      },
    );

    const result = await library.importFile(tmp, "upload.epub", { size: 10, contentHash: "hash" });

    expect(result.book.id).toBe("existing");
    expect(result.book).toMatchObject({ title: "User title", author: "User author" });
    expect(books.get("existing")).toMatchObject({
      title: "User title",
      author: "User author",
      file_title: "Imported title",
      file_author: "Imported author",
      path: join(dataDir, "books", "new-id.epub"),
      source_id: null,
    });
    database.close();
  });

  it("promoting an alias changes the path only and keeps override and file snapshot", () => {
    const database = openDb(":memory:");
    const books = new SqliteBookRepository(database);
    const metadataRepository = new SqliteBookMetadataRepository(database);
    const duplicates = new SqliteBookDuplicateRepository(database);
    books.save(book("book"));
    metadataRepository.save({
      bookId: "book", title: "User title", author: "User author", description: null, isbn10: null,
      isbn13: null, year: null, publisher: null, language: null, series: null, seriesIndex: null,
      coverPath: "/covers/custom/book.jpg", source: "manual", updatedAt: 1,
    });
    duplicates.upsertAlias({
      path: "/library/moved.epub", bookId: "book", sourceId: "src", size: 10, mtime: 1,
      contentHash: "hash", detectedAt: 1,
    });

    expect(duplicates.promoteAlias("book", "/library/moved.epub")).toBe(true);
    expect(books.get("book")).toMatchObject({
      path: "/library/moved.epub",
      title: "User title",
      author: "User author",
      cover_path: "/covers/custom/book.jpg",
      file_title: "File title",
      file_author: "File author",
      file_cover_path: "/covers/book.jpg",
    });
    database.close();
  });
});
