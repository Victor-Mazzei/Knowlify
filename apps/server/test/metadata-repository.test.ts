import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import type { Book } from "../src/ports/index.js";
import type { MetadataOverride } from "../src/ports/library-metadata.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  title: `File title ${id}`,
  author: `File author ${id}`,
  format: "epub",
  path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.png`,
  size: 10,
  added_at: 1,
  source_id: "src",
  mtime: 1,
  status: "ready",
  ...overrides,
});

const override = (bookId: string, values: Partial<MetadataOverride> = {}): MetadataOverride => ({
  bookId,
  title: null,
  author: null,
  description: null,
  isbn10: null,
  isbn13: null,
  year: null,
  publisher: null,
  language: null,
  series: null,
  seriesIndex: null,
  coverPath: null,
  source: "manual",
  updatedAt: 5,
  ...values,
});

function setup() {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const metadata = new SqliteBookMetadataRepository(database);
  return { database, books, metadata };
}

describe("SqliteBookMetadataRepository", () => {
  it("materializes effective values and never overwrites the file snapshot", () => {
    const s = setup();
    s.books.save(book("b"));
    expect(s.metadata.save(override("b", {
      title: "User title",
      author: "User author",
      description: "User description",
      isbn13: "9780132350884",
      year: 2008,
      coverPath: "/covers/custom/b.jpg",
      source: "googlebooks",
    }))).toBe(true);

    expect(s.books.get("b")).toMatchObject({
      title: "User title",
      author: "User author",
      cover_path: "/covers/custom/b.jpg",
      file_title: "File title b",
      file_author: "File author b",
      file_cover_path: "/covers/b.png",
    });

    // A rescan writes file values through UPSERT: file_* changes, the override stays.
    s.books.save(book("b", { title: "Rescanned title", author: "Rescanned author", cover_path: "/covers/b2.png" }));
    expect(s.books.get("b")).toMatchObject({
      title: "User title",
      author: "User author",
      cover_path: "/covers/custom/b.jpg",
      file_title: "Rescanned title",
      file_author: "Rescanned author",
      file_cover_path: "/covers/b2.png",
    });

    // UPDATE_METADATA follows the same rule.
    s.books.updateMetadataMany([book("b", { title: "Extracted title", author: "Extracted author", cover_path: "/covers/b3.png" })]);
    expect(s.books.get("b")).toMatchObject({
      title: "User title",
      author: "User author",
      cover_path: "/covers/custom/b.jpg",
      file_title: "Extracted title",
      file_author: "Extracted author",
      file_cover_path: "/covers/b3.png",
    });
    expect(s.metadata.get("b")).toMatchObject({ description: "User description", source: "googlebooks" });
  });

  it("resets to the file values, including the cover and revision", () => {
    const s = setup();
    s.books.save(book("b"));
    s.metadata.save(override("b", { title: "User title", coverPath: "/covers/custom/b.jpg" }));
    s.metadata.setCover("b", "/covers/custom/b.jpg", 1234, 6);
    expect(s.books.get("b")).toMatchObject({ cover_path: "/covers/custom/b.jpg", cover_rev: 1234 });

    expect(s.metadata.reset("b")).toBe(true);
    expect(s.metadata.get("b")).toBeNull();
    expect(s.books.get("b")).toMatchObject({
      title: "File title b",
      author: "File author b",
      cover_path: "/covers/b.png",
      cover_rev: null,
    });
    expect(s.metadata.reset("b")).toBe(true);
    expect(s.metadata.reset("missing")).toBe(false);
    expect(s.metadata.get("missing")).toBeNull();
  });

  it("stores and clears a custom cover, deleting an empty override row", () => {
    const s = setup();
    s.books.save(book("b"));
    expect(s.metadata.setCover("b", "/covers/custom/b.jpg", 7, 8)).toBe(true);
    expect(s.metadata.get("b")).toEqual(override("b", { coverPath: "/covers/custom/b.jpg", updatedAt: 8 }));
    expect(s.books.get("b")).toMatchObject({ cover_path: "/covers/custom/b.jpg", cover_rev: 7 });

    expect(s.metadata.setCover("b", null, null, 9)).toBe(true);
    expect(s.metadata.get("b")).toBeNull();
    expect(s.books.get("b")).toMatchObject({ cover_path: "/covers/b.png", cover_rev: null });
    expect(s.metadata.setCover("missing", "/x.jpg", 1, 1)).toBe(false);
  });

  it("keeps the override row when only the cover is cleared", () => {
    const s = setup();
    s.books.save(book("b"));
    s.metadata.save(override("b", { title: "User title", coverPath: "/covers/custom/b.jpg" }));
    s.metadata.setCover("b", null, null, 9);
    expect(s.metadata.get("b")).toMatchObject({ title: "User title", coverPath: null, updatedAt: 9 });
    expect(s.books.get("b")).toMatchObject({ title: "User title", cover_path: "/covers/b.png" });
  });

  it("deletes an override whose last field was cleared", () => {
    const s = setup();
    s.books.save(book("b"));
    s.metadata.save(override("b", { title: "User title" }));
    s.metadata.save(override("b", { title: null }));
    expect(s.metadata.get("b")).toBeNull();
    expect(s.books.get("b")?.title).toBe("File title b");
  });

  it("moves an override only when the target has none", () => {
    const s = setup();
    s.books.save(book("from"));
    s.books.save(book("to"));
    s.books.save(book("busy"));
    s.metadata.save(override("from", { title: "Moved title", coverPath: "/covers/custom/from.jpg" }));
    s.metadata.save(override("busy", { title: "Own title" }));

    expect(s.metadata.move("from", "to")).toBe(true);
    expect(s.metadata.get("from")).toBeNull();
    expect(s.metadata.get("to")).toMatchObject({ title: "Moved title", coverPath: "/covers/custom/from.jpg" });
    expect(s.books.get("from")?.title).toBe("File title from");
    expect(s.books.get("to")).toMatchObject({
      title: "Moved title",
      cover_path: "/covers/custom/from.jpg",
      file_title: "File title to",
    });
    expect(s.metadata.move("to", "busy")).toBe(false);
    expect(s.metadata.move("to", "to")).toBe(false);
    expect(s.metadata.move("to", "missing")).toBe(false);
    expect(s.metadata.move("missing", "busy")).toBe(false);
  });

  it("drops overrides on every deletion path", () => {
    const s = setup();
    s.books.save(book("one"));
    s.books.save(book("two", { source_id: "other" }));
    s.books.save(book("three", { source_id: "other" }));
    for (const id of ["one", "two", "three"]) s.metadata.save(override(id, { title: `User ${id}` }));

    s.books.delete("one");
    expect(s.metadata.get("one")).toBeNull();
    s.books.deleteMany(["two"]);
    expect(s.metadata.get("two")).toBeNull();
    s.books.deleteSource("other");
    expect(s.metadata.get("three")).toBeNull();
    expect((s.database.prepare("SELECT COUNT(*) AS n FROM book_metadata_overrides").get() as { n: number }).n).toBe(0);
  });

  it("keeps working for rows created without file metadata (bench and test fixtures)", () => {
    const s = setup();
    s.database.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
      VALUES ('legacy','Legacy','','epub','/library/legacy.epub',NULL,10,1,'src',1,'ready')`).run();
    s.metadata.save(override("legacy", { title: "User legacy" }));
    expect(s.books.get("legacy")?.title).toBe("User legacy");
    expect(s.metadata.reset("legacy")).toBe(true);
    // Without a file snapshot there is nothing to restore; keeping the current title
    // avoids violating NOT NULL (real v10 rows are backfilled by the migration).
    expect(s.books.get("legacy")).toMatchObject({ title: "User legacy", author: "", cover_path: null });
  });
});
