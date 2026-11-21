import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { SqliteFavoriteRepository } from "../src/adapters/storage/SqliteFavoriteRepository.js";
import { ConflictError, ValidationError } from "../src/domain/errors.js";
import { contentGroupKey } from "../src/domain/library/ContentIdentity.js";
import { DuplicateFinder } from "../src/use-cases/DuplicateFinder.js";
import type { Book, FileStore } from "../src/ports/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string, path: string, overrides: Partial<Book> = {}): Book => ({
  id, title: id, author: "", format: "epub", path, cover_path: null,
  size: 10, added_at: 1, source_id: "src", mtime: 1, status: "ready", ...overrides,
});

function setup(hashImpl?: (path: string) => Promise<string>, finderOptions: Record<string, unknown> = {}) {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const duplicates = new SqliteBookDuplicateRepository(database);
  const sources = new SqliteSourceRepository(database);
  const notes = new SqliteNoteRepository(database);
  const conversations = new SqliteConversationRepository(database);
  const progress = new SqliteProgressRepository(database);
  const mergeLog = new SqliteMergeLogRepository(database);
  const favoriteRepository = new SqliteFavoriteRepository(database);
  const removeManaged = vi.fn(async (_path: string) => true);
  // The fake filesystem mirrors the rows but keeps the last stat seen, so files outlive
  // their (deleted) rows as they do on disk. Tests override it when needed.
  const known = new Map<string, { size: number; mtime: number }>();
  const statIfExists = vi.fn(async (path: string): Promise<{ size: number; mtime: number } | null> => {
    const row = books.byPath(path);
    if (!row) return known.get(path) ?? null;
    const value = { size: row.size, mtime: row.mtime ?? 1 };
    known.set(path, value);
    return value;
  });
  const files = { statIfExists, removeManaged } as Pick<FileStore, "statIfExists" | "removeManaged">;
  let nextId = 0;
  const ids = { next: () => `merge-${++nextId}` };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const hasher = { hash: vi.fn(hashImpl ?? (async (path: string) => sha(path))) };
  const finder = new DuplicateFinder(books, duplicates, hasher, sources, notes, conversations, progress,
    files, new SqliteUnitOfWork(database), mergeLog, { now: () => 1000 }, ids, log,
    { bootDelayMs: 0, ...finderOptions }, undefined, favoriteRepository);
  const note = (id: string, bookId: string) => database.prepare(`INSERT INTO notes
    (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',1,1)`).run(id, bookId);
  const progressRow = (bookId: string, updatedAt: number) => database.prepare(`INSERT INTO web_progress
    (book_id,position,percentage,updated_at) VALUES (?,'p',0.5,?)`).run(bookId, updatedAt);
  const indexRow = (bookId: string) => database.prepare(`INSERT INTO book_index (book_id,state,requested_at)
    VALUES (?,'ready',1)`).run(bookId);
  const chunk = (bookId: string, text: string): number => Number(database.prepare(`INSERT INTO chunks (book_id,ordinal,text)
    VALUES (?,0,?)`).run(bookId, text).lastInsertRowid);
  return { database, books, duplicates, sources, notes, conversations, progress, mergeLog, favoriteRepository,
    removeManaged, statIfExists, finder, hasher, log, note, progressRow, indexRow, chunk };
}

