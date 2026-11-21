import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository, SqliteNoteRepository, SqliteSourceRepository } from "../src/adapters/storage/repositories.js";
import { Scanner, type ScannerOptions } from "../src/use-cases/Scanner.js";
import type { Book, Extracted, FileEntry, FileStore, MetadataExtractor } from "../src/ports/index.js";

const clock = { now: () => 1 };
const ids = { next: (() => { let next = 0; return () => `id-${++next}`; })() };
const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Let every already-scheduled microtask run, including a resolved extractor's continuation. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const book = (id: string, path: string, overrides: Partial<Book> = {}): Book => ({
  id, title: id, author: "", format: "epub", path, cover_path: null, size: 1,
  added_at: 1, source_id: "source", mtime: 1, status: "pending", ...overrides,
});

function files(entries: FileStore["entries"] = async () => []): FileStore {
  return {
    extension: (path) => path.split(".").at(-1)?.toLowerCase() ?? "",
    title: (path) => path,
    join: (...parts) => parts.join("/"),
    resolve: (path) => path,
    realpath: async (path) => path,
    parent: () => "/",
    isRoot: (path) => path === "/",
    isWindows: false,
    home: "/home",
    isDirectory: async () => true,
    accessible: async () => true,
    entries,
    stat: vi.fn(async () => ({ size: 1, mtime: 1 })),
    statIfExists: vi.fn(async () => ({ size: 1, mtime: 1 })),
    managedPath: (id, format) => `/${id}.${format}`,
    moveUpload: async () => "",
    writeCover: async (id) => `/covers/${id}.jpg`,
    remove: vi.fn(async () => {}),
    removeManaged: vi.fn(async () => false),
  };
}

function setup(metadata: Record<Book["format"], MetadataExtractor>, options: ScannerOptions = {}, stubPending = true) {
  const database: Db = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const sources = new SqliteSourceRepository(database);
  const notes = new SqliteNoteRepository(database);
  const store = files();
  const scheduler = { schedule: vi.fn() };
  const scanner = new Scanner(books, sources, store, clock, ids, metadata,
    { info: vi.fn(), error: vi.fn() }, scheduler, [], options);
  if (stubPending) scanner.processPending = async () => {};
  return { database, books, sources, notes, files: store, scheduler, scanner };
}

function extractorPair() {
  const a = deferred<Extracted>();
  const b = deferred<Extracted>();
  const extract = vi.fn((path: string) => path.endsWith("/a.epub") ? a.promise : b.promise);
  const metadata: Record<Book["format"], MetadataExtractor> = {
    epub: { extract },
    pdf: { extract: vi.fn(async () => ({})) },
  };
  return { a, b, extract, metadata };
}

describe("Scanner deferred metadata writes never resurrect deleted books", () => {
  it("keeps a source book deleted while another extraction in the batch is still pending", async () => {
    const { a, b, extract, metadata } = extractorPair();
    const s = setup(metadata, {}, false);
    s.sources.save({ id: "source", path: "/library" });
    s.books.save(book("a", "/library/a.epub"));
    s.books.save(book("b", "/library/b.epub"));

    const processing = s.scanner.processPending();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));

    a.resolve({ title: "A" });
    await turn();
    await s.scanner.removeSource("source");
    expect(s.books.get("a")).toBeUndefined();

    b.resolve({ title: "B" });
    await processing;

    expect(s.books.get("a")).toBeUndefined();
    expect(s.books.get("b")).toBeUndefined();
    expect(s.books.count()).toBe(0);
    expect(s.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("keeps an individually deleted book removed while another extraction is pending", async () => {
    const { a, b, extract, metadata } = extractorPair();
    const s = setup(metadata, {}, false);
    s.books.save(book("a", "/uploads/a.epub", { source_id: null }));
    s.books.save(book("b", "/uploads/b.epub", { source_id: null }));

    const processing = s.scanner.processPending();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));

    a.resolve({ title: "A" });
    await turn();
    s.books.deleteMany(["a"]);

    b.resolve({ title: "B" });
    await processing;

    expect(s.books.get("a")).toBeUndefined();
    expect(s.books.get("b")).toMatchObject({ status: "ready", title: "B" });
    expect(s.scheduler.schedule).toHaveBeenCalledTimes(1);
    expect(s.scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), 0);
  });

  it("does not write books from a source removed while its scan is in flight", async () => {
    const entries = deferred<FileEntry[]>();
    const s = setup({ epub: { extract: vi.fn(async () => ({})) }, pdf: { extract: vi.fn(async () => ({})) } });
    s.sources.save({ id: "source", path: "/library" });
    s.files.entries = vi.fn(() => entries.promise);

    const scanning = s.scanner.scan();
    await vi.waitFor(() => expect(s.files.entries).toHaveBeenCalled());
    await expect(s.scanner.removeSource("source")).resolves.toBe(true);

    entries.resolve([{ name: "book.epub", path: "/library/book.epub", directory: false, file: true, symlink: false }]);
    await scanning;

    expect(s.books.count()).toBe(0);
    expect(s.sources.list()).toEqual([]);
    expect(s.scheduler.schedule).not.toHaveBeenCalled();
  });

  it("leaves a rescan pending when metadata finishes for an older file version", async () => {
    const oldA = deferred<Extracted>();
    const b = deferred<Extracted>();
    const newA = deferred<Extracted>();
    let calls = 0;
    const extract = vi.fn(() => {
      calls += 1;
      if (calls === 1) return oldA.promise;
      if (calls === 2) return b.promise;
      return newA.promise;
    });
    const metadata: Record<Book["format"], MetadataExtractor> = {
      epub: { extract }, pdf: { extract: vi.fn(async () => ({})) },
    };
    const s = setup(metadata, {}, false);
    s.books.save(book("a", "/library/a.epub"));
    s.books.save(book("b", "/library/b.epub"));

    const processing = s.scanner.processPending();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));

    oldA.resolve({ title: "A old" });
    await turn();
    s.books.save({ ...s.books.get("a")!, title: "rescanned", mtime: 2, size: 2, status: "pending" });
    b.resolve({ title: "B" });

    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(3));
    expect(s.books.get("a")).toMatchObject({ title: "rescanned", status: "pending", mtime: 2, size: 2 });
    expect(s.books.get("b")).toMatchObject({ title: "B", status: "ready" });

    newA.resolve({ title: "A new" });
    await processing;

    expect(s.books.get("a")).toMatchObject({ title: "A new", status: "ready", mtime: 2, size: 2 });
    expect(s.scheduler.schedule).toHaveBeenCalledTimes(2);
  });
});
