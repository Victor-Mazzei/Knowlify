import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository, SqliteNoteRepository, SqliteSourceRepository, SqliteProgressRepository, SqliteSyncProgressRepository } from "../src/adapters/storage/repositories.js";
import type { Book, Note } from "../src/ports/index.js";
const databases: Db[] = [];
const db = () => { const database = openDb(":memory:"); databases.push(database); return database; };
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const book = (id: string, title: string, added_at = 1): Book => ({ id, title, author: "author", format: "pdf", path: `/${id}.pdf`, cover_path: null, size: 1, added_at, source_id: "source", mtime: 1, status: "pending" });
const note: Note = { id: "note", book_id: "book", body: "body 100%", quote: "quote", location: "location", label: "label", created_at: 1, updated_at: 2 };
describe("SQLite adapters", () => {
  it("round-trips books, preserves search escaping and catalog order", () => {
    const database = db(), books = new SqliteBookRepository(database);
    books.save(book("book", "Zebra 100%", 2)); books.save(book("other", "apple", 1));
    expect(books.list().map(b => b.id)).toEqual(["book", "other"]);
    expect(books.list("100%").map(b => b.id)).toEqual(["book"]);
    expect(books.catalog("", false).map(b => b.id)).toEqual(["other", "book"]);
    expect(books.catalog("", true).map(b => b.id)).toEqual(["book", "other"]);
    expect(books.byPath("/book.pdf")).toEqual({
      ...book("book", "Zebra 100%", 2),
      content_hash: null,
      favorite: 0,
      file_title: "Zebra 100%",
      file_author: "author",
      file_cover_path: null,
      cover_rev: null,
    });
    expect(books.pendingCount()).toBe(2); expect(books.pending(1)).toHaveLength(1);
    books.save({ ...books.get("book")!, title: "updated", status: "ready" });
    expect(books.pendingCount()).toBe(1); expect(books.forSource("source")).toHaveLength(2);
    expect(books.countForSource("source")).toBe(2); expect(books.countForSource("missing")).toBe(0);
    books.deleteSource("source"); expect(books.list()).toEqual([]);
    expect(database.pragma("user_version", { simple: true })).toBe(11);
  });
  it("updates extracted metadata only while the book still exists at the scanned version", () => {
    const database = db(), books = new SqliteBookRepository(database);
    books.save({ ...book("book", "Old"), mtime: 10, size: 100, status: "pending" });
    const extracted = { ...books.get("book")!, title: "New", author: "Writer", status: "ready" as const };

    expect(books.updateMetadataMany([extracted])).toEqual(["book"]);
    expect(books.get("book")).toMatchObject({ title: "New", author: "Writer", status: "ready", mtime: 10, size: 100 });

    books.save({ ...books.get("book")!, title: "Rescanned", status: "pending", mtime: 11, size: 101 });
    expect(books.updateMetadataMany([extracted])).toEqual([]);
    expect(books.get("book")).toMatchObject({ title: "Rescanned", status: "pending", mtime: 11, size: 101 });

    books.delete("book");
    expect(books.updateMetadataMany([extracted])).toEqual([]);
    expect(books.get("book")).toBeUndefined();
  });
  it("keeps notes when indexed books vanish, and excludes orphans from global search", () => {
    const database = db(), books = new SqliteBookRepository(database), notes = new SqliteNoteRepository(database);
    books.save(book("book", "Title")); notes.save(note);
    expect(notes.list("book")).toEqual([note]); expect(notes.search("100%", 100)).toEqual([{ ...note, book_title: "Title" }]);
    expect(notes.search("quote", 1)).toHaveLength(1); expect(notes.search("Title", 1)).toHaveLength(1);
    books.delete("book"); expect(notes.list("book")).toEqual([note]); expect(notes.search(undefined, 100)).toEqual([]);
    books.save(book("book", "Returned")); expect(notes.search(undefined, 100)[0].book_title).toBe("Returned");
    notes.save({ ...note, body: "edited", updated_at: 3 }); expect(notes.get("note")?.body).toBe("edited");
    notes.deleteForBook("book"); expect(notes.get("note")).toBeUndefined(); expect(notes.delete("missing")).toBe(false);
    expect(database.prepare("PRAGMA foreign_key_list(notes)").all()).toEqual([]);
  });
  it("round-trips sources and independent web and KOSync progress", () => {
    const database = db(), sources = new SqliteSourceRepository(database), progress = new SqliteProgressRepository(database), sync = new SqliteSyncProgressRepository(database);
    sources.save({ id: "s", path: "/source" }); expect(sources.list()).toEqual([{ id: "s", path: "/source" }]);
    expect(sources.byPath("/source")).toEqual({ id: "s", path: "/source" }); expect(sources.delete("s")).toBe(true); expect(sources.delete("s")).toBe(false);
    new SqliteBookRepository(database).save(book("book", "Title"));
    progress.save("book", { position: "1", percentage: 0.1 }, 1); progress.save("book", { position: "2", percentage: 0.2 }, 2);
    expect(progress.getMany(["book", "missing"])).toEqual(new Map([["book", { percentage: 0.2, updatedAt: 2 }]]));
    expect(progress.getMany([])).toEqual(new Map());
    const synced = { document: "book", progress: "3", percentage: 0.3, device: "reader", device_id: "id", timestamp: 3 };
    sync.save(synced); sync.save({ ...synced, progress: "4" });
    expect(sync.get("book")).toEqual({ ...synced, progress: "4" }); expect(progress.get("book")).toEqual({ position: "2", percentage: 0.2 });
  });
  it("loads progress for many books in SQLite-sized chunks", () => {
    const database = db(), books = new SqliteBookRepository(database), progress = new SqliteProgressRepository(database);
    books.save(book("book", "Title"));
    progress.save("book", { position: "1", percentage: 0.4 }, 7);
    const prepare = vi.spyOn(database, "prepare");
    const ids = ["book", ...Array.from({ length: 500 }, (_, index) => `missing-${index}`)];
    expect(progress.getMany(ids)).toEqual(new Map([["book", { percentage: 0.4, updatedAt: 7 }]]));
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockRestore();
  });
  it("migrates a legacy database once and retains notes and books", () => {
    const root = mkdtempSync(join(tmpdir(), "knowlify-migration-")), path = join(root, "legacy.db");
    try {
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE books (id TEXT PRIMARY KEY,title TEXT NOT NULL,author TEXT NOT NULL DEFAULT '',format TEXT NOT NULL,path TEXT NOT NULL,cover_path TEXT,size INTEGER NOT NULL,added_at INTEGER NOT NULL);
        INSERT INTO books VALUES ('pdf','PDF','','pdf','/pdf',NULL,1,1);
        INSERT INTO books VALUES ('epub','EPUB','','epub','/epub',NULL,1,1);`);
      legacy.close();
      const migrated = openDb(path);
      expect(new SqliteBookRepository(migrated).get("pdf")?.status).toBe("pending");
      expect(new SqliteBookRepository(migrated).get("epub")?.status).toBe("ready");
      migrated.prepare("UPDATE books SET status = 'ready'").run(); migrated.close();
      const reopened = openDb(path); expect(new SqliteBookRepository(reopened).get("pdf")?.status).toBe("ready"); reopened.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
