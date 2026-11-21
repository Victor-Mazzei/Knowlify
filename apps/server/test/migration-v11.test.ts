import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-migration-v11-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const seedV10 = (file: string) => {
  const db = openDb(file);
  db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
    VALUES ('old-book','Old book','Old Author','epub','/library/old.epub','/covers/old.png',10,1,'source',1,'ready')`).run();
  db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
    VALUES ('no-cover','No cover','','pdf','/library/no-cover.pdf',NULL,20,2,NULL,NULL,'ready')`).run();
  db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
    VALUES ('old-note','old-book','','','','body',1,1)`).run();
  db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('old-tag','Old','old','gray',1)").run();
  // Rewind to a v10 database: the v11 columns, table and index did not exist there.
  db.exec(`
    DROP INDEX books_favorite_added;
    DROP TABLE book_metadata_overrides;
    ALTER TABLE books DROP COLUMN favorite;
    ALTER TABLE books DROP COLUMN file_title;
    ALTER TABLE books DROP COLUMN file_author;
    ALTER TABLE books DROP COLUMN file_cover_path;
    ALTER TABLE books DROP COLUMN cover_rev;
    PRAGMA user_version = 10;
  `);
  db.close();
};

describe("v11 migration", () => {
  it("backfills the file metadata of a populated v10 database and stays idempotent", () => {
    const file = join(root, "v10.db");
    seedV10(file);

    const migrated = openDb(file);
    expect(migrated.pragma("user_version", { simple: true })).toBe(11);
    expect(migrated.prepare(`SELECT id, title, author, cover_path, favorite, file_title, file_author,
        file_cover_path, cover_rev FROM books WHERE id = 'old-book'`).get()).toEqual({
      id: "old-book",
      title: "Old book",
      author: "Old Author",
      cover_path: "/covers/old.png",
      favorite: 0,
      file_title: "Old book",
      file_author: "Old Author",
      file_cover_path: "/covers/old.png",
      cover_rev: null,
    });
    expect(migrated.prepare("SELECT favorite, file_title, file_cover_path FROM books WHERE id = 'no-cover'").get())
      .toEqual({ favorite: 0, file_title: "No cover", file_cover_path: null });
    expect(migrated.prepare("SELECT id FROM notes").all()).toEqual([{ id: "old-note" }]);
    expect(migrated.prepare("SELECT id FROM tags").all()).toEqual([{ id: "old-tag" }]);
    expect((migrated.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((column) => column.name))
      .toEqual(expect.arrayContaining(["favorite", "file_title", "file_author", "file_cover_path", "cover_rev"]));
    expect((migrated.prepare("PRAGMA table_info(book_metadata_overrides)").all() as { name: string }[]).map((column) => column.name))
      .toEqual(["book_id", "title", "author", "description", "isbn10", "isbn13", "year", "publisher",
        "language", "series", "series_index", "cover_path", "source", "updated_at"]);
    const index = migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'books_favorite_added'")
      .get() as { sql: string };
    expect(index.sql).toContain("WHERE favorite = 1");

    migrated.prepare(`INSERT INTO book_metadata_overrides (book_id,title,source,updated_at)
      VALUES ('old-book','Override','googlebooks',1)`).run();
    expect(migrated.prepare("SELECT title, source FROM book_metadata_overrides").get())
      .toEqual({ title: "Override", source: "googlebooks" });
    expect(() => migrated.prepare(`INSERT INTO book_metadata_overrides (book_id,source,updated_at)
      VALUES ('old-book','web',2)`).run()).toThrow();

    // Change post-migration values so a second open would expose a repeated backfill.
    migrated.prepare("UPDATE books SET favorite = 1, file_title = 'File title', file_author = 'File author' WHERE id = 'old-book'").run();
    migrated.close();

    const reopened = openDb(file);
    expect(reopened.pragma("user_version", { simple: true })).toBe(11);
    expect(reopened.prepare("SELECT favorite, file_title, file_author FROM books WHERE id = 'old-book'").get())
      .toEqual({ favorite: 1, file_title: "File title", file_author: "File author" });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM book_metadata_overrides").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 2 });
    reopened.close();
  });
});
