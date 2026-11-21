import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { SqliteBookMetadataRepository } from "../src/adapters/storage/SqliteBookMetadataRepository.js";
import { MetadataDisabledError } from "../src/domain/library/BookMetadata.js";
import { ValidationError } from "../src/domain/errors.js";
import { BookMetadata } from "../src/use-cases/BookMetadata.js";
import type { Book } from "../src/ports/index.js";
import type { CustomCoverStore } from "../src/ports/library-metadata.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string): Book => ({
  id, title: "File title", author: "File author", format: "epub", path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.jpg`, size: 10, added_at: 1, source_id: "src", mtime: 1, status: "ready",
});

function setup(options: { lookupEnabled?: boolean; fetcher?: { fetch: (url: string, signal?: AbortSignal) => Promise<Buffer> } } = {}) {
  const database = openDb(":memory:");
  databases.push(database);
  const books = new SqliteBookRepository(database);
  const repository = new SqliteBookMetadataRepository(database);
  const covers: CustomCoverStore = {
    save: vi.fn(async (bookId: string) => `/covers/custom/${bookId}.jpg`),
    remove: vi.fn(async () => {}),
    move: vi.fn(async () => null),
  };
  const invalidate = vi.fn(async () => {});
  const metadata = new BookMetadata(books, repository, covers, { invalidate }, { now: () => 1_700_000_000_000 }, {
    lookupEnabled: options.lookupEnabled ?? false,
    ...(options.fetcher ? { coverFetcher: options.fetcher } : {}),
  });
  return { database, books, repository, covers, invalidate, metadata };
}

describe("BookMetadata use case", () => {
  it("reports effective values, file values and per-field override flags", () => {
    const s = setup();
    s.books.save(book("b"));
    let detail = s.metadata.detail("b")!;
    expect(detail.metadata).toEqual({
      title: "File title",
      author: "File author",
      description: null,
      isbn10: null,
      isbn13: null,
      year: null,
      publisher: null,
      language: null,
      series: null,
      seriesIndex: null,
      file: { title: "File title", author: "File author" },
      overridden: {
        title: false, author: false, description: false, isbn10: false, isbn13: false,
        year: false, publisher: false, language: false, series: false, cover: false,
      },
      source: null,
      updatedAt: null,
    });

    detail = s.metadata.patch("b", {
      title: "User title",
      author: "",
      description: "Desc",
      isbn10: "0132350882",
      isbn13: "9780132350884",
      year: 2008,
      publisher: "Prentice Hall",
      language: "EN",
      series: "Series",
      seriesIndex: 2,
      source: "googlebooks",
    })!;
    expect(detail.book).toMatchObject({ title: "User title", author: "", file_title: "File title", file_author: "File author" });
    expect(detail.metadata).toMatchObject({
      title: "User title",
      author: "",
      description: "Desc",
      isbn10: "0132350882",
      isbn13: "9780132350884",
      year: 2008,
      publisher: "Prentice Hall",
      language: "en",
      series: "Series",
      seriesIndex: 2,
      file: { title: "File title", author: "File author" },
      source: "googlebooks",
      updatedAt: 1_700_000_000_000,
    });
    expect(detail.metadata.overridden).toMatchObject({
      title: true, author: true, description: true, isbn10: true, isbn13: true,
      year: true, publisher: true, language: true, series: true, cover: false,
    });
  });

  it("merges partial patches, clears fields with null and keeps the cover", async () => {
    const s = setup();
    s.books.save(book("b"));
    await s.metadata.setCover("b", Buffer.from("image"));
    expect(s.metadata.detail("b")!.metadata.overridden.cover).toBe(true);

    s.metadata.patch("b", { title: "First" });
    const patched = s.metadata.patch("b", { author: "Second", description: null })!;
    expect(patched.metadata).toMatchObject({
      title: "First",
      author: "Second",
      description: null,
      source: "manual",
      file: { title: "File title", author: "File author" },
    });
    expect(patched.metadata.overridden.cover).toBe(true);
    expect(patched.book.cover_path).toBe("/covers/custom/b.jpg");

    const cleared = s.metadata.patch("b", { title: null })!;
    expect(cleared.metadata.title).toBe("File title");
    expect(cleared.metadata.overridden.title).toBe(false);
    expect(cleared.metadata.overridden.author).toBe(true);
  });

  it("clears seriesIndex when series is cleared and rejects an index without a series", () => {
    const s = setup();
    s.books.save(book("b"));
    s.metadata.patch("b", { series: "Saga", seriesIndex: 1.5 });
    let detail = s.metadata.patch("b", { series: null })!;
    expect(detail.metadata.series).toBeNull();
    expect(detail.metadata.seriesIndex).toBeNull();
    expect(() => s.metadata.patch("b", { seriesIndex: 2 })).toThrow(ValidationError);
    detail = s.metadata.detail("b")!;
    expect(detail.metadata.seriesIndex).toBeNull();
  });

  it("resets everything and removes the custom cover file and thumbnail", async () => {
    const s = setup();
    s.books.save(book("b"));
    await s.metadata.setCover("b", Buffer.from("image"));
    s.metadata.patch("b", { title: "User" });
    s.invalidate.mockClear();
    const detail = (await s.metadata.reset("b"))!;
    expect(detail.metadata).toMatchObject({ title: "File title", author: "File author", source: null, updatedAt: null });
    expect(detail.book).toMatchObject({ cover_path: "/covers/b.jpg", cover_rev: null });
    expect(s.covers.remove).toHaveBeenCalledWith("b");
    expect(s.invalidate).toHaveBeenCalledWith("b");
  });

  it("uploads, replaces and clears a cover while bumping cover_rev", async () => {
    const s = setup();
    s.books.save(book("b"));
    let detail = (await s.metadata.setCover("b", Buffer.from("one")))!;
    expect(detail.book).toMatchObject({ cover_path: "/covers/custom/b.jpg", cover_rev: 1_700_000_000_000 });
    expect(detail.metadata.overridden.cover).toBe(true);
    expect(s.covers.save).toHaveBeenCalledWith("b", Buffer.from("one"));
    expect(s.invalidate).toHaveBeenCalledWith("b");

    detail = (await s.metadata.clearCover("b"))!;
    expect(detail.book).toMatchObject({ cover_path: "/covers/b.jpg", cover_rev: null });
    expect(detail.metadata.overridden.cover).toBe(false);
    expect(s.covers.remove).toHaveBeenCalledWith("b");

    expect(await s.metadata.setCover("missing", Buffer.from("x"))).toBeNull();
    expect(await s.metadata.clearCover("missing")).toBeNull();
    expect(await s.metadata.reset("missing")).toBeNull();
    expect(s.metadata.patch("missing", { title: "x" })).toBeNull();
    expect(s.metadata.detail("missing")).toBeNull();
  });

  it("downloads a cover only when lookup is enabled", async () => {
    const disabled = setup();
    disabled.books.save(book("b"));
    await expect(disabled.metadata.setCoverFromUrl("b", { url: "https://covers.openlibrary.org/b/id/1-L.jpg" }))
      .rejects.toBeInstanceOf(MetadataDisabledError);

    const fetch = vi.fn(async (_url: string, _signal?: AbortSignal) => Buffer.from("downloaded"));
    const enabled = setup({ lookupEnabled: true, fetcher: { fetch } });
    enabled.books.save(book("b"));
    const detail = (await enabled.metadata.setCoverFromUrl("b", { url: " https://covers.openlibrary.org/b/id/1-L.jpg " }))!;
    expect(fetch).toHaveBeenCalledWith("https://covers.openlibrary.org/b/id/1-L.jpg", expect.any(AbortSignal));
    expect(enabled.covers.save).toHaveBeenCalledWith("b", Buffer.from("downloaded"));
    expect(detail.book.cover_path).toBe("/covers/custom/b.jpg");

    expect(await enabled.metadata.setCoverFromUrl("missing", { url: "https://covers.openlibrary.org/b/id/1-L.jpg" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(enabled.metadata.setCoverFromUrl("b", {})).rejects.toBeInstanceOf(ValidationError);
  });
});
