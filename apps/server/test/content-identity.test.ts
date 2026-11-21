import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  contentGroupKey,
  isContentHash,
  parseContentGroupKey,
  pickCanonical,
} from "../src/domain/library/ContentIdentity.js";
import { ContentIdentity } from "../src/use-cases/ContentIdentity.js";
import type {
  AliasSnapshot,
  Book,
  BookRepository,
  DuplicateAlias,
  DuplicateBookStats,
  DuplicateContentAnchor,
  DuplicateContentGroup,
  DuplicateRepository,
  FileStore,
  Source,
  SourceBookSnapshot,
  SourceRepository,
} from "../src/ports/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const walkOf = (sourceId: string, seen: string[], unreadable: string[] = [], failedStat: string[] = []) =>
  new Map([[sourceId, { seen: new Set(seen), unreadable, failedStat: new Set(failedStat) }]]);

class MemoryBooks implements BookRepository {
  readonly rows = new Map<string, Book>();
  list() { return [...this.rows.values()]; }
  catalog() { return this.list(); }
  get(id: string) { return this.rows.get(id); }
  byPath(path: string) { return this.list().find((row) => row.path === path); }
  save(row: Book) {
    const existing = this.rows.get(row.id);
    const changed = existing !== undefined && (existing.size !== row.size || existing.mtime !== row.mtime);
    const hash = row.content_hash !== undefined && row.content_hash !== null ? row.content_hash : changed ? null : existing?.content_hash ?? null;
    this.rows.set(row.id, { ...row, content_hash: hash });
  }
  delete(id: string) { this.rows.delete(id); }
  forSource(id: string) { return this.list().filter((row) => row.source_id === id); }
  deleteSource(id: string) { this.forSource(id).forEach((row) => this.delete(row.id)); }
  pending(limit: number) { return this.list().filter((row) => row.status === "pending").slice(0, limit); }
  pendingCount() { return this.pending(Infinity).length; }
  count() { return this.rows.size; }
  snapshotForSource(id: string): Map<string, SourceBookSnapshot> {
    return new Map(this.forSource(id).map((row): [string, SourceBookSnapshot] => [row.path, { id: row.id, mtime: row.mtime, size: row.size }]));
  }
  countForSource(id: string) { return this.forSource(id).length; }
  updateMetadataMany(books: Book[]) {
    const updated: string[] = [];
    for (const row of books) {
      const current = this.rows.get(row.id);
      if (!current || current.mtime !== row.mtime || current.size !== row.size) continue;
      this.rows.set(row.id, { ...current, title: row.title, author: row.author, cover_path: row.cover_path, status: row.status });
      updated.push(row.id);
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

class MemoryDuplicates implements DuplicateRepository {
  readonly aliases = new Map<string, DuplicateAlias>();
  aliasSnapshotForSource(sourceId: string) {
    return new Map([...this.aliases.values()].filter((alias) => alias.sourceId === sourceId).map((alias) => [alias.path, alias]));
  }
  aliasesForBook(bookId: string) { return [...this.aliases.values()].filter((alias) => alias.bookId === bookId); }
  upsertAlias(alias: DuplicateAlias) { this.aliases.set(alias.path, alias); }
  deleteAlias(path: string) { this.aliases.delete(path); }
  deleteAliasesForBook(bookId: string) { for (const alias of this.aliasesForBook(bookId)) this.aliases.delete(alias.path); }
  deleteAliasesForSource(sourceId: string) { for (const alias of [...this.aliases.values()]) if (alias.sourceId === sourceId) this.aliases.delete(alias.path); }
  promoteAlias(bookId: string, path: string) {
    const alias = this.aliases.get(path);
    if (!alias || alias.bookId !== bookId) return false;
    const book = this.books.get(bookId);
    if (!book) return false;
    this.books.save({ ...book, path: alias.path, source_id: alias.sourceId, size: alias.size, mtime: alias.mtime, content_hash: alias.contentHash });
    this.aliases.delete(path);
    return true;
  }
  sizeGroups() { return []; }
  contentGroups(_after: DuplicateContentAnchor | null, _limit: number): DuplicateContentGroup[] { return []; }
  contentGroupCounts() { return { groups: 0, redundantBooks: 0 }; }
  statsForBooks(ids: string[]) { return new Map(ids.map((id): [string, DuplicateBookStats] => [id, { notes: 0, conversations: 0, hasProgress: false, progressUpdatedAt: null, indexState: "none" }])); }
  aliasesForBooks(bookIds: string[]) { return new Map(bookIds.map((id) => [id, this.aliasesForBook(id).map((alias) => alias.path)])); }
  reclaimableBytes() { return 0; }
  constructor(private books: MemoryBooks) {}
  get _aliases() { return this.aliases; }
}

class MemorySources implements Pick<SourceRepository, "list"> {
  constructor(private readonly rows: Source[] = []) {}
  list() { return this.rows; }
}

const book = (path: string, overrides: Partial<Book> = {}): Book => ({
  id: `id-${path}`,
  title: path,
  author: "",
  format: "epub",
  path,
  cover_path: null,
  size: 5,
  added_at: 1,
  source_id: "source",
  mtime: 10,
  status: "pending",
  ...overrides,
});

function setup(options: { missing?: string[]; unavailable?: string[]; roots?: string[] } = {}) {
  const books = new MemoryBooks();
  const duplicates = new MemoryDuplicates(books);
  const contents = new Map<string, string>();
  const stats = new Map<string, { size: number; mtime: number }>();
  const missing = new Set(options.missing ?? []);
  const unavailable = new Set(options.unavailable ?? []);
  const roots = new Set(options.roots ?? ["/source"]);
  const sources = new MemorySources([{ id: "source", path: "/source" }]);
  const files = {
    statIfExists: vi.fn(async (path: string) => {
      if (missing.has(path)) return null;
      if (unavailable.has(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return stats.get(path) ?? { size: 5, mtime: 10 };
    }),
    isDirectory: vi.fn(async (path: string) => roots.has(path)),
  } as unknown as Pick<FileStore, "statIfExists" | "isDirectory">;
  const hasher = { hash: vi.fn(async (path: string) => {
    const value = contents.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return sha(value);
  }) };
  const identity = new ContentIdentity(books, duplicates, hasher, files, sources, { now: () => 100 });
  const put = (path: string, value: string, overrides: Partial<Book> = {}) => {
    contents.set(path, value);
    stats.set(path, { size: overrides.size ?? 5, mtime: overrides.mtime ?? 10 });
  };
  return { books, duplicates, contents, stats, missing, unavailable, roots, sources, files, hasher, identity, put };
}

describe("ContentIdentity domain", () => {
  it("validates hashes and group keys", () => {
    expect(isContentHash(sha("x"))).toBe(true);
    expect(isContentHash("ABC")).toBe(false);
    expect(contentGroupKey(10, sha("x"))).toBe(`10:${sha("x")}`);
    expect(parseContentGroupKey(`10:${sha("x")}`)).toEqual({ size: 10, contentHash: sha("x") });
    expect(() => parseContentGroupKey("10:zzz")).toThrow();
    expect(() => parseContentGroupKey("x:zzz")).toThrow();
  });

  it("picks the canonical copy by user data, index, status, managed, age and id", () => {
    const base = { notes: 0, conversations: 0, hasProgress: false, indexed: false,
      status: "pending" as const, managed: false, addedAt: 10 };
    expect(pickCanonical([{ ...base, id: "a" }, { ...base, id: "b", notes: 1 }]).id).toBe("b");
    expect(pickCanonical([{ ...base, id: "a", notes: 1 }, { ...base, id: "b", indexed: true }]).id).toBe("a");
    expect(pickCanonical([{ ...base, id: "a" }, { ...base, id: "b", indexed: true }]).id).toBe("b");
    expect(pickCanonical([{ ...base, id: "a", conversations: 1 }, { ...base, id: "b", notes: 1 }]).id).toBe("a");
    expect(pickCanonical([{ ...base, id: "a", hasProgress: true }, { ...base, id: "b", notes: 1 }]).id).toBe("a");
    expect(pickCanonical([{ ...base, id: "a", hasProgress: true }, { ...base, id: "b" }]).id).toBe("a");
    expect(pickCanonical([{ ...base, id: "a", status: "error" }, { ...base, id: "b", status: "ready" }]).id).toBe("b");
    expect(pickCanonical([{ ...base, id: "a", addedAt: 20 }, { ...base, id: "b", addedAt: 5 }]).id).toBe("b");
    expect(pickCanonical([{ ...base, id: "b" }, { ...base, id: "a" }]).id).toBe("a");
    expect(pickCanonical([{ ...base, id: "a" }, { ...base, id: "b", managed: true }]).id).toBe("b");
  });
});

describe("ContentIdentity use case", () => {
  it("creates a book without reading the file when no other book shares its size", async () => {
    const s = setup();
    const row = book("/library/a.epub");
    s.put(row.path, "aaaaa", row);

    const outcome = await s.identity.resolve({ book: row });

    expect(outcome.kind).toBe("new");
    expect(s.hasher.hash).not.toHaveBeenCalled();
    expect(s.books.get(row.id)).toMatchObject({ path: row.path, content_hash: null });
  });

  it("turns a second copy into an alias of the existing book", async () => {
    const s = setup();
    const first = book("/library/a.epub");
    s.put(first.path, "same bytes", first);
    await s.identity.resolve({ book: first });
    const second = book("/library/b.epub");
    s.put(second.path, "same bytes", second);

    const outcome = await s.identity.resolve({ book: second });

    expect(outcome).toEqual({ kind: "duplicate", bookId: first.id });
    expect(s.books.count()).toBe(1);
    expect(s.duplicates.aliases.get(second.path)).toMatchObject({ bookId: first.id, contentHash: sha("same bytes") });
  });

  it("keeps same-size files with different bytes as separate books", async () => {
    const s = setup();
    const first = book("/library/a.epub");
    s.put(first.path, "aaaaa", first);
    await s.identity.resolve({ book: first });
    const second = book("/library/b.epub");
    s.put(second.path, "bbbbb", second);

    const outcome = await s.identity.resolve({ book: second });

    expect(outcome.kind).toBe("new");
    expect(s.books.count()).toBe(2);
    expect(s.books.get(first.id)?.content_hash).toBe(sha("aaaaa"));
    expect(s.books.get(second.id)?.content_hash).toBe(sha("bbbbb"));
  });

  it("treats a matching candidate whose path vanished as the same file moved", async () => {
    const s = setup();
    const original = book("/library/a.epub", { content_hash: sha("moving bytes") });
    s.books.save(original);
    s.put(original.path, "moving bytes", original);
    const moved = book("/library/sub/b.epub", { id: "different-id", source_id: "other" });
    s.put(moved.path, "moving bytes", moved);
    s.missing.add(original.path);

    const outcome = await s.identity.resolve({
      book: moved,
      scan: walkOf("source", ["/library/kept.epub"]),
    });

    expect(outcome).toEqual({
      kind: "moved",
      bookId: original.id,
      book: expect.objectContaining({ id: original.id, path: moved.path, source_id: "other", content_hash: sha("moving bytes") }),
    });
    expect(s.books.get(original.id)).toMatchObject({ path: moved.path, source_id: "other" });
    expect(s.books.get(moved.id)).toBeUndefined();
  });

  it("never treats a move as real when the source was not scanned in this execution", async () => {
    const s = setup();
    const original = book("/library/a.epub", { content_hash: sha("moving bytes") });
    s.books.save(original);
    s.put(original.path, "moving bytes", original);
    s.missing.add(original.path);
    const incoming = book("/library/sub/b.epub", { id: "different-id", source_id: "other" });
    s.put(incoming.path, "moving bytes", incoming);

    // No scan evidence: an upload or a source outside this execution cannot prove a move.
    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome).toEqual({ kind: "duplicate", bookId: original.id });
    expect(s.books.get(original.id)).toMatchObject({ path: original.path, content_hash: sha("moving bytes") });
    expect(s.books.get(incoming.id)).toBeUndefined();
    expect(s.duplicates.aliases.get(incoming.path)).toMatchObject({ bookId: original.id, contentHash: sha("moving bytes") });
  });

  it("keeps the canonical path when the source walk saw no files (empty mount point)", async () => {
    const s = setup();
    const original = book("/nas/a.epub", { content_hash: sha("moving bytes") });
    s.books.save(original);
    s.put(original.path, "moving bytes", original);
    s.missing.add(original.path);
    const incoming = book("/local/b.epub", { id: "different-id", source_id: "other" });
    s.put(incoming.path, "moving bytes", incoming);

    const outcome = await s.identity.resolve({
      book: incoming,
      scan: walkOf("source", []),
    });

    expect(outcome).toEqual({ kind: "duplicate", bookId: original.id });
    expect(s.books.get(original.id)).toMatchObject({ path: "/nas/a.epub" });
    expect(s.books.get(incoming.id)).toBeUndefined();
  });

  it("keeps the canonical path when the candidate sits under an unreadable directory", async () => {
    const s = setup();
    const original = book("/library/locked/a.epub", { content_hash: sha("moving bytes") });
    s.books.save(original);
    s.put(original.path, "moving bytes", original);
    s.missing.add(original.path);
    const incoming = book("/library/b.epub", { id: "different-id", source_id: "other" });
    s.put(incoming.path, "moving bytes", incoming);

    const outcome = await s.identity.resolve({
      book: incoming,
      scan: walkOf("source", ["/library/kept.epub"], ["/library/locked"]),
    });

    expect(outcome).toEqual({ kind: "duplicate", bookId: original.id });
    expect(s.books.get(original.id)).toMatchObject({ path: "/library/locked/a.epub" });
  });

  it("keeps the canonical path when the candidate stat failed during the walk", async () => {
    const s = setup();
    const original = book("/library/a.epub", { content_hash: sha("moving bytes") });
    s.books.save(original);
    s.put(original.path, "moving bytes", original);
    s.missing.add(original.path);
    const incoming = book("/library/b.epub", { id: "different-id", source_id: "other" });
    s.put(incoming.path, "moving bytes", incoming);

    const outcome = await s.identity.resolve({
      book: incoming,
      scan: walkOf("source", ["/library/kept.epub"], [], [original.path]),
    });

    expect(outcome).toEqual({ kind: "duplicate", bookId: original.id });
    expect(s.books.get(original.id)).toMatchObject({ path: original.path });
  });

  it("never repoints a book when the candidate stat fails with EACCES", async () => {
    const s = setup();
    const first = book("/library/a.epub", { content_hash: sha("same bytes") });
    s.books.save(first);
    s.put(first.path, "same bytes", first);
    s.unavailable.add(first.path);
    const second = book("/library/b.epub");
    s.put(second.path, "same bytes", second);

    const outcome = await s.identity.resolve({ book: second });

    expect(outcome.kind).toBe("new");
    expect(s.books.get(first.id)?.path).toBe(first.path);
    expect(s.books.get(second.id)).toBeDefined();
    expect(s.duplicates.aliases.size).toBe(0);
  });

  it("keeps a new file pending when its own stat fails with EIO", async () => {
    const s = setup();
    const existing = book("/library/a.epub", { content_hash: sha("aaaaa") });
    s.books.save(existing);
    s.put(existing.path, "aaaaa", existing);
    const incoming = book("/library/b.epub");
    s.put(incoming.path, "bbbbb", incoming);
    const base = s.files.statIfExists.getMockImplementation()!;
    s.files.statIfExists.mockImplementation(async (path: string) => {
      if (path === incoming.path) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return base(path);
    });

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome).toEqual({ kind: "changed", book: expect.objectContaining({ id: incoming.id, content_hash: null }) });
    expect(s.books.get(incoming.id)).toBeUndefined();
    expect(s.duplicates.aliases.size).toBe(0);
  });

  it("does not persist a candidate hash that changed mid-read", async () => {
    const s = setup();
    const candidate = book("/library/a.epub");
    s.books.save({ ...candidate, content_hash: null });
    s.put(candidate.path, "aaaaa", candidate);
    const incoming = book("/library/b.epub");
    s.put(incoming.path, "bbbbb", incoming);
    s.hasher.hash.mockImplementation(async (path: string) => {
      const value = s.contents.get(path)!;
      if (path === candidate.path) s.stats.set(path, { size: 5, mtime: 99 });
      return sha(value);
    });

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome.kind).toBe("new");
    expect(s.books.get(candidate.id)?.content_hash ?? null).toBeNull();
    expect(s.books.get(incoming.id)?.content_hash).toBe(sha("bbbbb"));
  });

  it("records the observed mtime when hashing a managed upload candidate", async () => {
    const s = setup();
    const candidate = book("/uploads/a.epub", { source_id: null, mtime: null, status: "ready", content_hash: null });
    s.books.save(candidate);
    s.put(candidate.path, "aaaaa", { size: 5, mtime: 42 });
    const incoming = book("/library/b.epub");
    s.put(incoming.path, "bbbbb", incoming);

    await s.identity.resolve({ book: incoming });

    expect(s.books.get(candidate.id)).toMatchObject({ content_hash: sha("aaaaa"), mtime: 42 });
  });

  it("does not alias to a candidate whose bytes changed under the stored hash", async () => {
    const s = setup();
    const canonical = book("/library/canonical.epub", { content_hash: sha("aaaaa"), mtime: 10 });
    s.books.save(canonical);
    // The scan recorded "aaaaa"; the file was replaced in place (same size, newer mtime).
    s.contents.set(canonical.path, "bbbbb");
    s.stats.set(canonical.path, { size: 5, mtime: 20 });
    const incoming = book("/library/old-copy.epub", { source_id: "other" });
    s.put(incoming.path, "aaaaa", incoming);

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome.kind).toBe("new");
    expect(s.books.get(canonical.id)?.path).toBe(canonical.path);
    expect(s.books.get(canonical.id)?.content_hash ?? null).toBeNull();
    expect(s.duplicates.aliases.size).toBe(0);
    expect(s.books.get(incoming.id)?.content_hash).toBe(sha("aaaaa"));
  });

  it("aliases only when the incoming file matches the candidate's current bytes", async () => {
    const s = setup();
    const canonical = book("/library/canonical.epub", { content_hash: sha("aaaaa"), mtime: 10 });
    s.books.save(canonical);
    s.contents.set(canonical.path, "bbbbb");
    s.stats.set(canonical.path, { size: 5, mtime: 20 });
    const incoming = book("/library/current-copy.epub", { source_id: "other" });
    s.put(incoming.path, "bbbbb", incoming);

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome).toEqual({ kind: "duplicate", bookId: canonical.id });
    expect(s.duplicates.aliases.get(incoming.path)).toMatchObject({
      bookId: canonical.id,
      contentHash: sha("bbbbb"),
    });
  });

  it("rechecks a candidate that changes between hash verification and the decision", async () => {
    const s = setup();
    const canonical = book("/library/canonical.epub", { content_hash: sha("aaaaa"), mtime: 10 });
    s.books.save(canonical);
    s.contents.set(canonical.path, "aaaaa");
    s.stats.set(canonical.path, { size: 5, mtime: 10 });
    const incoming = book("/library/old-copy.epub", { source_id: "other" });
    s.put(incoming.path, "aaaaa", incoming);
    let canonicalStats = 0;
    const base = s.files.statIfExists.getMockImplementation()!;
    s.files.statIfExists.mockImplementation(async (path: string) => {
      if (path === canonical.path && ++canonicalStats === 2) {
        // Changed after the cached hash was verified but before the lock decided.
        s.contents.set(canonical.path, "bbbbb");
        s.stats.set(canonical.path, { size: 5, mtime: 20 });
      }
      return base(path);
    });

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome.kind).toBe("new");
    expect(s.books.get(canonical.id)?.path).toBe(canonical.path);
    expect(s.duplicates.aliases.size).toBe(0);
    expect(s.hasher.hash).toHaveBeenCalledWith(canonical.path);
    expect(s.books.get(incoming.id)?.content_hash).toBe(sha("aaaaa"));
  });

