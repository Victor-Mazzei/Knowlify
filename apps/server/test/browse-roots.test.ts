import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { BrowseRoots, isWithinRoot } from "../src/domain/library/BrowseRoots.js";
import { BrowseFolders } from "../src/use-cases/BrowseFolders.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import { DiskFileStore } from "../src/adapters/files/FileStore.js";
import type { Book, BookRepository, FileStore, Source, SourceRepository, SourceBookSnapshot } from "../src/ports/index.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "knowlify-browse-")));
const library = join(root, "library");
const sibling = join(root, "library2");
const outside = join(root, "outside");
await mkdir(join(library, "sub"), { recursive: true });
await mkdir(join(sibling, "nested"), { recursive: true });
await mkdir(join(outside, "deep"), { recursive: true });
await writeFile(join(library, "book.pdf"), "");
await writeFile(join(outside, "outside.pdf"), "");
if (process.platform !== "win32") {
  await symlink(outside, join(library, "escape"), "dir");
  await symlink(join(library, "sub"), join(library, "inside"), "dir");
}

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const files = new DiskFileStore(join(root, "books"), join(root, "covers"));

describe("browse roots", () => {
  it("compares path segments, not string prefixes", () => {
    expect(isWithinRoot("/library", "/library")).toBe(true);
    expect(isWithinRoot("/library", "/library/books")).toBe(true);
    expect(isWithinRoot("/library", "/library2")).toBe(false);
    expect(isWithinRoot("/library", "/library/../etc")).toBe(false);
    expect(isWithinRoot("/library", "/etc")).toBe(false);
    expect(isWithinRoot("/library", "/library-other/deep")).toBe(false);
  });

  it("lists only existing roots, canonicalized and without duplicates", async () => {
    const roots = new BrowseRoots([library, join(root, "missing"), library], (path) => realpath(path));
    expect(await roots.list()).toEqual([{ name: "library", path: await realpath(library) }]);
    expect(await roots.contains(library)).toBe(true);
    expect(await roots.contains(sibling)).toBe(false);
  });

  it("is unrestricted when the allowlist is empty", async () => {
    const roots = new BrowseRoots([], (path) => realpath(path));
    expect(roots.restricted).toBe(false);
    expect(await roots.contains(sibling)).toBe(true);
  });
});

