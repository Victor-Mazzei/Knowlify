import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteNoteRepository,
  SqliteProgressRepository,
  SqliteSourceRepository,
} from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { ContentIdentity } from "../src/use-cases/ContentIdentity.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import { Library } from "../src/use-cases/Library.js";
import type { Book, FileEntry, FileStore, MetadataExtractor } from "../src/ports/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const clock = { now: () => 1000 };
let nextId = 0;
const ids = { next: () => `id-${++nextId}` };
const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const entry = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path, directory: false, file: true, symlink: false });

const book = (overrides: Partial<Book> & Pick<Book, "id" | "path">): Book => ({
  title: overrides.id,
  author: "",
  format: "epub",
  cover_path: null,
  size: 5,
  added_at: 1,
  source_id: "src",
  mtime: 1,
  status: "ready",
  ...overrides,
});

interface HarnessOptions {
  readonly metadata?: Record<Book["format"], MetadataExtractor>;
}

function harness(options: HarnessOptions = {}) {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const sources = new SqliteSourceRepository(database);
  const aliases = new SqliteBookDuplicateRepository(database);
  const notes = new SqliteNoteRepository(database);
  const progress = new SqliteProgressRepository(database);
  const indexes = new SqliteBookIndexRepository(database);
  const contents = new Map<string, string>();
  const stats = new Map<string, { size: number; mtime: number }>();
  const entries = new Map<string, FileEntry[]>();
  const covers = new Map<string, string>();
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
    moveUpload: vi.fn(async (tmp: string, id: string, format: string) => {
      const path = `/uploads/${id}.${format}`;
      stats.set(path, { size: 5, mtime: 0 });
      return path;
    }),
    writeCover: vi.fn(async (id: string) => {
      const path = `/covers/${id}.jpg`;
      covers.set(id, path);
      return path;
    }),
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
  const metadata = options.metadata ?? {
    epub: { extract: vi.fn(async () => ({ title: "meta" })) },
    pdf: { extract: vi.fn(async () => ({ title: "meta" })) },
  };
  const log = { info: vi.fn(), error: vi.fn() };
  const identity = new ContentIdentity(books, aliases, hasher, files, sources, clock);
  const scanner = new Scanner(books, sources, files, clock, ids, metadata, log, undefined, [], {},
    { identity, aliases });
  scanner.processPending = async () => {};
  const library = new Library(books, notes, files, clock, ids, metadata, undefined, undefined, undefined, identity);
  const addFile = (path: string, content: string, size = content.length, mtime = 1) => {
    contents.set(path, content);
    stats.set(path, { size, mtime });
  };
  const addDir = (path: string, filesInDir: string[]) => {
    entries.set(path, filesInDir.map(entry));
  };
  const note = (id: string, bookId: string) => database.prepare(`INSERT INTO notes
    (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',1,1)`).run(id, bookId);
  const progressRow = (bookId: string) => database.prepare(`INSERT INTO web_progress (book_id,position,percentage,updated_at)
    VALUES (?,'p',0.5,10)`).run(bookId);
  const indexRow = (bookId: string, contentHash: string) => database.prepare(`INSERT INTO book_index
    (book_id,state,content_hash,fingerprint,requested_at) VALUES (?,'ready',?,'5:1',1)`).run(bookId, contentHash);
  return { database, books, sources, aliases, notes, progress, indexes, contents, stats, entries, covers,
    files, hasher, metadata, log, identity, scanner, library, addFile, addDir, note, progressRow, indexRow, book };
}

