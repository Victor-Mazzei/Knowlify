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
  SqliteTagRepository,
  SqliteUnitOfWork,
} from "../src/adapters/storage/repositories.js";
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

function setup() {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const duplicates = new SqliteBookDuplicateRepository(database);
  const tags = new SqliteTagRepository(database);
  const finder = new DuplicateFinder(
    books,
    duplicates,
    { hash: vi.fn(async (path: string) => sha(path)) },
    new SqliteSourceRepository(database),
    new SqliteNoteRepository(database),
    new SqliteConversationRepository(database),
    new SqliteProgressRepository(database),
    {
      statIfExists: vi.fn(async (path: string) => {
        const row = books.byPath(path);
        return row ? { size: row.size, mtime: row.mtime ?? 1 } : null;
      }),
      removeManaged: vi.fn(async () => true),
    } as Pick<FileStore, "statIfExists" | "removeManaged">,
    new SqliteUnitOfWork(database),
    new SqliteMergeLogRepository(database),
    { now: () => 1000 },
    { next: (() => { let id = 0; return () => `merge-${++id}`; })() },
    { info: () => {}, error: () => {}, warn: () => {} },
    { bootDelayMs: 0 },
    tags,
  );
  const tag = (id: string, name: string) => database.prepare(
    "INSERT INTO tags (id,name,name_key,color,created_at) VALUES (?,?,?, 'gray', 1)",
  ).run(id, name, name.toLowerCase());
  const tagBook = (bookId: string, tagId: string) => database.prepare(
    "INSERT INTO book_tags (book_id,tag_id,created_at) VALUES (?,?,1)",
  ).run(bookId, tagId);
  return { database, books, duplicates, tags, finder, tag, tagBook };
}

describe("DuplicateFinder merge and tags", () => {
  it("unions the tags of the removed copy into the canonical", async () => {
    const s = setup();
    const hash = sha("same-bytes");
    s.books.save(book("canonical", "/lib/a.epub", { content_hash: hash }));
    s.books.save(book("duplicate", "/lib/b.epub", { content_hash: hash }));
    s.tag("tag-a", "Alpha");
    s.tag("tag-b", "Beta");
    s.tagBook("canonical", "tag-a");
    s.tagBook("duplicate", "tag-a");
    s.tagBook("duplicate", "tag-b");

    const key = contentGroupKey(10, hash);
    const result = await s.finder.merge({ groups: [{ key, canonicalId: "canonical" }], dryRun: false });

    expect(result).toMatchObject({ merged: 1, booksRemoved: 1 });
    expect(s.books.get("duplicate")).toBeUndefined();
    expect(s.tags.forBooks(["canonical"]).get("canonical")).toEqual(["tag-a", "tag-b"]);
    expect(s.database.prepare("SELECT book_id FROM book_tags ORDER BY tag_id").all())
      .toEqual([{ book_id: "canonical" }, { book_id: "canonical" }]);
    // The group is gone from the duplicate views once only one copy remains.
    expect(s.duplicates.contentGroups(null, 10)).toEqual([]);
    expect(s.duplicates.redundantBookIds()).toEqual([]);
  });

  it("keeps the surviving copy's tags when the removed one has none", async () => {
    const s = setup();
    const hash = sha("other-bytes");
    s.books.save(book("canonical", "/lib/a.epub", { content_hash: hash }));
    s.books.save(book("duplicate", "/lib/b.epub", { content_hash: hash }));
    s.tag("tag-a", "Alpha");
    s.tagBook("canonical", "tag-a");

    await s.finder.merge({ groups: [{ key: contentGroupKey(10, hash), canonicalId: "canonical" }], dryRun: false });

    expect(s.tags.forBooks(["canonical"]).get("canonical")).toEqual(["tag-a"]);
  });
});