  it("keeps the canonical book and aliases the copy when its whole source is unavailable", async () => {
    const s = setup({ roots: [] });
    const canonical = book("/nas/a.epub", { content_hash: sha("aaaaa"), mtime: 10 });
    s.books.save(canonical);
    // The NAS is unmounted: every path below it answers ENOENT and the root is not a dir.
    s.missing.add(canonical.path);
    const incoming = book("/local/b.epub", { source_id: "other" });
    s.put(incoming.path, "aaaaa", incoming);

    const outcome = await s.identity.resolve({ book: incoming });

    expect(outcome).toEqual({ kind: "duplicate", bookId: canonical.id });
    expect(s.books.get(canonical.id)).toMatchObject({ path: "/nas/a.epub", content_hash: sha("aaaaa") });
    expect(s.books.get(incoming.id)).toBeUndefined();
    expect(s.duplicates.aliases.get(incoming.path)).toMatchObject({ bookId: canonical.id });
  });

  it("re-evaluates a changed existing book without aliasing it", async () => {
    const s = setup();
    const other = book("/library/other.epub");
    s.put(other.path, "other bytes", other);
    await s.identity.resolve({ book: other });
    const changed = book("/library/changed.epub", { mtime: 20, status: "pending" });
    s.put(changed.path, "other bytes", changed);
    s.books.save({ ...changed, mtime: 10, content_hash: null });

    const outcome = await s.identity.resolve({ book: changed, existingBookId: changed.id });

    expect(outcome.kind).toBe("changed");
    expect(s.books.get(changed.id)).toMatchObject({ path: changed.path, mtime: 20, content_hash: sha("other bytes") });
    expect(s.duplicates.aliases.size).toBe(0);
    expect(s.books.count()).toBe(2);
  });

