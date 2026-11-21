import { describe, expect, it, vi } from "vitest";

import { Scanner } from "../src/use-cases/Scanner.js";
import type { Book, BookRepository, FileEntry, FileStore, Source, SourceRepository, SourceBookSnapshot } from "../src/ports/index.js";

const book = (path: string, overrides: Partial<Book> = {}): Book => ({
  id: `id-${path}`, title: path, author: "", path, format: "epub", cover_path: null,
  size: 1, added_at: 1, source_id: "source", mtime: 1, status: "ready", ...overrides,
});

const entry = (name: string, path: string): FileEntry => ({ name, path, directory: false, file: true, symlink: false });

class MemoryBooks implements BookRepository {
  readonly rows = new Map<string, Book>();
  readonly saveManySizes: number[] = [];
  readonly updateManySizes: number[] = [];
  readonly deleteManySizes: number[] = [];
  snapshotCalls = 0;
  countForSourceCalls = 0;
  byPathCalls = 0;
  list() { return [...this.rows.values()]; }
  catalog() { return this.list(); }
  get(id: string) { return this.rows.get(id); }
  byPath(path: string) { this.byPathCalls += 1; return this.list().find((row) => row.path === path); }
  save(row: Book) { this.rows.set(row.id, row); }
  delete(id: string) { this.rows.delete(id); }
  forSource(id: string) { return this.list().filter((row) => row.source_id === id); }
  deleteSource(id: string) { for (const row of this.forSource(id)) this.delete(row.id); }
  pending(limit: number) { return this.list().filter((row) => row.status === "pending").slice(0, limit); }
  pendingCount() { return this.list().filter((row) => row.status === "pending").length; }
  count() { return this.rows.size; }
  snapshotForSource(id: string): Map<string, SourceBookSnapshot> {
    this.snapshotCalls += 1;
    return new Map(this.forSource(id).map((row): [string, SourceBookSnapshot] => [row.path, { id: row.id, mtime: row.mtime, size: row.size }]));
  }
  countForSource(id: string) {
    this.countForSourceCalls += 1;
    return this.forSource(id).length;
  }
  saveMany(books: Book[]) {
    this.saveManySizes.push(books.length);
    books.forEach((row) => this.rows.set(row.id, row));
  }
  updateMetadataMany(books: Book[]) {
    this.updateManySizes.push(books.length);
    const updated: string[] = [];
    for (const book of books) {
      const row = this.rows.get(book.id);
      if (!row || row.mtime !== book.mtime || row.size !== book.size) continue;
      this.rows.set(book.id, { ...row, title: book.title, author: book.author,
        cover_path: book.cover_path, status: book.status });
      updated.push(book.id);
    }
    return updated;
  }
  deleteMany(ids: string[]) {
    this.deleteManySizes.push(ids.length);
    ids.forEach((id) => this.rows.delete(id));
  }
  bySize(size: number, excludePath?: string) { return this.list().filter((row) => row.size === size && row.path !== excludePath); }
  sizesPresent(sizes: number[]) { return new Set(this.list().filter((row) => sizes.includes(row.size)).map((row) => row.size)); }
  setContentHashIfCurrent(id: string, hash: string, size: number, mtime: number | null, observedMtime?: number) {
    const row = this.rows.get(id);
    if (!row || row.size !== size) return false;
    if (mtime === null && observedMtime !== undefined) {
      if (row.mtime !== null) return false;
      this.rows.set(id, { ...row, content_hash: hash, mtime: observedMtime });
      return true;
    }
    if (row.mtime !== mtime) return false;
    this.rows.set(id, { ...row, content_hash: hash });
    return true;
  }
  clearContentHashIfCurrent(id: string, size: number, mtime: number | null) {
    const row = this.rows.get(id);
    if (!row || row.size !== size || row.mtime !== mtime) return false;
    this.rows.set(id, { ...row, content_hash: null });
    return true;
  }
  seedContentHashes() {}
}

class MemorySources implements SourceRepository {
  readonly rows = new Map<string, Source>();
  list() { return [...this.rows.values()]; }
  byPath(path: string) { return this.list().find((source) => source.path === path); }
  save(source: Source) { this.rows.set(source.id, source); }
  delete(id: string) { return this.rows.delete(id); }
}

