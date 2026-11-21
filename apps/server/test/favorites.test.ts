import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  booksPageSql,
  readingSegmentSql,
  SqliteBookListQuery,
  type NormalizedQuery,
} from "../src/adapters/storage/SqliteBookListQuery.js";
import { SqliteBookFacets } from "../src/adapters/storage/SqliteBookFacets.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { SqliteFavoriteRepository } from "../src/adapters/storage/SqliteFavoriteRepository.js";
import { SqliteUnitOfWork } from "../src/adapters/storage/SqliteBookDuplicateRepository.js";
import { NotFoundError } from "../src/domain/errors.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book, BookPageRow } from "../src/ports/index.js";
import { FAVORITE_LIMITS, Favorites } from "../src/use-cases/Favorites.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-favorites-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

const SECRET = "favorites-test-secret";

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id, title: `Title ${id}`, author: "Author", format: "epub", path: `/library/${id}.epub`,
  cover_path: null, size: 100, added_at: 1_000, source_id: null, mtime: 1, status: "ready",
  ...overrides,
});

let db: Db;
let books: SqliteBookRepository;
let favorites: SqliteFavoriteRepository;
let reader: SqliteBookListQuery;
let facets: SqliteBookFacets;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const request = (method: "GET" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });

const rawFavorite = (id: string): number =>
  (db.prepare("SELECT favorite FROM books WHERE id = ?").get(id) as { favorite: number }).favorite;

const seedBook = (id: string, overrides: Partial<Book> = {}): void => {
  books.save(book(id, overrides));
};