  it("serializes two resolutions of the same content into one book", async () => {
    const s = setup();
    const first = book("/library/a.epub");
    const second = book("/library/b.epub");
    s.put(first.path, "concurrent bytes", first);
    s.put(second.path, "concurrent bytes", second);

    const [a, b] = await Promise.all([
      s.identity.resolve({ book: first }),
      s.identity.resolve({ book: second }),
    ]);

    expect([a.kind, b.kind].sort()).toEqual(["duplicate", "new"]);
    expect(s.books.count()).toBe(1);
    expect(s.duplicates.aliases.size).toBe(1);
  });

  it("discards a hash that no longer matches the file stat (TOCTOU guard)", async () => {
    const s = setup();
    const existing = book("/library/a.epub");
    s.put(existing.path, "old bytes", existing);
    await s.identity.resolve({ book: existing });
    const current = book("/library/b.epub");
    s.put(current.path, "new bytes", current);
    s.hasher.hash.mockImplementation(async (path: string) => {
      const value = s.contents.get(path)!;
      if (path === current.path) s.stats.set(path, { size: 5, mtime: 99 });
      return sha(value);
    });

    const outcome = await s.identity.resolve({ book: current });

    expect(outcome).toEqual({ kind: "changed", book: expect.objectContaining({ id: current.id, content_hash: null }) });
    expect(s.books.get(current.id)).toBeUndefined();
    expect(s.duplicates.aliases.size).toBe(0);
  });

  it("forgets an alias when its file changes into new content", async () => {
    const s = setup();
    const canonical = book("/library/a.epub");
    s.put(canonical.path, "original", canonical);
    await s.identity.resolve({ book: canonical });
    const alias = book("/library/copy.epub");
    s.put(alias.path, "original", alias);
    await s.identity.resolve({ book: alias });
    expect(s.duplicates.aliases.has(alias.path)).toBe(true);

    s.contents.set(alias.path, "different");
    s.stats.set(alias.path, { size: 5, mtime: 11 });
    const changed = await s.identity.resolve({ book: { ...alias, mtime: 11 } });

    expect(changed.kind).toBe("new");
    expect(s.duplicates.aliases.has(alias.path)).toBe(false);
    expect(s.books.get(alias.id)?.content_hash).toBe(sha("different"));
  });
});