describe("DuplicateFinder detection", () => {
  it("hashes only books whose size is shared and reports groups", async () => {
    const s = setup();
    s.books.save(book("a", "/lib/a.epub", { content_hash: null }));
    s.books.save(book("b", "/lib/b.epub", { content_hash: null }));
    s.books.save(book("c", "/lib/c.epub", { content_hash: null }));
    s.books.save(book("d", "/lib/d.epub", { content_hash: null }));
    s.books.save(book("e", "/lib/e.epub", { content_hash: null, size: 99 }));
    s.hasher.hash.mockImplementation(async (path: string) => sha(path.endsWith("/a.epub") || path.endsWith("/b.epub") ? "same" : path));

    await s.finder.analyze();

    expect(s.hasher.hash).toHaveBeenCalledTimes(4);
    expect(s.hasher.hash).not.toHaveBeenCalledWith("/lib/e.epub");
    expect(s.books.get("a")?.content_hash).toBe(sha("same"));
    expect(s.books.get("b")?.content_hash).toBe(sha("same"));
    expect(s.finder.status()).toEqual({ state: "ready", progress: null, groups: 1, redundantBooks: 1 });
  });

  it("does not persist a hash when the file changes during the analysis read", async () => {
    const s = setup();
    s.books.save(book("a", "/lib/a.epub", { content_hash: null }));
    s.books.save(book("b", "/lib/b.epub", { content_hash: null }));
    const mtimes = new Map<string, number>();
    s.statIfExists.mockImplementation(async (path: string) => {
      const row = s.books.byPath(path);
      return row ? { size: row.size, mtime: mtimes.get(path) ?? row.mtime ?? 1 } : null;
    });
    s.hasher.hash.mockImplementation(async (path: string) => {
      if (path === "/lib/a.epub") mtimes.set(path, 99);
      return sha(path);
    });

    await s.finder.analyze();

    expect(s.books.get("a")?.content_hash ?? null).toBeNull();
    expect(s.books.get("b")?.content_hash).toBe(sha("/lib/b.epub"));
  });

  it.each(["EACCES", "EIO"])("does not persist a hash when the stat is unavailable (%s)", async (code) => {
    const s = setup();
    s.books.save(book("a", "/lib/a.epub", { content_hash: null }));
    s.books.save(book("b", "/lib/b.epub", { content_hash: null }));
    s.statIfExists.mockImplementation(async (path: string) => {
      if (path === "/lib/a.epub") throw Object.assign(new Error(code), { code });
      const row = s.books.byPath(path);
      return row ? { size: row.size, mtime: row.mtime ?? 1 } : null;
    });

    await s.finder.analyze();

    expect(s.hasher.hash).not.toHaveBeenCalledWith("/lib/a.epub");
    expect(s.books.get("a")?.content_hash ?? null).toBeNull();
    expect(s.books.get("b")?.content_hash).toBe(sha("/lib/b.epub"));
    expect(s.finder.status().state).toBe("ready");
  });

  it("stores the observed mtime when verifying a legacy managed upload", async () => {
    const s = setup();
    s.books.save(book("a", "/uploads/a.epub", { source_id: null, mtime: null, content_hash: sha("old") }));
    s.books.save(book("b", "/uploads/b.epub", { source_id: null, mtime: null, content_hash: sha("other") }));
    s.statIfExists.mockImplementation(async (path: string) => {
      const row = s.books.byPath(path);
      return row ? { size: row.size, mtime: 7 } : null;
    });

    await s.finder.analyze();

    expect(s.books.get("a")).toMatchObject({ content_hash: sha("/uploads/a.epub"), mtime: 7 });
    expect(s.books.get("b")).toMatchObject({ content_hash: sha("/uploads/b.epub"), mtime: 7 });
  });
});

