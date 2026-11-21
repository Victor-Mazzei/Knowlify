import { describe, expect, it, vi } from "vitest";
import { supportedFormat, sourceBookId } from "../src/domain/library/Book.js";
import { noteBody } from "../src/domain/reading/Note.js";
import { ValidationError, NotFoundError } from "../src/domain/errors.js";
import { Library } from "../src/use-cases/Library.js";
import { Notes } from "../src/use-cases/Notes.js";
import { Scanner } from "../src/use-cases/Scanner.js";
import { Progress, SyncProgress } from "../src/use-cases/Progress.js";
import type { Book, BookRepository, Note, NoteRepository, Source, SourceRepository, FileStore, SourceBookSnapshot } from "../src/ports/index.js";

const book = (id = "book"): Book => ({ id, title: id, author: "", path: `/${id}.pdf`, format: "pdf", cover_path: null, size: 1,
  added_at: 1, source_id: null, mtime: 1, status: "ready" });
class MemoryBooks implements BookRepository {
  rows = new Map<string, Book>();
  list() { return [...this.rows.values()]; }
  catalog() { return this.list(); }
  get(id: string) { return this.rows.get(id); }
  byPath(path: string) { return this.list().find(b => b.path === path); }
  save(b: Book) { this.rows.set(b.id, b); }
  delete(id: string) { this.rows.delete(id); }
  forSource(id: string) { return this.list().filter(b => b.source_id === id); }
  deleteSource(id: string) { this.forSource(id).forEach(b => this.delete(b.id)); }
  pending(n: number) { return this.list().filter(b => b.status === "pending").slice(0, n); }
  pendingCount() { return this.pending(Infinity).length; }
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
class MemoryNotes implements NoteRepository {
  rows = new Map<string, Note>();
  search() { return [...this.rows.values()].map(n => ({ ...n, book_title: "title" })); }
  list(id: string) { return [...this.rows.values()].filter(n => n.book_id === id); }
  groups() { return { rows: [], nextAnchor: null }; }
  forGroups() { return []; }
  booksForGroups() { return []; }
  countMatching() { return { books: 0, notes: 0 }; }
  listMatching(bookId: string, q: string) {
    return this.list(bookId).filter(n => [n.body, n.quote, n.label].some(value => value.includes(q)));
  }
  get(id: string) { return this.rows.get(id); }
  save(n: Note) { this.rows.set(n.id, n); }
  delete(id: string) { return this.rows.delete(id); }
  deleteForBook(id: string) { this.list(id).forEach(n => this.delete(n.id)); }
  countForBooks(bookIds: string[]) { return bookIds.reduce((total, id) => total + this.list(id).length, 0); }
  reassign(fromBookId: string, toBookId: string) {
    const notes = this.list(fromBookId);
    notes.forEach((note) => this.rows.set(note.id, { ...note, book_id: toBookId }));
    return notes.map((note) => note.id);
  }
}
class MemorySources implements SourceRepository {
  rows = new Map<string, Source>();
  list() { return [...this.rows.values()]; }
  byPath(path: string) { return this.list().find(s => s.path === path); }
  save(s: Source) { this.rows.set(s.id, s); }
  delete(id: string) { return this.rows.delete(id); }
}
function setup() {
  const books = new MemoryBooks(), notes = new MemoryNotes(), sources = new MemorySources();
  let next = 0;
  const ids = { next: () => String(++next) };
  const clock = { now: () => 123000 };
  const files: FileStore = {
    extension: path => path.split(".").at(-1)!.toLowerCase(), title: path => path.split("/").at(-1)!.split(".")[0],
    join: (...parts) => parts.join("/"), resolve: path => path, realpath: async path => path, parent: () => "/", isRoot: path => path === "/", isWindows: false, home: "/home",
    isDirectory: async () => true, accessible: async () => true, entries: vi.fn(async () => []), stat: async () => ({ size: 1, mtime: 1 }),
    statIfExists: vi.fn(async () => ({ size: 1, mtime: 1 })),
    managedPath: (id, format) => `/${id}.${format}`,
    moveUpload: async (_tmp, id, format) => `/${id}.${format}`, writeCover: async () => "/cover.jpg", remove: vi.fn(async () => {}),
    removeManaged: vi.fn(async () => true),
  };
  const metadata = { pdf: { extract: vi.fn(async (_path: string) => ({ title: "metadata" })) }, epub: { extract: vi.fn(async (_path: string) => ({ title: "metadata" })) } };
  const log = { info: vi.fn(), error: vi.fn() };
  const scanner = new Scanner(books, sources, files, clock, ids, metadata, log);
  return { books, notes, sources, files, metadata, clock, ids, scanner, log,
    library: new Library(books, notes, files, clock, ids, metadata), noteCases: new Notes(notes, books, clock, ids) };
}

describe("domain and application with in-memory ports", () => {
  it("validates formats and note limits", () => {
    expect(sourceBookId("/book.pdf")).toBe("aaf4c29cc5cee8f64e83954cc85a4ab7");
    expect(supportedFormat("pdf")).toBe(true); expect(supportedFormat("epub")).toBe(true); expect(supportedFormat("txt")).toBe(false);
    expect(() => noteBody("  ")).toThrow(ValidationError);
    expect(noteBody(`  ${"a".repeat(20001)}  `)).toHaveLength(20000);
  });
  it("imports with injected metadata, IDs and clock and cleans unsupported uploads", async () => {
    const s = setup();
    const imported = await s.library.importFile("tmp", "title.PDF");
    expect(imported).toMatchObject({ duplicate: false, book: { id: "1", title: "metadata", added_at: 123000, source_id: null } });
    await expect(s.library.importFile("tmp", "wrong.txt")).rejects.toThrow(ValidationError);
    expect(s.files.remove).toHaveBeenCalledWith("tmp");
  });
  it("rejects an upload whose temp file no longer matches the streamed size", async () => {
    const s = setup();
    const identity = { resolve: vi.fn(async () => ({ kind: "new" as const, book: book() })) };
    const library = new Library(s.books, s.notes, s.files, s.clock, s.ids, s.metadata, undefined, undefined, undefined, identity);
    vi.mocked(s.files.statIfExists).mockResolvedValueOnce({ size: 4, mtime: 1 });

    await expect(library.importFile("tmp", "book.epub", { size: 5, contentHash: "a".repeat(64) }))
      .rejects.toThrow("changed during transfer");

    expect(identity.resolve).not.toHaveBeenCalled();
    expect(s.files.remove).toHaveBeenCalledWith("tmp");
  });
  it("deletes owned files and notes but never source files", async () => {
    // Deletion semantics moved to the BookRemoval use case (book-removal tests); the
    // library no longer owns a removal entry point.
    const s = setup(); s.books.save(book()); s.noteCases.add("book", { body: "note" });
    expect(s.books.get("book")).toBeDefined();
    expect(s.notes.list("book")).toHaveLength(1);
  });
  it("normalizes note input and only edits the body", () => {
    const s = setup(); s.books.save(book());
    const note = s.noteCases.add("book", { body: " note ", quote: "q".repeat(5001), location: "l".repeat(2001), label: "x".repeat(201) });
    expect(note.quote).toHaveLength(5000); expect(note.location).toHaveLength(2000); expect(note.label).toHaveLength(200);
    expect(s.noteCases.update(note.id, { body: " edit ", quote: "ignored" })).toEqual({ ...note, body: "edit" });
    expect(() => s.noteCases.add("missing", { body: "x" })).toThrow(NotFoundError);
    expect(() => s.noteCases.update("missing", { body: "" })).toThrow(ValidationError);
    s.noteCases.delete(note.id); expect(() => s.noteCases.delete(note.id)).toThrow(NotFoundError);
  });
  it("keeps the index and notes on unreadable roots and source removal", async () => {
    const s = setup(); s.sources.save({ id: "source", path: "/source" }); s.books.save({ ...book(), source_id: "source" });
    s.noteCases.add("book", { body: "keep" });
    vi.mocked(s.files.entries).mockRejectedValue(new Error("unmounted"));
    await s.scanner.scan(); expect(s.books.get("book")).toBeDefined(); expect(s.log.error).toHaveBeenCalled();
    await s.scanner.removeSource("source"); expect(s.books.list()).toEqual([]); expect(s.notes.list("book")).toHaveLength(1); expect(s.files.remove).not.toHaveBeenCalled();
  });
  it("indexes supported files with stable IDs, reprocesses changes and removes vanished entries", async () => {
    const s = setup(); s.sources.save({ id: "source", path: "/source" });
    vi.mocked(s.files.entries).mockResolvedValue([{ name: "new.pdf", path: "/source/new.pdf", directory: false, file: true, symlink: false }]);
    await s.scanner.scan(); await s.scanner.processPending();
    // scan starts processing in the background; wait for that processing to finish.
    await vi.waitFor(() => expect(s.scanner.status().pending).toBe(0));
    const id = sourceBookId("/source/new.pdf");
    expect(s.books.get(id)).toMatchObject({ title: "metadata", status: "ready", source_id: "source" });
    s.files.stat = async () => ({ size: 2, mtime: 2 });
    await s.scanner.scan(); await vi.waitFor(() => expect(s.books.get(id)?.size).toBe(2));
    await vi.waitFor(() => expect(s.scanner.status().pending).toBe(0));
    vi.mocked(s.files.entries).mockResolvedValue([{ name: "renamed.pdf", path: "/source/renamed.pdf", directory: false, file: true, symlink: false }]);
    await s.scanner.scan(); await vi.waitFor(() => expect(s.books.get(id)).toBeUndefined());
    await vi.waitFor(() => expect(s.scanner.status().pending).toBe(0));
  });
  it("processes two at a time, skips PDFs above 200 MB and marks extraction errors", async () => {
    const s = setup(); let active = 0, peak = 0;
    s.metadata.pdf.extract.mockImplementation(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; return { title: "done" }; });
    for (let i = 0; i < 5; i++) s.books.save({ ...book(String(i)), status: "pending" });
    s.books.save({ ...book("large"), size: 200 * 1024 * 1024 + 1, status: "pending" });
    await s.scanner.processPending(); expect(peak).toBe(2); expect(s.metadata.pdf.extract).toHaveBeenCalledTimes(5); expect(s.books.get("large")?.status).toBe("ready");
    s.books.save({ ...book("error"), status: "pending" }); s.metadata.pdf.extract.mockRejectedValue(new Error("invalid"));
    await s.scanner.processPending(); expect(s.books.get("error")?.status).toBe("error");
  });
  it("does not resurrect books removed while extraction is pending", async () => {
    const s = setup(); s.books.save({ ...book(), status: "pending" });
    s.metadata.pdf.extract.mockImplementation(async () => { s.books.delete("book"); return { title: "removed" }; });
    await s.scanner.processPending(); expect(s.books.list()).toEqual([]);
  });
  it("injects progress persistence and time and checks book existence", () => {
    const s = setup(); const stored = new Map([["book", { percentage: 0.2, updatedAt: 123 }]]);
    const repository = { get: vi.fn(), save: vi.fn(), getMany: vi.fn(() => stored), merge: vi.fn() };
    const progress = new Progress(repository, s.books, s.clock);
    expect(progress.forBooks(["book"])).toEqual(stored);
    expect(repository.getMany).toHaveBeenCalledWith(["book"]);
    expect(() => progress.save("book", { position: "1", percentage: 0.2 })).toThrow(NotFoundError);
    s.books.save(book()); progress.save("book", { position: "1", percentage: 0.2 });
    expect(repository.save).toHaveBeenCalledWith("book", { position: "1", percentage: 0.2 }, 123000);
    const syncRepository = { get: vi.fn(), save: vi.fn() };
    const sync = new SyncProgress(syncRepository, s.clock);
    expect(sync.save({ document: "doc", progress: "1", percentage: 0, device: "dev", device_id: "id" })).toEqual({ document: "doc", timestamp: 123 });
  });
});
