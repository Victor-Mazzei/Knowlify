import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-migration-v9-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const seedV8 = (file: string) => {
  const db = openDb(file);
  // Rewind to a populated v8 database: the new tables did not exist in that version.
  db.exec("DROP TABLE book_tags; DROP TABLE tags; DROP TABLE ignored_books; PRAGMA user_version = 8;");
  db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
    VALUES ('old-book','Old book','Author','epub','/library/old.epub',NULL,10,1,'source',1,'ready')`).run();
  db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
    VALUES ('old-note','old-book','','','','body',1,1)`).run();
  db.close();
};

describe("v9 migration", () => {
  it("upgrades a populated v8 database additively and remains idempotent", () => {
    const file = join(root, "v8.db");
    seedV8(file);

    const migrated = openDb(file);
    expect(migrated.pragma("user_version", { simple: true })).toBe(11);
    expect(migrated.prepare("SELECT id, title FROM books").all()).toEqual([{ id: "old-book", title: "Old book" }]);
    expect(migrated.prepare("SELECT id FROM notes").all()).toEqual([{ id: "old-note" }]);
    const tables = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["tags", "book_tags", "ignored_books"]));
    const indexes = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      "tags_name_key", "book_tags_tag", "ignored_books_path", "ignored_books_hash", "ignored_books_size", "ignored_books_at",
    ]));
    migrated.close();

    // Reopening an already migrated database runs no migration and keeps the data.
    const reopened = openDb(file);
    expect(reopened.pragma("user_version", { simple: true })).toBe(11);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 1 });
    reopened.close();
  });

  it("cascades every dependent row when a book is deleted, and keeps notes", () => {
    const db = openDb(":memory:");
    db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
      VALUES ('b','B','','epub','/library/b.epub',NULL,10,1,NULL,1,'ready')`).run();
    db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('t','T','t','gray',1)").run();
    db.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES ('b','t',1)").run();
    db.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES ('b','1',0.5,1)").run();
    db.prepare("INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at) VALUES ('b','ready',0,1,1)").run();
    const chunkId = Number(db.prepare("INSERT INTO chunks (book_id,ordinal,text) VALUES ('b',0,'searchable text')").run().lastInsertRowid);
    db.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (?,?,?)").run(chunkId, "b", Buffer.from([1, 2, 3, 4]));
    db.prepare(`INSERT INTO book_duplicates (path,book_id,source_id,size,mtime,content_hash,detected_at)
      VALUES ('/library/copy.epub','b','source',10,1,? ,1)`).run("a".repeat(64));
    db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
      VALUES ('note','b','','','','body',1,1)`).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").get()).toEqual({ n: 1 });

    db.prepare("DELETE FROM books WHERE id = 'b'").run();

    for (const table of ["book_tags", "web_progress", "book_index", "chunks", "chunk_vectors", "book_duplicates"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'searchable'").get()).toEqual({ n: 0 });
    // Notes are user data: a book disappearing never removes them (they are deleted by BookRemoval).
    expect(db.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });
    // The tag itself survives; only the association went away.
    expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 1 });
    db.close();
  });
});