function setup(options: ConstructorParameters<typeof Scanner>[9] = {}, stubPending = true) {
  const books = new MemoryBooks();
  const sources = new MemorySources();
  let next = 0;
  const files: FileStore = {
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
    entries: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 1, mtime: 1 })),
    statIfExists: vi.fn(async () => ({ size: 1, mtime: 1 })),
    managedPath: (id, format) => `/${id}.${format}`,
    moveUpload: async () => "",
    writeCover: async (id) => `/covers/${id}.jpg`,
    remove: async () => {},
    removeManaged: async () => false,
  };
  const metadata = { pdf: { extract: vi.fn(async () => ({ title: "pdf" })) }, epub: { extract: vi.fn(async () => ({ title: "epub" })) } };
  const log = { info: vi.fn(), error: vi.fn() };
  const scheduler = { schedule: vi.fn() };
  const scanner = new Scanner(books, sources, files, { now: () => 1 }, { next: () => String(++next) }, metadata, log, scheduler, [], options);
  sources.save({ id: "source", path: "/library" });
  if (stubPending) scanner.processPending = async () => {};
  return { books, sources, files, metadata, log, scheduler, scanner };
}

describe("Scanner writes and deletes in batches", () => {
  it("reads the source snapshot once and saves new files in blocks of 500", async () => {
    const s = setup({ writeBlockSize: 500, scanConcurrency: 8 });
    const files = Array.from({ length: 1201 }, (_, index) => entry(`b${index}.epub`, `/library/b${index}.epub`));
    vi.mocked(s.files.entries).mockResolvedValue(files);

    await s.scanner.scan();

    expect(s.books.snapshotCalls).toBe(1);
    expect(s.books.byPathCalls).toBe(0);
    expect(s.books.saveManySizes).toEqual([500, 500, 201]);
    expect(s.books.rows.size).toBe(1201);
  });

  it("counts a source's books without loading its snapshot", async () => {
    const s = setup();
    s.books.save(book("/library/a.epub"));
    s.books.save(book("/library/b.epub"));

    const [source] = await s.scanner.listSources();

    expect(source).toMatchObject({ id: "source", accessible: true, books: 2 });
    expect(s.books.countForSourceCalls).toBe(1);
    expect(s.books.snapshotCalls).toBe(0);
  });

  it("removes vanished books with deleteMany batches of at most 100", async () => {
    const s = setup({ deleteBatchSize: 100 });
    for (let index = 0; index < 250; index += 1) s.books.save(book(`/library/old${index}.epub`));
    vi.mocked(s.files.entries).mockResolvedValue([entry("kept.epub", "/library/kept.epub")]);
    vi.mocked(s.files.stat).mockResolvedValue({ size: 1, mtime: 1 });

    await s.scanner.scan();

    expect(s.books.deleteManySizes).toEqual([100, 100, 50]);
    expect(s.books.list().map((row) => row.path)).toEqual(["/library/kept.epub"]);
  });

  it("removes a source in the same batches and keeps notes untouched", async () => {
    const s = setup({ deleteBatchSize: 100 });
    for (let index = 0; index < 250; index += 1) s.books.save(book(`/library/old${index}.epub`));

    await expect(s.scanner.removeSource("source")).resolves.toBe(true);

    expect(s.books.deleteManySizes).toEqual([100, 100, 50]);
    expect(s.books.rows.size).toBe(0);
    expect(s.sources.rows.size).toBe(0);
  });

  it("does not reprocess an unchanged file and resets changed ones to pending", async () => {
    const s = setup();
    s.books.save(book("/library/same.epub"));
    vi.mocked(s.files.entries).mockResolvedValue([entry("same.epub", "/library/same.epub")]);
    vi.mocked(s.files.stat).mockResolvedValue({ size: 1, mtime: 1 });

    await s.scanner.scan();
    expect(s.books.saveManySizes).toEqual([]);

    vi.mocked(s.files.stat).mockResolvedValue({ size: 2, mtime: 2 });
    await s.scanner.scan();
    expect(s.books.saveManySizes).toEqual([1]);
    expect(s.books.get("id-/library/same.epub")).toMatchObject({ size: 2, mtime: 2, status: "pending" });
  });

  it("resumes pending work after a restart and schedules only after the batch is updated", async () => {
    const s = setup({ metadataWorkers: 2, pendingReadBatch: 2 }, false);
    for (let index = 0; index < 5; index += 1) s.books.save(book(`/library/p${index}.epub`, { status: "pending" }));

    await s.scanner.processPending();

    expect(s.books.rows.size).toBe(5);
    expect([...s.books.rows.values()].every((row) => row.status === "ready")).toBe(true);
    expect(s.books.updateManySizes).toEqual([2, 2, 1]);
    expect(s.books.saveManySizes).toEqual([]);
    expect(s.scheduler.schedule).toHaveBeenCalledTimes(5);
    expect(s.metadata.epub.extract).toHaveBeenCalledTimes(5);
  });
});
