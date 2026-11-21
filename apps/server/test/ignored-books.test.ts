import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteIgnoredBookRepository,
  SqliteNoteRepository,
  SqliteSourceRepository,
  SqliteUnitOfWork,
} from "../src/adapters/storage/repositories.js";
import { SqliteBookListQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { ContentIdentity } from "../src/use-cases/ContentIdentity.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import { Library } from "../src/use-cases/Library.js";
import { BookRemoval } from "../src/use-cases/BookRemoval.js";
import { IgnoredBooks } from "../src/use-cases/IgnoredBooks.js";
import type { Book, FileEntry, FileStore, IgnoredBook, MetadataExtractor } from "../src/ports/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const clock = { now: () => 1000 };
let nextId = 0;
const ids = { next: () => `id-${++nextId}` };
const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const entry = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path, directory: false, file: true, symlink: false });

const book = (overrides: Partial<Book> & Pick<Book, "id" | "path">): Book => ({
  title: overrides.id, author: "", format: "epub", cover_path: null, size: 5,
  added_at: 1, source_id: "src", mtime: 1, status: "ready", ...overrides,
});

function harness() {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const sources = new SqliteSourceRepository(database);
  const aliases = new SqliteBookDuplicateRepository(database);
  const ignored = new SqliteIgnoredBookRepository(database);
  const noteRepository = new SqliteNoteRepository(database);
  const contents = new Map<string, string>();
  const stats = new Map<string, { size: number; mtime: number }>();
  const entries = new Map<string, FileEntry[]>();
  const files: FileStore = {
    extension: (path) => path.split(".").at(-1)?.toLowerCase() ?? "",
    title: (path) => path.split("/").at(-1)?.split(".")[0] ?? path,
    join: (...parts) => parts.join("/"),
    resolve: (path) => path,
    realpath: async (path) => path,
    parent: (path) => path.split("/").slice(0, -1).join("/"),
    isRoot: (path) => path === "/",
    isWindows: false,
    home: "/home",
    isDirectory: async (path) => entries.has(path),
    accessible: async (path) => entries.has(path) || stats.has(path),
    entries: vi.fn(async (path: string) => {
      const value = entries.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return value;
    }),
    stat: vi.fn(async (path: string) => {
      const value = stats.get(path);
      if (!value) throw new Error("ENOENT");
      return value;
    }),
    statIfExists: vi.fn(async (path: string) => stats.get(path) ?? null),
    managedPath: (id, format) => `/uploads/${id}.${format}`,
    moveUpload: vi.fn(async (_tmp: string, id: string, format: string) => {
      const path = `/uploads/${id}.${format}`;
      stats.set(path, { size: 5, mtime: 0 });
      return path;
    }),
    writeCover: vi.fn(async (id: string) => `/covers/${id}.jpg`),
    remove: vi.fn(async (path: string) => { stats.delete(path); }),
    removeManaged: vi.fn(async (path: string) => {
      if (!stats.has(path)) return false;
      stats.delete(path);
      return true;
    }),
  };
  const hasher = {
    hash: vi.fn(async (path: string) => {
      const value = contents.get(path);
      if (value === undefined) throw new Error("ENOENT");
      return sha(value);
    }),
  };
  const metadata: Record<Book["format"], MetadataExtractor> = {
    epub: { extract: vi.fn(async () => ({ title: "meta" })) },
    pdf: { extract: vi.fn(async () => ({ title: "meta" })) },
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const identity = new ContentIdentity(books, aliases, hasher, files, sources, clock, ignored);
  const scanner = new Scanner(books, sources, files, clock, ids, metadata, log, undefined, [], {},
    { identity, aliases }, ignored);
  scanner.processPending = async () => {};
  const library = new Library(books, noteRepository, files, clock, ids, metadata, undefined, undefined, undefined, identity, ignored);
  const removal = new BookRemoval(
    books,
    noteRepository,
    { deleteForBook: () => {} },
    ignored,
    aliases,
    new SqliteBookListQuery(database),
    new SqliteUnitOfWork(database),
    files,
    { invalidate: vi.fn(async () => {}) },
    clock,
    ids,
    log,
  );
  const ignoredBooks = new IgnoredBooks(ignored, () => { void scanner.scan(); });
  const addFile = (path: string, content: string, size = content.length, mtime = 1) => {
    contents.set(path, content);
    stats.set(path, { size, mtime });
  };
  const addDir = (path: string, filesInDir: string[]) => entries.set(path, filesInDir.map(entry));
  const ignore = (overrides: Partial<IgnoredBook> & Pick<IgnoredBook, "id" | "size">): IgnoredBook => {
    const row: IgnoredBook = {
      path: null, sourceId: "src", contentHash: null, title: overrides.id, author: "", format: "epub",
      managed: false, ignoredAt: 1, ...overrides,
    };
    ignored.saveMany([row]);
    return row;
  };
  return { database, books, sources, aliases, ignored, noteRepository, contents, stats, entries, files, hasher, metadata,
    log, identity, scanner, library, removal, ignoredBooks, addFile, addDir, ignore, book };
}

describe("scanner respects ignored books", () => {
  it("does not import a file whose exact path is ignored", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.addDir("/lib", ["/lib/gone.epub"]);
    s.addFile("/lib/gone.epub", "bytes");
    s.ignore({ id: "tomb", path: "/lib/gone.epub", contentHash: sha("bytes"), size: 5 });

    await s.scanner.scan();

    expect(s.books.count()).toBe(0);
    expect(s.scanner.status().ignoredSkipped).toBe(1);
    expect(s.aliases.aliasSnapshotForSource("src").size).toBe(0);
  });

  it("does not import the same content from another path, another name or another source", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.addDir("/a", ["/a/renamed.epub"]);
    s.addFile("/a/renamed.epub", "same content");
    s.addDir("/b", ["/b/copy.epub"]);
    s.addFile("/b/copy.epub", "same content");
    s.ignore({ id: "tomb", contentHash: sha("same content"), size: "same content".length });

    await s.scanner.scan();

    expect(s.books.count()).toBe(0);
    expect(s.scanner.status().ignoredSkipped).toBe(2);
  });

  it("still imports a same-size file with different bytes", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.addDir("/lib", ["/lib/other.epub"]);
    s.addFile("/lib/other.epub", "other bytes!");
    s.ignore({ id: "tomb", contentHash: sha("deleted..."), size: "other bytes!".length });

    await s.scanner.scan();

    expect(s.books.count()).toBe(1);
    expect(s.books.list()[0]?.content_hash).toBe(sha("other bytes!"));
    expect(s.scanner.status().ignoredSkipped).toBe(0);
  });

  it("does not resurrect a deleted book whose file changed mid-scan", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/book.epub", mtime: 1 }));
    s.addDir("/lib", ["/lib/book.epub"]);
    s.addFile("/lib/book.epub", "new bytes", 9, 2);
    // The deletion commits after the walk built its pending "changed" row and before the
    // flush consults the tombstones: the check must read the database at flush time.
    const realPathsAmong = s.ignored.pathsAmong.bind(s.ignored);
    vi.spyOn(s.ignored, "pathsAmong").mockImplementationOnce((paths) => {
      s.books.deleteMany(["book-1"]);
      s.ignore({ id: "tomb-mid-scan", path: "/lib/book.epub", contentHash: sha("new bytes"), size: 9 });
      return realPathsAmong(paths);
    });

    await s.scanner.scan();

    expect(s.books.get("book-1")).toBeUndefined();
    expect(s.books.count()).toBe(0);
    expect(s.scanner.status().ignoredSkipped).toBe(1);
    expect(s.database.prepare("SELECT path FROM ignored_books WHERE path = '/lib/book.epub'").get())
      .toEqual({ path: "/lib/book.epub" });
  });

  it("keeps books when a source looks unmounted, even with tombstones present", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/book.epub" }));
    s.ignore({ id: "unrelated", contentHash: sha("unrelated"), size: 9 });
    s.addDir("/lib", []);

    await s.scanner.scan();

    expect(s.books.get("book-1")).toBeDefined();
  });
});