beforeAll(async () => {
  db = openDb(join(root, "favorites.db"));
  books = new SqliteBookRepository(db);
  favorites = new SqliteFavoriteRepository(db);
  reader = new SqliteBookListQuery(db, SECRET);
  facets = new SqliteBookFacets(db);
  for (let index = 0; index < 12; index += 1) {
    const id = `seed-${String(index).padStart(2, "0")}`;
    seedBook(id, {
      title: `Seeded ${String(index).padStart(2, "0")}`,
      author: `Author ${index % 3}`,
      format: index % 2 === 0 ? "pdf" : "epub",
      added_at: 2_000 + index,
    });
    // `save` is the scanner UPSERT, which deliberately never writes `favorite`.
    if (index % 3 === 0) favorites.set(id, true);
  }
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("favorite persistence", () => {
  it("sets one book idempotently and reports missing books", () => {
    seedBook("repo-one");
    expect(favorites.set("repo-one", true)).toBe(true);
    expect(rawFavorite("repo-one")).toBe(1);
    expect(favorites.set("repo-one", true)).toBe(true);
    expect(favorites.set("repo-one", false)).toBe(true);
    expect(rawFavorite("repo-one")).toBe(0);
    expect(favorites.set("missing", true)).toBe(false);
  });

  it("sets many ids in blocks and counts only matched rows", () => {
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
        VALUES (?,?,'','epub',?,NULL,1,1,NULL,NULL,'ready')`);
      for (let index = 0; index < 150; index += 1) insert.run(`bulk-${index}`, `Bulk ${index}`, `/library/bulk-${index}.epub`);
    })();
    const ids = Array.from({ length: 150 }, (_, index) => `bulk-${index}`);

    expect(favorites.setMany(ids, true)).toBe(150);
    expect(db.prepare("SELECT COUNT(*) AS n FROM books WHERE id LIKE 'bulk-%' AND favorite = 1").get()).toEqual({ n: 150 });
    // Duplicates collapse before the write; unknown ids never match.
    expect(favorites.setMany([...ids, ...ids, "missing"], false)).toBe(150);
    expect(db.prepare("SELECT COUNT(*) AS n FROM books WHERE id LIKE 'bulk-%' AND favorite = 1").get()).toEqual({ n: 0 });
    expect(favorites.setMany([], true)).toBe(0);
  });

  it("rescan UPSERT and late metadata writes preserve the flag", () => {
    seedBook("rescan", { title: "From file", author: "File Author" });
    expect(favorites.set("rescan", true)).toBe(true);

    // The scanner writes through these two statements; neither touches `favorite`.
    books.save(book("rescan", {
      title: "Rescanned title", author: "Rescanned author", cover_path: "/covers/rescan.jpg",
      size: 200, mtime: 2, status: "ready",
    }));
    books.updateMetadataMany([book("rescan", {
      title: "Metadata title", author: "Metadata author", size: 200, mtime: 2, status: "ready",
    })]);

    const row = books.get("rescan");
    expect(row).toMatchObject({ title: "Metadata title", favorite: 1 });
    expect(rawFavorite("rescan")).toBe(1);

    // A caller that spreads the row back into `save` cannot clear it either.
    books.save({ ...row!, favorite: 0 });
    expect(rawFavorite("rescan")).toBe(1);

    // New rows default to not favorite.
    seedBook("new-row");
    expect(rawFavorite("new-row")).toBe(0);
  });

  it("uses the shared selection limits and rejects an oversized filter before writing", () => {
    let wrote = false;
    const useCase = new Favorites(
      { set: () => false, setMany: () => { wrote = true; return 0; } },
      { byIds: () => [], count: () => FAVORITE_LIMITS.maxFilter + 1, matchingIds: () => [] },
      { run: <T>(fn: () => T): T => fn() },
    );
    expect(() => useCase.apply({ filter: {}, expectedTotal: FAVORITE_LIMITS.maxFilter + 1 }, true))
      .toThrowError(expect.objectContaining({ code: "selection_too_large" }));
    expect(wrote).toBe(false);
    expect(() => useCase.setOne("missing", true)).toThrow(NotFoundError);
  });
});

describe("favorite HTTP routes", () => {
  it("PUT/DELETE are idempotent and answer 404 for missing books", async () => {
    seedBook("api-one");
    for (const method of ["PUT", "PUT"] as const) {
      const response = await request(method, "/api/books/api-one/favorite");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ favorite: true });
    }
    expect(rawFavorite("api-one")).toBe(1);
    for (const method of ["DELETE", "DELETE"] as const) {
      const response = await request(method, "/api/books/api-one/favorite");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ favorite: false });
    }
    expect(rawFavorite("api-one")).toBe(0);

    expect((await request("PUT", "/api/books/missing/favorite")).statusCode).toBe(404);
    expect((await request("DELETE", "/api/books/missing/favorite")).json()).toEqual({ message: "Book not found" });
  });

  it("exposes the flag in the list and detail DTOs", async () => {
    seedBook("dto-one");
    await request("PUT", "/api/books/dto-one/favorite");
    const page = (await request("GET", "/api/books?limit=10&ids=dto-one")).json();
    expect(page.items[0].favorite).toBe(true);
    const detail = (await request("GET", "/api/books/dto-one")).json();
    expect(detail.favorite).toBe(true);
  });

  it("applies a batch by ids and ignores ids that no longer exist", async () => {
    seedBook("batch-a");
    seedBook("batch-b");
    const applied = await request("PATCH", "/api/books/favorite", {
      ids: ["batch-a", "batch-b"], favorite: true,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ updated: 2 });
    expect(rawFavorite("batch-a")).toBe(1);
    expect(rawFavorite("batch-b")).toBe(1);

    const missing = await request("PATCH", "/api/books/favorite", {
      ids: ["batch-a", "missing"], favorite: true,
    });
    expect(missing.json()).toEqual({ updated: 1 });

    const cleared = await request("PATCH", "/api/books/favorite", {
      ids: ["batch-a", "batch-b", "batch-a"], favorite: false,
    });
    expect(cleared.json()).toEqual({ updated: 2 });
    expect(rawFavorite("batch-a")).toBe(0);
    expect(rawFavorite("batch-b")).toBe(0);
  });

  it("applies a batch by filter after re-counting and rejects a changed selection", async () => {
    for (let index = 0; index < 4; index += 1) {
      seedBook(`filtered-${index}`, {
        title: `BatchFilter ${index}`, format: index < 3 ? "pdf" : "epub", added_at: 5_000 + index,
      });
    }
    const stale = await request("PATCH", "/api/books/favorite", {
      filter: { q: "BatchFilter" }, expectedTotal: 3, favorite: true,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "selection_changed", total: 4 });

    const applied = await request("PATCH", "/api/books/favorite", {
      filter: { q: "BatchFilter", format: "pdf" }, expectedTotal: 3, favorite: true,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ updated: 3 });
    const page = (await request("GET", "/api/books?limit=10&favorite=1&q=BatchFilter")).json();
    expect(page.total).toBe(3);
    expect(page.items.every((item: { format: string }) => item.format === "pdf")).toBe(true);
  });

  it("validates the batch envelope", async () => {
    const invalid = [
      {},
      { ids: ["batch-a"] },
      { ids: ["batch-a"], favorite: "yes" },
      { ids: [], favorite: true },
      { ids: ["batch-a"], filter: { q: "x" }, expectedTotal: 1, favorite: true },
      { ids: Array.from({ length: FAVORITE_LIMITS.maxIds + 1 }, (_, index) => `book-${index}`), favorite: true },
      { filter: {}, favorite: true },
      { filter: {}, expectedTotal: -1, favorite: true },
      { filter: {}, expectedTotal: 1.5, favorite: true },
    ];
    for (const payload of invalid) {
      const response = await request("PATCH", "/api/books/favorite", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("favorite filter, facets and cursors", () => {
  it("lists only favorites and keeps total coherent with other filters", async () => {
    const all = (await request("GET", "/api/books?limit=200&favorite=1")).json();
    const expected = (db.prepare("SELECT COUNT(*) AS n FROM books WHERE favorite = 1").get() as { n: number }).n;
    expect(all.total).toBe(expected);
    expect(all.items).toHaveLength(expected);
    expect(all.items.every((item: { favorite: boolean }) => item.favorite)).toBe(true);

    const pdf = (await request("GET", "/api/books?limit=200&favorite=1&format=pdf&sort=title&order=asc")).json();
    expect(pdf.total).toBe((db.prepare("SELECT COUNT(*) AS n FROM books WHERE favorite = 1 AND format = 'pdf'").get() as { n: number }).n);
    expect(pdf.items.every((item: { favorite: boolean; format: string }) => item.favorite && item.format === "pdf")).toBe(true);
  });

  it("rejects invalid favorite values and the unsupported favorite sort", async () => {
    for (const value of ["0", "true", "", "yes"]) {
      const response = await request("GET", `/api/books?limit=5&favorite=${value}`);
      expect(response.statusCode, value).toBe(400);
    }
    expect((await request("GET", "/api/books?limit=5&sort=favorite")).statusCode).toBe(400);
  });

  it("adds a disjunctive favorite facet", async () => {
    const counts = facets.facets({}, { indexingEnabled: false });
    const favoritesInDb = (db.prepare("SELECT COUNT(*) AS n FROM books WHERE favorite = 1").get() as { n: number }).n;
    expect(counts.favorite.with).toBe(favoritesInDb);

    const pdf = facets.facets({ format: "pdf" }, { indexingEnabled: false });
    const expected = (db.prepare("SELECT COUNT(*) AS n FROM books WHERE favorite = 1 AND format = 'pdf'").get() as { n: number }).n;
    expect(pdf.favorite.with).toBe(expected);

    // Ignore-own-dimension: requesting favorite=1 leaves the favorite count unchanged.
    const filtered = (await request("GET", "/api/books/facets?favorite=1")).json();
    expect(filtered.total).toBe(favoritesInDb);
    expect(filtered.favorite.with).toBe(favoritesInDb);
  });

  it("binds the cursor to the favorite filter while keeping pre-favorite cursors valid", () => {
    const favoriteQuery: NormalizedQuery = { limit: 3, sort: "added", order: "desc", favorite: true };
    const favoritePage = reader.page(favoriteQuery);
    expect(favoritePage.rows.length).toBeGreaterThan(0);
    const favoriteCursor = favoritePage.nextCursor;
    if (favoriteCursor === null) throw new Error("expected a next cursor");

    const continued = reader.page({ ...favoriteQuery, cursor: favoriteCursor });
    const firstIds = new Set(favoritePage.rows.map((row) => row.book.id));
    for (const row of continued.rows) expect(firstIds.has(row.book.id)).toBe(false);

    expect(() => reader.page({ limit: 3, sort: "added", order: "desc", cursor: favoriteCursor }))
      .toThrow("cursor does not match the current query");
    const plainCursor = reader.page({ limit: 3, sort: "added", order: "desc" }).nextCursor;
    if (plainCursor === null) throw new Error("expected a next cursor");
    expect(() => reader.page({ ...favoriteQuery, cursor: plainCursor }))
      .toThrow("cursor does not match the current query");

    // A v2 cursor issued before favorites hashed the same seven-element canonical form.
    const legacy = legacyCursor(favoritePage.rows[0]!);
    const resumed = reader.page({ limit: 3, sort: "added", order: "desc", cursor: legacy });
    expect(resumed.rows.map((row) => row.book.id)).not.toContain(favoritePage.rows[0]!.book.id);
  });
});

describe("favorite query plans", () => {
  const explainDb = openDb(":memory:");

  const details = (query: NormalizedQuery, anchor?: { sortValue: number | string; id: string }): string => {
    const { sql, params } = booksPageSql(query, anchor);
    return (explainDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params, query.limit + 1) as { detail: string }[])
      .map((row) => row.detail).join(" | ");
  };

  const expectIndex = (query: NormalizedQuery, index: string, anchor?: { sortValue: number | string; id: string }): void => {
    const plan = details(query, anchor);
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  };

  beforeAll(() => {
    explainDb.transaction(() => {
      const insert = explainDb.prepare(`INSERT INTO books
        (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status,favorite)
        VALUES (?,?,?,?,?,NULL,?,?,?,1,'ready',?)`);
      for (let index = 0; index < 11_000; index += 1) {
        insert.run(
          `plans-${String(index).padStart(5, "0")}`,
          `Plan ${String(index % 1_000).padStart(4, "0")}`,
          `Author ${String(index % 50).padStart(2, "0")}`,
          index % 3 === 0 ? "epub" : "pdf",
          `/library/plans-${index}.${index % 3 === 0 ? "epub" : "pdf"}`,
          1_000, 10_000 - Math.floor(index / 10), index % 4 === 0 ? null : "src",
          index % 10 === 0 ? 1 : 0,
        );
      }
      const progress = explainDb.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,'p',?,?)");
      for (let index = 0; index < 11_000; index += 3) {
        progress.run(`plans-${String(index).padStart(5, "0")}`, index % 2 === 0 ? 0.5 : 0.995, 20_000 - Math.floor(index / 10));
      }
    });
    explainDb.exec("ANALYZE");
  });

  it("serves every favorite sort and keyset without a temporary B-tree", () => {
    for (const order of ["asc", "desc"] as const) {
      expectIndex({ limit: 60, sort: "added", order, favorite: true }, "books_favorite_added");
      expectIndex({ limit: 60, sort: "title", order, favorite: true }, "books_title");
      expectIndex({ limit: 60, sort: "author", order, favorite: true }, "books_author");
      expectIndex({ limit: 60, sort: "lastRead", order, favorite: true }, "web_progress_updated");
    }
    expectIndex({ limit: 60, sort: "added", order: "desc", favorite: true, format: "pdf" }, "books_favorite_added");
    expectIndex({ limit: 60, sort: "title", order: "asc", favorite: true, q: "Plan" }, "books_title");
    expectIndex(
      { limit: 60, sort: "added", order: "desc", favorite: true },
      "books_favorite_added",
      { sortValue: 9_900, id: "plans-00100" },
    );

    const lastReadAnchor = details(
      { limit: 60, sort: "lastRead", order: "desc", favorite: true },
      { sortValue: 19_800, id: "plans-00120" },
    );
    expect(lastReadAnchor).toContain("web_progress_updated");
    expect(lastReadAnchor).not.toMatch(/TEMP B-TREE/);

    const segment0 = readingSegmentSql(0, { limit: 60, sort: "reading", order: "desc", favorite: true });
    const plan0 = (explainDb.prepare(`EXPLAIN QUERY PLAN ${segment0.sql}`).all(...segment0.params, 61) as { detail: string }[])
      .map((row) => row.detail).join(" | ");
    expect(plan0).toContain("web_progress_updated");
    expect(plan0).not.toMatch(/TEMP B-TREE/);

    const segment1 = readingSegmentSql(1, { limit: 60, sort: "reading", order: "desc", favorite: true });
    const plan1 = (explainDb.prepare(`EXPLAIN QUERY PLAN ${segment1.sql}`).all(...segment1.params, 61) as { detail: string }[])
      .map((row) => row.detail).join(" | ");
    expect(plan1).toContain("books_favorite_added");
    expect(plan1).not.toMatch(/TEMP B-TREE/);
  });

  it("uses the partial index for the favorite count and link", () => {
    const plan = (explainDb.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM books WHERE books.favorite = 1").all() as { detail: string }[])
      .map((row) => row.detail).join(" | ");
    expect(plan).toContain("books_favorite_added");
  });
});

/**
 * Mints a v2 cursor with the seven-element canonical form used before tags/favorites
 * appended their slots, proving old cursors keep working.
 */
function legacyCursor(anchor: BookPageRow): string {
  const header = Buffer.alloc(3 + 8);
  header.writeUInt8(2, 0); // version
  header.writeUInt8(0, 1); // added
  header.writeUInt8(1, 2); // desc
  createHash("sha256").update(JSON.stringify(["", "", "", "", "", "", ""])).digest().subarray(0, 8).copy(header, 3);
  const value = Buffer.alloc(8);
  value.writeDoubleBE(anchor.sortValue as number);
  const id = Buffer.from(anchor.book.id, "utf8");
  const idField = Buffer.alloc(1 + id.length);
  idField.writeUInt8(id.length, 0);
  id.copy(idField, 1);
  const body = Buffer.concat([header, value, idField]);
  const signature = createHmac("sha256", SECRET).update(body).digest().subarray(0, 12);
  return Buffer.concat([body, signature]).toString("base64url");
}