describe("DuplicateFinder merge", () => {
  function seedPair(s: ReturnType<typeof setup>, duplicateOverrides: Partial<Book> = {}) {
    const hash = sha("same bytes");
    s.books.save(book("canonical", "/lib/a.epub", { content_hash: hash, added_at: 1 }));
    s.books.save(book("duplicate", "/lib/b.epub", { content_hash: hash, added_at: 2, ...duplicateOverrides }));
    s.note("n1", "canonical");
    s.note("n2", "duplicate");
    s.progressRow("canonical", 10);
    s.progressRow("duplicate", 20);
    s.indexRow("canonical");
    s.indexRow("duplicate");
    s.chunk("canonical", "canonical text");
    const duplicateChunk = s.chunk("duplicate", "duplicate secret");
    s.database.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (?,? ,x'0102')").run(duplicateChunk, "duplicate");
    s.database.prepare(`INSERT INTO conversations (id,scope_kind,book_id,title,created_at,updated_at)
      VALUES ('c1','book','duplicate','t',1,1)`).run();
    s.database.prepare(`INSERT INTO messages (id,conversation_id,seq,role,content,citations_json,prompt_version,created_at)
      VALUES ('m1','c1',1,'assistant','answer','[{"n":1,"passageId":1,"bookId":"duplicate","bookTitle":"t","page":null,"section":null}]',NULL,1)`).run();
    s.duplicates.upsertAlias({ path: "/lib/b-copy.epub", bookId: "duplicate", sourceId: "src",
      size: 10, mtime: 1, contentHash: hash, detectedAt: 1 });
    return { hash, key: contentGroupKey(10, hash) };
  }

  it("plans without writing, then keeps both sides' notes, newest progress and drops the duplicate index", async () => {
    const s = setup();
    const { key } = seedPair(s);

    const dry = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: true });
    expect(dry).toMatchObject({
      merged: 0,
      plan: { groups: 1, booksRemoved: 1, notesMoved: 1, conversationsMoved: 1, progressKept: 1,
        indexesDropped: 1, managedFilesRemoved: 0 },
    });
    if ("warnings" in dry) expect(dry.warnings.join(" ")).toContain("never changed or deleted");
    expect(s.books.count()).toBe(2);
    expect(s.notes.list("canonical")).toHaveLength(1);
    expect(s.removeManaged).not.toHaveBeenCalled();

    const result = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });
    expect(result).toMatchObject({ merged: 1, booksRemoved: 1, notesMoved: 1, conversationsMoved: 1,
      progressKept: 1, indexesDropped: 1, managedFilesRemoved: 0, skipped: [] });

    expect(s.books.get("canonical")).toBeDefined();
    expect(s.books.get("duplicate")).toBeUndefined();
    expect(s.notes.list("canonical").map((note) => note.id).sort()).toEqual(["n1", "n2"]);
    expect(s.notes.list("duplicate")).toEqual([]);
    expect(s.database.prepare("SELECT book_id FROM conversations WHERE id='c1'").get()).toEqual({ book_id: "canonical" });
    expect(s.database.prepare("SELECT citations_json FROM messages WHERE id='m1'").get()).toMatchObject({
      citations_json: expect.stringContaining('"bookId":"canonical"'),
    });
    expect(s.database.prepare("SELECT citations_json FROM messages WHERE id='m1'").get()).not.toMatchObject({
      citations_json: expect.stringContaining('"bookId":"duplicate"'),
    });
    expect(s.progress.get("canonical")).toMatchObject({ percentage: 0.5 });
    expect(s.database.prepare("SELECT updated_at FROM web_progress WHERE book_id='canonical'").get()).toEqual({ updated_at: 20 });
    expect(s.database.prepare("SELECT COUNT(*) AS n FROM web_progress WHERE book_id='duplicate'").get()).toEqual({ n: 0 });
    expect(s.database.prepare("SELECT COUNT(*) AS n FROM chunks WHERE book_id='duplicate'").get()).toEqual({ n: 0 });
    expect(s.database.prepare("SELECT COUNT(*) AS n FROM chunk_vectors WHERE book_id='duplicate'").get()).toEqual({ n: 0 });
    expect(s.database.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'secret'").get()).toEqual({ n: 0 });
    expect(s.duplicates.aliasesForBook("canonical").map((alias) => alias.path).sort()).toEqual(["/lib/b-copy.epub", "/lib/b.epub"]);
    expect(s.database.prepare("SELECT COUNT(*) AS n FROM book_merge_log").get()).toEqual({ n: 1 });
    expect(s.removeManaged).not.toHaveBeenCalled();
  });

  it("removes only the managed duplicate file and its cover, never a library-folder path", async () => {
    const s = setup();
    const { key } = seedPair(s, { source_id: null, path: "/uploads/b.epub", cover_path: "/covers/b.jpg" });

    const result = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });

    expect(result).toMatchObject({ merged: 1, managedFilesRemoved: 1 });
    expect(s.removeManaged).toHaveBeenCalledWith("/uploads/b.epub");
    expect(s.removeManaged).toHaveBeenCalledWith("/covers/b.jpg");
    expect(s.removeManaged).not.toHaveBeenCalledWith("/lib/a.epub");
    expect(s.duplicates.aliasesForBook("canonical").map((alias) => alias.path).sort()).toEqual(["/lib/b-copy.epub", "/uploads/b.epub"]);
  });

  it("unions favorites into the surviving copy (OR)", async () => {
    const s = setup();
    const { key } = seedPair(s);
    expect(s.favoriteRepository.set("duplicate", true)).toBe(true);

    const result = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });

    expect(result).toMatchObject({ merged: 1, booksRemoved: 1 });
    expect(s.books.get("canonical")?.favorite).toBe(1);
    expect(s.books.get("duplicate")).toBeUndefined();

    // A canonical favorite survives a merge with an unflagged duplicate.
    const other = setup();
    const otherGroup = seedPair(other);
    expect(other.favoriteRepository.set("canonical", true)).toBe(true);
    await other.finder.merge({ groups: [{ key: otherGroup.key, canonicalId: "canonical" }], dryRun: false });
    expect(other.books.get("canonical")?.favorite).toBe(1);
  });

  it("respects an explicit canonical book", async () => {
    const s = setup();
    const { key } = seedPair(s);

    const result = await s.finder.merge({ groups: [{ key, canonicalId: "duplicate" }], dryRun: false });

    expect(result.merged).toBe(1);
    expect(s.books.get("duplicate")).toBeDefined();
    expect(s.books.get("canonical")).toBeUndefined();
    expect(s.notes.list("duplicate").map((note) => note.id).sort()).toEqual(["n1", "n2"]);
  });

  it("is idempotent for a group that no longer exists", async () => {
    const s = setup();
    const { key } = seedPair(s);
    await s.finder.merge({ groups: [{ key }], dryRun: false });

    const again = await s.finder.merge({ groups: [{ key }], dryRun: false });

    expect(again).toMatchObject({ merged: 0, skipped: [{ key, reason: "gone" }] });
  });

  it("rejects a canonicalId outside the group", async () => {
    const s = setup();
    const { key } = seedPair(s);
    await expect(s.finder.merge({ groups: [{ key, canonicalId: "missing" }], dryRun: true }))
      .rejects.toThrow(ValidationError);
  });

  it("merges every group with all and caps work per call", async () => {
    const s = setup();
    const hashA = sha("a");
    s.books.save(book("a1", "/lib/a1.epub", { content_hash: hashA, size: 10 }));
    s.books.save(book("a2", "/lib/a2.epub", { content_hash: hashA, size: 10, added_at: 2 }));
    const hashB = sha("b");
    s.books.save(book("b1", "/lib/b1.epub", { content_hash: hashB, size: 20 }));
    s.books.save(book("b2", "/lib/b2.epub", { content_hash: hashB, size: 20, added_at: 2 }));

    const result = await s.finder.merge({ groups: "all", dryRun: false });

    expect(result.merged).toBe(2);
    expect(s.books.count()).toBe(2);
  });

  it("reports the reviewed plans and merges only a confirmed fingerprint", async () => {
    const s = setup();
    const { key } = seedPair(s);

    const dry = await s.finder.merge({ groups: [{ key }], dryRun: true });
    if (!("accepted" in dry)) throw new Error("expected a dry run");
    expect(dry.accepted).toEqual([{ key, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(dry.omitted).toEqual([]);
    expect((await s.finder.merge({ groups: [{ key }], dryRun: true }))).toMatchObject({ accepted: dry.accepted });

    const wrong = await s.finder.merge({
      confirm: [{ key, fingerprint: "0".repeat(64) }],
      dryRun: false,
    });
    expect(wrong).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });
    expect(s.books.count()).toBe(2);

    const applied = await s.finder.merge({ confirm: dry.accepted, dryRun: false });
    expect(applied).toMatchObject({ merged: 1, booksRemoved: 1, skipped: [] });
    expect(s.books.count()).toBe(1);
  });

  it("skips a group whose member set changed after the dry run", async () => {
    const s = setup();
    const { key, hash } = seedPair(s);
    const dry = await s.finder.merge({ groups: [{ key }], dryRun: true });
    if (!("accepted" in dry)) throw new Error("expected a dry run");

    // A third copy appears after the review: the plan (and its canonical) no longer matches.
    s.books.save(book("third", "/lib/c.epub", { content_hash: hash, added_at: 3 }));
    const applied = await s.finder.merge({ confirm: dry.accepted, dryRun: false });

    expect(applied).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });
    expect(s.books.count()).toBe(3);
  });

  it("never merges a new group outside the confirmed plans", async () => {
    const s = setup();
    const { key } = seedPair(s);
    const otherHash = sha("other bytes");
    s.books.save(book("other-a", "/lib/x.epub", { content_hash: otherHash, size: 20, added_at: 5 }));
    s.books.save(book("other-b", "/lib/y.epub", { content_hash: otherHash, size: 20, added_at: 6 }));
    const dry = await s.finder.merge({ groups: "all", dryRun: true });
    if (!("accepted" in dry)) throw new Error("expected a dry run");
    expect(dry.accepted).toHaveLength(2);

    // A new group appears after the dry run; it is not part of the reviewed set.
    const newHash = sha("new bytes");
    s.books.save(book("new-a", "/lib/n1.epub", { content_hash: newHash, size: 30, added_at: 7 }));
    s.books.save(book("new-b", "/lib/n2.epub", { content_hash: newHash, size: 30, added_at: 8 }));
    const reviewed = dry.accepted.filter((entry) => entry.key === key);
    const applied = await s.finder.merge({ groups: "all", confirm: reviewed, dryRun: false });

    expect(applied).toMatchObject({ merged: 1 });
    expect(s.books.get("new-a")).toBeDefined();
    expect(s.books.get("new-b")).toBeDefined();
    expect(s.books.count()).toBe(5);
  });

  it("omits a requested group that no longer exists", async () => {
    const s = setup();
    const key = contentGroupKey(10, sha("missing bytes"));

    const dry = await s.finder.merge({ groups: [{ key }], dryRun: true });

    expect(dry).toMatchObject({ accepted: [], omitted: [key], plan: { groups: 0 } });
  });

  it("is idempotent when the confirmation is replayed", async () => {
    const s = setup();
    const { key } = seedPair(s);
    const dry = await s.finder.merge({ groups: [{ key }], dryRun: true });
    if (!("accepted" in dry)) throw new Error("expected a dry run");
    await s.finder.merge({ confirm: dry.accepted, dryRun: false });

    const again = await s.finder.merge({ confirm: dry.accepted, dryRun: false });

    expect(again).toMatchObject({ merged: 0, skipped: [{ key, reason: "gone" }] });
  });

  it("skips a group whose file changed after the analysis", async () => {
    const s = setup();
    const { key } = seedPair(s);
    s.statIfExists.mockImplementation(async (path: string) => {
      const row = s.books.byPath(path);
      return row ? { size: row.size, mtime: path === "/lib/b.epub" ? 2 : row.mtime ?? 1 } : null;
    });

    const dry = await s.finder.merge({ groups: [{ key }], dryRun: true });
    expect(dry.plan.groups).toBe(0);
    if (!("omitted" in dry)) throw new Error("expected a dry run");
    expect(dry.accepted).toEqual([]);
    expect(dry.omitted).toEqual([key]);
    const applied = await s.finder.merge({ groups: [{ key }], dryRun: false });
    expect(applied).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });
    expect(s.books.count()).toBe(2);
  });

  it("skips a group when a stat fails with EACCES instead of assuming it changed", async () => {
    const s = setup();
    const { key } = seedPair(s);
    s.statIfExists.mockImplementation(async (path: string) => {
      if (path === "/lib/b.epub") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const row = s.books.byPath(path);
      return row ? { size: row.size, mtime: row.mtime ?? 1 } : null;
    });

    const applied = await s.finder.merge({ groups: [{ key }], dryRun: false });

    expect(applied).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });
    expect(s.books.count()).toBe(2);
    expect(s.removeManaged).not.toHaveBeenCalled();
  });

  it("refuses to merge a book whose file version has no mtime to revalidate", async () => {
    const s = setup();
    const { key } = seedPair(s, { source_id: null, path: "/uploads/b.epub", mtime: null });

    const applied = await s.finder.merge({ groups: [{ key }], dryRun: false });

    expect(applied).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });
    expect(s.books.get("duplicate")).toBeDefined();
    expect(s.removeManaged).not.toHaveBeenCalled();
  });

  it("keeps a managed file that changed during the merge", async () => {
    const s = setup();
    const { key } = seedPair(s, { source_id: null, path: "/uploads/b.epub" });
    let duplicateStats = 0;
    s.statIfExists.mockImplementation(async (path: string) => {
      if (path === "/lib/a.epub") return { size: 10, mtime: 1 };
      if (path === "/uploads/b.epub") return { size: 10, mtime: ++duplicateStats === 1 ? 1 : 2 };
      return null;
    });

    const result = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });

    expect(result).toMatchObject({ merged: 1 });
    expect(s.removeManaged).not.toHaveBeenCalled();
    expect(s.log.warn).toHaveBeenCalledWith(expect.stringContaining("changed during the merge"));
  });

  it("answers 409 while another merge is running", async () => {
    const s = setup();
    const { key } = seedPair(s, { source_id: null, path: "/uploads/b.epub" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.removeManaged.mockImplementation(async () => { await gate; return true; });

    const first = s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });
    await vi.waitFor(() => expect(s.removeManaged).toHaveBeenCalled());
    await expect(s.finder.merge({ groups: [{ key }], dryRun: false })).rejects.toThrow(ConflictError);
    release();
    await first;
  });
});
