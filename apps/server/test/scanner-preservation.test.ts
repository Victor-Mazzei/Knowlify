import { describe, expect, it, vi } from "vitest";

import { Scanner } from "../src/use-cases/Scanner.js";
import type { Book, BookRepository, FileEntry, FileStore, Source, SourceRepository, SourceBookSnapshot } from "../src/ports/index.js";

const book = (path: string): Book => ({ id: path, title: path, author: "", path, format: "pdf", cover_path: null,
  size: 1, added_at: 1, source_id: "source", mtime: 1, status: "ready" });

const entry = (name: string, path: string, directory = false): FileEntry =>
  ({ name, path, directory, file: !directory, symlink: false });

class MemoryBooks implements BookRepository {
  readonly rows = new Map<string, Book>();
  list() { return [...this.rows.values()]; }
  catalog() { return this.list(); }
  get(id: string) { return this.rows.get(id); }
  byPath(path: string) { return this.list().find((row) => row.path === path); }
  save(row: Book) { this.rows.set(row.id, row); }
  delete(id: string) { this.rows.delete(id); }
  forSource(id: string) { return this.list().filter((row) => row.source_id === id); }
  deleteSource(id: string) { for (const row of this.forSource(id)) this.delete(row.id); }
  pending(limit: number) { return this.list().filter((row) => row.status === "pending").slice(0, limit); }
  pendingCount() { return this.list().filter((row) => row.status === "pending").length; }
  count() { return this.rows.size; }
  snapshotForSource(id: string): Map<string, SourceBookSnapshot> {
    return new Map(this.forSource(id).map((row): [string, SourceBookSnapshot] => [row.path, { id: row.id, mtime: row.mtime, size: row.size }]));
  }
  countForSource(id: string) { return this.forSource(id).length; }
  updateMetadataMany(books: Book[]) {
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
  saveMany(books: Book[]) { books.forEach((row) => this.save(row)); }
  deleteMany(ids: string[]) { ids.forEach((id) => this.delete(id)); }
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

function setup() {
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
    writeCover: async () => "",
    remove: async () => {},
    removeManaged: async () => false,
  };
  const metadata = { pdf: { extract: async () => ({}) }, epub: { extract: async () => ({}) } };
  const log = { info: vi.fn(), error: vi.fn() };
  const scanner = new Scanner(books, sources, files, { now: () => 1 }, { next: () => String(++next) }, metadata, log);
  sources.save({ id: "source", path: "/library" });
  return { books, files, log, scanner };
}

const paths = (books: MemoryBooks) => books.list().map((row) => row.path).sort();

describe("Scanner preserves the index when a scan cannot see the truth", () => {
  it("keeps books under an unreadable subtree and still removes the others", async () => {
    const s = setup();
    for (const path of [
      "/library/removed.pdf",
      "/library/series/visible.pdf",
      "/library/series/locked/kept.pdf",
      "/library/series/locked-extra/gone.pdf",
    ]) s.books.save(book(path));
    vi.mocked(s.files.entries).mockImplementation(async (dir) => {
      if (dir === "/library") return [entry("series", "/library/series", true)];
      if (dir === "/library/series") return [
        entry("visible.pdf", "/library/series/visible.pdf"),
        entry("locked", "/library/series/locked", true),
        entry("locked-extra", "/library/series/locked-extra", true),
      ];
      if (dir === "/library/series/locked") throw new Error("EACCES");
      return [];
    });

    await s.scanner.scan();

    expect(paths(s.books)).toEqual([
      "/library/series/locked/kept.pdf",
      "/library/series/visible.pdf",
    ]);
    expect(s.log.error).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("keeping indexed books under it"));
  });

  it("keeps a book whose stat failed while removing files that truly vanished", async () => {
    const s = setup();
    for (const path of ["/library/steady.pdf", "/library/flaky.pdf", "/library/gone.pdf"]) s.books.save(book(path));
    vi.mocked(s.files.entries).mockResolvedValue([
      entry("steady.pdf", "/library/steady.pdf"),
      entry("flaky.pdf", "/library/flaky.pdf"),
    ]);
    vi.mocked(s.files.stat).mockImplementation(async (path) => {
      if (path === "/library/flaky.pdf") throw new Error("EACCES");
      return { size: 1, mtime: 1 };
    });

    await s.scanner.scan();

    expect(paths(s.books)).toEqual(["/library/flaky.pdf", "/library/steady.pdf"]);
  });

  it("keeps every indexed book when the source suddenly looks empty", async () => {
    const s = setup();
    for (const path of ["/library/a.pdf", "/library/sub/b.pdf"]) s.books.save(book(path));
    vi.mocked(s.files.entries).mockResolvedValue([]);

    await s.scanner.scan();

    expect(paths(s.books)).toEqual(["/library/a.pdf", "/library/sub/b.pdf"]);
    expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining("keeping 2 indexed books"));
  });

  it("removes a book whose file is really gone", async () => {
    const s = setup();
    for (const path of ["/library/kept.pdf", "/library/removed.pdf"]) s.books.save(book(path));
    vi.mocked(s.files.entries).mockResolvedValue([entry("kept.pdf", "/library/kept.pdf")]);

    await s.scanner.scan();

    expect(paths(s.books)).toEqual(["/library/kept.pdf"]);
  });
});