describe("restore and upload of ignored content", () => {
  it("restores tombstones and recreates the book on the next scan", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.addDir("/lib", ["/lib/gone.epub"]);
    s.addFile("/lib/gone.epub", "bytes");
    const tomb = s.ignore({ id: "tomb", path: "/lib/gone.epub", contentHash: sha("bytes"), size: 5 });

    const restored = s.ignoredBooks.restore([tomb.id, "missing"]);
    expect(restored).toEqual({ restored: 1, scanStarted: true });
    await vi.waitFor(() => expect(s.books.count()).toBe(1));

    expect(s.books.list()[0]?.path).toBe("/lib/gone.epub");
    expect(s.ignored.count()).toBe(0);
  });

  it("restores an upload whose hash was ignored instead of refusing it", async () => {
    const s = harness();
    s.ignore({ id: "tomb", contentHash: sha("uploaded bytes"), size: 14 });
    // The ignored entry belongs to a folder copy; the upload itself was never stored.
    s.stats.set("/tmp/upload", { size: 14, mtime: 0 });
    s.contents.set("/tmp/upload", "uploaded bytes");

    const result = await s.library.importFile("/tmp/upload", "upload.epub", { size: 14, contentHash: sha("uploaded bytes") });

    expect(result).toMatchObject({ duplicate: false, restoredFromIgnored: true });
    expect(s.books.get(result.book.id)).toBeDefined();
    expect(s.ignored.count()).toBe(0);
  });

  it("keeps the ignored entry when the import fails after resolving the content", async () => {
    const s = harness();
    const bytes = "ignored pdf bytes";
    const hash = sha(bytes);
    s.ignore({ id: "tomb", contentHash: hash, size: bytes.length });
    s.stats.set("/tmp/upload.pdf", { size: bytes.length, mtime: 0 });
    s.contents.set("/tmp/upload.pdf", bytes);
    vi.spyOn(s.metadata.pdf, "extract").mockRejectedValueOnce(new Error("unreadable pdf"));

    await expect(s.library.importFile("/tmp/upload.pdf", "upload.pdf", { size: bytes.length, contentHash: hash }))
      .rejects.toThrow("unreadable pdf");

    // The tombstone is dropped only after a successful import; a failed one leaves it.
    expect(s.ignored.hasHash(hash)).toBe(true);
    // `resolve` had already inserted the pending row and moved the file; the failure must
    // not leave a phantom book or an orphan managed file behind.
    const fileId = s.files.moveUpload.mock.calls[0]![1];
    expect(s.books.get(fileId)).toBeUndefined();
    expect(s.books.count()).toBe(0);
    expect(s.stats.has(`/uploads/${fileId}.pdf`)).toBe(false);
  });

  it("rolls back the provisional row when the temp file cannot be moved", async () => {
    const s = harness();
    const bytes = "unmovable bytes";
    const hash = sha(bytes);
    s.ignore({ id: "tomb", contentHash: hash, size: bytes.length });
    s.stats.set("/tmp/unmovable.epub", { size: bytes.length, mtime: 0 });
    s.contents.set("/tmp/unmovable.epub", bytes);
    s.files.moveUpload.mockRejectedValueOnce(new Error("disk full"));

    await expect(s.library.importFile("/tmp/unmovable.epub", "unmovable.epub", { size: bytes.length, contentHash: hash }))
      .rejects.toThrow("disk full");

    expect(s.books.count()).toBe(0);
    expect(s.ignored.hasHash(hash)).toBe(true);
  });

  it("lists ignored entries with the derived reason and paginates newest first", () => {
    const s = harness();
    s.ignored.saveMany([
      { id: "both", path: "/lib/a.epub", sourceId: "src", contentHash: sha("a"), size: 5,
        title: "A", author: "", format: "epub", managed: false, ignoredAt: 1 },
      { id: "content", path: null, sourceId: null, contentHash: sha("b"), size: 5,
        title: "B", author: "", format: "pdf", managed: true, ignoredAt: 2 },
      { id: "path", path: "/lib/c.epub", sourceId: "src", contentHash: null, size: 5,
        title: "C", author: "", format: "epub", managed: false, ignoredAt: 3 },
    ]);
    const page = s.ignoredBooks.list(2, 0);
    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.id)).toEqual(["path", "content"]);
    expect(page.items.map((item) => item.reason)).toEqual(["path", "content"]);
    const all = s.ignoredBooks.list(100, 0);
    expect(all.items.find((item) => item.id === "both")?.reason).toBe("both");
  });
});