describe("Scanner content identity", () => {
  it("keeps one book plus aliases across sources and reads no bytes on a warm rescan", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.addDir("/a", ["/a/book.epub"]);
    s.addDir("/b", ["/b/copy.epub"]);
    s.addFile("/a/book.epub", "same bytes");
    s.addFile("/b/copy.epub", "same bytes");

    await s.scanner.scan();

    expect(s.books.count()).toBe(1);
    expect(s.aliases.aliasSnapshotForSource("b").size).toBe(1);
    expect(s.scanner.status().skippedDuplicates).toBe(1);
    expect(s.scanner.status().movedFiles).toBe(0);

    s.hasher.hash.mockClear();
    await s.scanner.scan();
    expect(s.hasher.hash).not.toHaveBeenCalled();
    expect(s.books.count()).toBe(1);
    expect(s.aliases.aliasSnapshotForSource("b").size).toBe(1);
    expect(s.scanner.status().skippedDuplicates).toBe(0);
  });

  it("keeps a book when its whole source disappeared and aliases the copy instead of moving", async () => {
    const s = harness();
    s.sources.save({ id: "nas", path: "/nas" });
    s.sources.save({ id: "local", path: "/local" });
    s.books.save(s.book({ id: "book-1", path: "/nas/a.epub", source_id: "nas", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    // The NAS is unmounted: no entries for its root and every path below it answers ENOENT.
    s.addDir("/local", ["/local/copy.epub"]);
    s.addFile("/local/copy.epub", "bytes");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/nas/a.epub", source_id: "nas" });
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/local/copy.epub"]);
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.books.count()).toBe(1);
    expect(s.scanner.status().movedFiles).toBe(0);
  });

  it("serializes two simultaneous scans", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.addDir("/a", ["/a/book.epub"]);
    s.addFile("/a/book.epub", "once");

    await Promise.all([s.scanner.scan(), s.scanner.scan()]);

    expect(s.books.count()).toBe(1);
    expect(s.hasher.hash).not.toHaveBeenCalled();
  });

  it("treats a rename in the same folder as the same book and preserves user data", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    const oldPath = "/lib/old.epub";
    s.books.save(s.book({ id: "book-1", path: oldPath, content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.progressRow("book-1");
    s.indexRow("book-1", sha("bytes"));
    s.addDir("/lib", ["/lib/new.epub"]);
    s.addFile("/lib/new.epub", "bytes");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/lib/new.epub", source_id: "src", content_hash: sha("bytes") });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.progress.get("book-1")).toMatchObject({ percentage: 0.5 });
    expect(s.indexes.get("book-1")?.state).toBe("ready");
    expect(s.scanner.status().movedFiles).toBe(1);
  });

  it("follows a rename into another folder and another source", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    // The source was read to the end (it still has a file), so the missing canonical is
    // trusted as moved rather than preserved.
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    s.addDir("/b", ["/b/moved.epub"]);
    s.addFile("/b/moved.epub", "bytes");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/b/moved.epub", source_id: "b" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.scanner.status().movedFiles).toBe(1);
    expect(s.books.count()).toBe(2);
  });

  it("returns a remounted canonical path unchanged after an empty mount point", async () => {
    const s = harness();
    s.sources.save({ id: "nas", path: "/nas" });
    s.sources.save({ id: "local", path: "/local" });
    s.books.save(s.book({ id: "book-1", path: "/nas/a.epub", source_id: "nas", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.addDir("/nas", []);
    s.addDir("/local", ["/local/copy.epub"]);
    s.addFile("/local/copy.epub", "bytes");

    await s.scanner.scan();
    expect(s.books.count()).toBe(1);
    expect(s.books.get("book-1")).toMatchObject({ path: "/nas/a.epub" });
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/local/copy.epub"]);

    s.addDir("/nas", ["/nas/a.epub"]);
    s.addFile("/nas/a.epub", "bytes");
    await s.scanner.scan();

    expect(s.books.count()).toBe(1);
    expect(s.books.get("book-1")).toMatchObject({ path: "/nas/a.epub", source_id: "nas" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/local/copy.epub"]);
    expect(s.scanner.status().movedFiles).toBe(0);
  });

  it("returns an offline source's canonical path unchanged after it remounts", async () => {
    const s = harness();
    s.sources.save({ id: "nas", path: "/nas" });
    s.sources.save({ id: "local", path: "/local" });
    s.books.save(s.book({ id: "book-1", path: "/nas/a.epub", source_id: "nas", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.addDir("/local", ["/local/copy.epub"]);
    s.addFile("/local/copy.epub", "bytes");

    await s.scanner.scan();
    expect(s.books.count()).toBe(1);
    expect(s.books.get("book-1")).toMatchObject({ path: "/nas/a.epub" });
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/local/copy.epub"]);

    s.addDir("/nas", ["/nas/a.epub"]);
    s.addFile("/nas/a.epub", "bytes");
    await s.scanner.scan();

    expect(s.books.count()).toBe(1);
    expect(s.books.get("book-1")).toMatchObject({ path: "/nas/a.epub", source_id: "nas" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/local/copy.epub"]);
  });

  it("promotes a copy from another source when the canonical source was read and the file vanished", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.addDir("/a", ["/a/book.epub"]);
    s.addFile("/a/book.epub", "bytes");
    s.addDir("/b", ["/b/copy.epub"]);
    s.addFile("/b/copy.epub", "bytes");
    await s.scanner.scan();
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/b/copy.epub"]);

    // The canonical is deleted after the copy became an alias. The source was still read
    // (it has a kept file), so the alias seen in the other source takes over the book.
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/b/copy.epub", source_id: "b" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.books.count()).toBe(2);
    expect(s.scanner.status().movedFiles).toBe(1);
  });

  it("does not promote an alias when the canonical source was only partially read", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/locked/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.aliases.upsertAlias({ path: "/b/copy.epub", bookId: "book-1", sourceId: "b",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    s.addDir("/b", ["/b/copy.epub"]);
    s.addFile("/b/copy.epub", "bytes");
    const entries = s.files.entries;
    s.files.entries = vi.fn(async (path: string) => {
      if (path === "/a") {
        return [
          entry("/a/kept.epub"),
          { name: "locked", path: "/a/locked", directory: true, file: false, symlink: false },
        ];
      }
      if (path === "/a/locked") throw new Error("EACCES");
      return entries(path);
    });

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/a/locked/book.epub" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/b/copy.epub"]);
  });

  it("keeps the canonical row while a copy in an offline source cannot be verified, then promotes it on remount", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.progressRow("book-1");
    s.indexRow("book-1", sha("bytes"));
    s.aliases.upsertAlias({ path: "/b/copy.epub", bookId: "book-1", sourceId: "b",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    // Source A was read to the end and still has a file, so the canonical path is really gone.
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    // Source B is offline: its root cannot be listed, so the copy cannot be checked.

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ id: "book-1", path: "/a/book.epub", source_id: "a" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.progress.get("book-1")).toMatchObject({ percentage: 0.5 });
    expect(s.indexes.get("book-1")?.state).toBe("ready");
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/b/copy.epub"]);
    expect(s.books.count()).toBe(2);
    expect(s.scanner.status().movedFiles).toBe(0);

    // The source returns with the alias untouched: the book moves to it and keeps its id.
    s.addDir("/b", ["/b/copy.epub"]);
    s.addFile("/b/copy.epub", "bytes");
    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ id: "book-1", path: "/b/copy.epub", source_id: "b" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.progress.get("book-1")).toMatchObject({ percentage: 0.5 });
    expect(s.indexes.get("book-1")?.state).toBe("ready");
    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
    expect(s.scanner.status().movedFiles).toBe(1);
  });

  it("keeps the canonical row when the copy's stat failed in another source", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.aliases.upsertAlias({ path: "/b/copy.epub", bookId: "book-1", sourceId: "b",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    s.addDir("/b", ["/b/copy.epub", "/b/other.epub"]);
    s.addFile("/b/copy.epub", "bytes");
    s.addFile("/b/other.epub", "other");
    const original = s.files.stat;
    s.files.stat = vi.fn(async (path: string) => {
      if (path === "/b/copy.epub") throw new Error("EACCES");
      return original(path);
    });

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/a/book.epub", source_id: "a" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/b/copy.epub"]);
    expect(s.scanner.status().movedFiles).toBe(0);
  });

  it("keeps the canonical row when the copy is under an unreadable folder of a partially read source", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.aliases.upsertAlias({ path: "/b/locked/copy.epub", bookId: "book-1", sourceId: "b",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");
    s.addFile("/b/kept.epub", "b kept");
    const entries = s.files.entries;
    s.files.entries = vi.fn(async (path: string) => {
      if (path === "/b") {
        return [
          entry("/b/kept.epub"),
          { name: "locked", path: "/b/locked", directory: true, file: false, symlink: false },
        ];
      }
      if (path === "/b/locked") throw new Error("EACCES");
      return entries(path);
    });

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/a/book.epub", source_id: "a" });
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/b/locked/copy.epub"]);
    expect(s.scanner.status().movedFiles).toBe(0);
  });

  it("removes the book when its canonical and every alias are definitively gone", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.aliases.upsertAlias({ path: "/a/copy.epub", bookId: "book-1", sourceId: "a",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.progressRow("book-1");
    s.indexRow("book-1", sha("bytes"));
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toBeUndefined();
    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
    expect(s.progress.get("book-1")).toBeUndefined();
    expect(s.indexes.get("book-1")).toBeUndefined();
    expect(s.books.count()).toBe(1);
  });

  it("removes the book when the only alias is a duplicate upload path that never existed", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.aliases.upsertAlias({ path: "/uploads/ghost.epub", bookId: "book-1", sourceId: null,
      size: 5, mtime: null, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/a", ["/a/kept.epub"]);
    s.addFile("/a/kept.epub", "kept");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toBeUndefined();
    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
  });

  it("treats a same-size file with different bytes as a new book", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.addDir("/lib", ["/lib/a.epub", "/lib/b.epub"]);
    s.addFile("/lib/a.epub", "aaaaa");
    s.addFile("/lib/b.epub", "bbbbb");

    await s.scanner.scan();

    expect(s.books.count()).toBe(2);
    expect(s.aliases.aliasSnapshotForSource("src").size).toBe(0);
    expect(s.books.list().map((row) => row.content_hash).sort()).toEqual([sha("aaaaa"), sha("bbbbb")].sort());
  });

  it("promotes an alias when the canonical path disappears, keeping the id", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/a.epub", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.progressRow("book-1");
    s.indexRow("book-1", sha("bytes"));
    s.aliases.upsertAlias({ path: "/lib/copy.epub", bookId: "book-1", sourceId: "src",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/lib", ["/lib/copy.epub"]);
    s.addFile("/lib/copy.epub", "bytes");

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ id: "book-1", path: "/lib/copy.epub" });
    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.progress.get("book-1")).toBeDefined();
    expect(s.indexes.get("book-1")?.state).toBe("ready");
    expect(s.scanner.status().movedFiles).toBe(1);
  });

  it("promotes a copy from another source when a source is removed", async () => {
    const s = harness();
    s.sources.save({ id: "a", path: "/a" });
    s.sources.save({ id: "b", path: "/b" });
    s.books.save(s.book({ id: "book-1", path: "/a/book.epub", source_id: "a", content_hash: sha("bytes") }));
    s.note("n1", "book-1");
    s.aliases.upsertAlias({ path: "/b/copy.epub", bookId: "book-1", sourceId: "b",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });

    await s.scanner.removeSource("a");

    expect(s.books.get("book-1")).toMatchObject({ path: "/b/copy.epub", source_id: "b" });
    expect(s.notes.list("book-1")).toHaveLength(1);
    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
    expect(s.sources.list().map((source) => source.id)).toEqual(["b"]);
  });

  it("keeps aliases whose stat failed while other files are still visible", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/a.epub", content_hash: sha("bytes") }));
    s.aliases.upsertAlias({ path: "/lib/copy.epub", bookId: "book-1", sourceId: "src",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/lib", ["/lib/a.epub", "/lib/copy.epub", "/lib/other.epub"]);
    s.addFile("/lib/other.epub", "other");
    const original = s.files.stat;
    s.files.stat = vi.fn(async (path: string) => {
      if (path === "/lib/a.epub" || path === "/lib/copy.epub") throw new Error("EACCES");
      return original(path);
    });

    await s.scanner.scan();

    expect(s.books.get("book-1")).toMatchObject({ path: "/lib/a.epub" });
    expect(s.aliases.aliasesForBook("book-1").map((alias) => alias.path)).toEqual(["/lib/copy.epub"]);
  });

  it("keeps books and aliases when a source looks unmounted", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/a.epub", content_hash: sha("bytes") }));
    s.aliases.upsertAlias({ path: "/lib/alias.epub", bookId: "book-1", sourceId: "src",
      size: 5, mtime: 1, contentHash: sha("bytes"), detectedAt: 1 });
    s.addDir("/lib", []);

    await s.scanner.scan();

    expect(s.books.get("book-1")).toBeDefined();
    expect(s.aliases.aliasesForBook("book-1")).toHaveLength(1);
  });

  it("re-evaluates a changed file's hash and stops treating a changed alias as a copy", async () => {
    const s = harness();
    s.sources.save({ id: "src", path: "/lib" });
    s.books.save(s.book({ id: "book-1", path: "/lib/a.epub", content_hash: sha("aaaaa") }));
    s.aliases.upsertAlias({ path: "/lib/copy.epub", bookId: "book-1", sourceId: "src",
      size: 5, mtime: 1, contentHash: sha("aaaaa"), detectedAt: 1 });
    s.addDir("/lib", ["/lib/a.epub", "/lib/copy.epub"]);
    s.addFile("/lib/a.epub", "aaaaa", 5, 2);
    s.addFile("/lib/copy.epub", "bbbbb", 5, 2);

    await s.scanner.scan();

    expect(s.aliases.aliasesForBook("book-1")).toEqual([]);
    expect(s.books.get("book-1")?.content_hash).toBe(sha("aaaaa"));
    const newBook = s.books.list().find((row) => row.path === "/lib/copy.epub");
    expect(newBook?.content_hash).toBe(sha("bbbbb"));
    expect(s.books.count()).toBe(2);
  });

  it("dedupes an upload that commits while a scan is hashing another file", async () => {
    const s = harness({ metadata: {
      epub: { extract: vi.fn(async () => ({ title: "uploaded" })) },
      pdf: { extract: vi.fn(async () => ({ title: "uploaded" })) },
    } });
    s.sources.save({ id: "src", path: "/lib" });
    // Same size, different content, already hashed: forces the scan to read the new file.
    s.books.save(s.book({ id: "other", path: "/lib/other.epub", content_hash: sha("other") }));
    s.addDir("/lib", ["/lib/scan.epub", "/lib/other.epub"]);
    s.addFile("/lib/other.epub", "other");
    s.addFile("/lib/scan.epub", "uploa");
    const tmp = "/tmp/upload";
    s.stats.set(tmp, { size: 5, mtime: 0 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.hasher.hash.mockImplementation(async (path: string) => {
      if (path === "/lib/scan.epub") await gate;
      return sha(s.contents.get(path)!);
    });

    const scanning = s.scanner.scan();
    await vi.waitFor(() => expect(s.hasher.hash).toHaveBeenCalledWith("/lib/scan.epub"));
    const imported = await s.library.importFile(tmp, "upload.epub", { size: 5, contentHash: sha("uploa") });
    expect(imported.duplicate).toBe(false);
    release();
    await scanning;

    expect(s.books.count()).toBe(2);
    expect(s.aliases.aliasesForBook(imported.book.id).map((alias) => alias.path)).toContain("/lib/scan.epub");
    expect(s.scanner.status().skippedDuplicates).toBe(1);
  });
});