describe("BrowseFolders", () => {
  it("keeps the historical unrestricted listing", async () => {
    const folders = new BrowseFolders(files, [], []);
    const listing = await folders.execute(library);
    expect(listing).toMatchObject({ path: library, parent: root, books: 1, restricted: false });
    expect(listing.entries).toContainEqual({ name: "sub", path: join(library, "sub") });
    expect((await folders.execute(sibling)).path).toBe(sibling);
  });

  it("lists the roots when several are configured", async () => {
    const folders = new BrowseFolders(files, [], [library, outside]);
    expect(await folders.execute()).toEqual({
      path: "",
      parent: null,
      books: 0,
      restricted: true,
      entries: [
        { name: "library", path: library },
        { name: "outside", path: outside },
      ],
    });
  });

  it("enters the only configured root", async () => {
    const folders = new BrowseFolders(files, [], [library]);
    const listing = await folders.execute();
    expect(listing).toMatchObject({ path: library, parent: null, books: 1, restricted: true });
    expect(listing.entries).toContainEqual({ name: "sub", path: join(library, "sub") });
  });

  it("browses inside a root and stops at the root boundary", async () => {
    const folders = new BrowseFolders(files, [], [library]);
    expect(await folders.execute(join(library, "sub"))).toMatchObject({
      path: join(library, "sub"),
      parent: library,
      restricted: true,
    });
    expect(await folders.execute(join(library, "inside"))).toMatchObject({
      path: join(library, "sub"),
      parent: library,
    });
  });

  it("rejects paths outside the roots and sibling prefixes", async () => {
    const folders = new BrowseFolders(files, [], [library]);
    for (const path of [sibling, outside, join(library, "..", "outside"), join(library, "..", "library2")]) {
      await expect(folders.execute(path)).rejects.toThrow("outside the folders Knowlify may browse");
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlink that escapes the roots", async () => {
    const folders = new BrowseFolders(files, [], [library]);
    await expect(folders.execute(join(library, "escape"))).rejects.toThrow("outside the folders Knowlify may browse");
  });

  it("keeps listing the Windows drives when unrestricted", async () => {
    const folders = new BrowseFolders(windowsFiles(), [], []);
    expect(await folders.execute("")).toMatchObject({
      path: "",
      parent: null,
      restricted: false,
      entries: [
        { name: "C:\\", path: "C:\\" },
        { name: "D:\\", path: "D:\\" },
      ],
    });
  });
});

describe("Scanner sources", () => {
  it("rejects a new source outside the roots and accepts one inside", async () => {
    const setup = scannerSetup([library]);
    await expect(setup.scanner.addReadableSource(sibling)).rejects.toThrow("outside the folders Knowlify may browse");
    await expect(setup.scanner.addReadableSource(join(library, "..", "outside"))).rejects.toThrow("outside the folders Knowlify may browse");
    const added = await setup.scanner.addReadableSource(join(library, "sub"));
    expect(added.path).toBe(join(library, "sub"));
  });

  it("still scans sources that were registered before the allowlist", async () => {
    const setup = scannerSetup([library]);
    setup.scanner.addSource(outside);
    await setup.scanner.scan();
    expect(setup.books.list().map((book) => book.path)).toContain(join(outside, "outside.pdf"));
  });

  it("accepts any readable folder when unrestricted", async () => {
    const setup = scannerSetup([]);
    await expect(setup.scanner.addReadableSource(outside)).resolves.toMatchObject({ path: outside });
  });
});

function scannerSetup(browseRoots: string[]) {
  const books = new MemoryBooks();
  const sources = new MemorySources();
  let next = 0;
  const scanner = new Scanner(
    books,
    sources,
    files,
    { now: () => 1 },
    { next: () => String(++next) },
    { pdf: { extract: async () => ({}) }, epub: { extract: async () => ({}) } },
    { info: vi.fn(), error: vi.fn() },
    undefined,
    browseRoots,
  );
  return { books, sources, scanner };
}

class MemoryBooks implements BookRepository {
  private readonly rows = new Map<string, Book>();
  list() { return [...this.rows.values()]; }
  catalog() { return this.list(); }
  get(id: string) { return this.rows.get(id); }
  byPath(path: string) { return this.list().find((book) => book.path === path); }
  save(book: Book) { this.rows.set(book.id, book); }
  delete(id: string) { this.rows.delete(id); }
  forSource(id: string) { return this.list().filter((book) => book.source_id === id); }
  deleteSource(id: string) { for (const book of this.forSource(id)) this.delete(book.id); }
  pending(limit: number) { return this.list().filter((book) => book.status === "pending").slice(0, limit); }
  pendingCount() { return this.list().filter((book) => book.status === "pending").length; }
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
  saveMany(books: Book[]) { books.forEach((book) => this.save(book)); }
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
  private readonly rows = new Map<string, Source>();
  list() { return [...this.rows.values()]; }
  byPath(path: string) { return this.list().find((source) => source.path === path); }
  save(source: Source) { this.rows.set(source.id, source); }
  delete(id: string) { return this.rows.delete(id); }
}

/** Minimal Windows-shaped store: only the drive listing path is exercised. */
function windowsFiles(): FileStore {
  return {
    extension: (path) => path.split(".").at(-1)?.toLowerCase() ?? "",
    title: (path) => path,
    join: (...parts) => parts.join("\\"),
    resolve: (path) => path,
    realpath: async (path) => path,
    parent: (path) => path,
    isRoot: () => false,
    isWindows: true,
    home: "C:\\Users\\knowlify",
    isDirectory: async () => true,
    accessible: async (path) => path === "C:\\" || path === "D:\\",
    entries: async () => [],
    stat: async () => ({ size: 0, mtime: 0 }),
    statIfExists: async () => ({ size: 0, mtime: 0 }),
    managedPath: (id, format) => `/${id}.${format}`,
    moveUpload: async () => "",
    writeCover: async () => "",
    remove: async () => {},
    removeManaged: async () => false,
  };
}
