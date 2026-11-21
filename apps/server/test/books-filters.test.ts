import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  booksPageSql,
  SqliteBookListQuery,
  type NormalizedQuery,
} from "../src/adapters/storage/SqliteBookListQuery.js";
import { config } from "../src/config.js";
import type { ReadingStatus } from "../src/domain/reading/ReadingStatus.js";
import { buildApp } from "../src/index.js";
import type { BookFilters, BookIndexStatus, BookSort } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-books-filters-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

type SeedStatus = "ready" | "error";
type SeedIndexState = "ready" | "pending" | "indexing" | "error" | null;

interface Seed {
  id: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  addedAt: number;
  /** Progress row timestamp; null means no row at all. */
  updatedAt: number | null;
  percentage: number | null;
  sourceId: string | null;
  status: SeedStatus;
  indexState: SeedIndexState;
  notes: number;
}

const ROWS = 11_000;
const seeds: Seed[] = [];
for (let index = 0; index < ROWS; index += 1) {
  const mod10 = index % 10;
  const hasProgress = mod10 <= 3;
  seeds.push({
    id: `book-${String(index).padStart(5, "0")}`,
    title: index % 100 === 0 ? `História ${index}` : `Book ${index}`,
    author: `Author ${String(index % 50).padStart(2, "0")}`,
    format: index % 3 === 0 ? "epub" : "pdf",
    // Ten books share every timestamp so every page boundary can land on a tie.
    addedAt: 10_000 - Math.floor(index / 10),
    updatedAt: hasProgress ? 20_000 - Math.floor(index / 10) : null,
    percentage: mod10 === 0 ? 0.004 : mod10 === 1 ? 0.5 : mod10 === 2 ? 0.99 : mod10 === 3 ? 0.2 : null,
    sourceId: ["src-a", "src-b", null, "src-c"][index % 4]!,
    status: "ready",
    indexState: mod10 === 8 ? "error" : mod10 === 9 ? null : mod10 === 7 ? "pending" : "ready",
    notes: index % 5 === 0 ? 1 : 0,
  });
}
// Metadata failures can never be indexed: pending must exclude them even with no row.
seeds.push(
  { id: "special-error-no-row", title: "Zed", author: "Zed", format: "pdf", addedAt: 0, updatedAt: null, percentage: null, sourceId: null, status: "error", indexState: null, notes: 0 },
  { id: "special-error-error", title: "Zed", author: "Zed", format: "pdf", addedAt: 0, updatedAt: null, percentage: null, sourceId: null, status: "error", indexState: "error", notes: 0 },
  { id: "special-error-pending", title: "Zed", author: "Zed", format: "pdf", addedAt: 0, updatedAt: null, percentage: null, sourceId: null, status: "error", indexState: "pending", notes: 0 },
  { id: "special-ready-pending", title: "Zed", author: "Zed", format: "pdf", addedAt: 0, updatedAt: null, percentage: null, sourceId: null, status: "ready", indexState: "pending", notes: 0 },
);
const TOTAL = seeds.length;

const statusOf = (seed: Seed): ReadingStatus => {
  if (seed.percentage === null || seed.percentage < 0.005) return "unread";
  return seed.percentage >= 0.99 ? "finished" : "reading";
};

/** Mirrors the documented filter semantics, including the metadata-error exclusion. */
const indexStatusOf = (seed: Seed): BookIndexStatus | "none" => {
  if (seed.indexState === "ready") return "ready";
  if (seed.indexState === "error") return "error";
  if (seed.status === "error") return "none";
  return "pending";
};

const matches = (seed: Seed, filter: BookFilters): boolean => {
  const q = filter.q?.trim();
  if (q && !seed.title.includes(q) && !seed.author.includes(q)) return false;
  if (filter.format && seed.format !== filter.format) return false;
  if (filter.read && !filter.read.includes(statusOf(seed))) return false;
  if (filter.index && !filter.index.includes(indexStatusOf(seed) as BookIndexStatus)) return false;
  if (filter.source && !filter.source.includes(seed.sourceId ?? "upload")) return false;
  if (filter.notes && seed.notes === 0) return false;
  if (filter.author && seed.author.toLowerCase() !== filter.author.toLowerCase()) return false;
  return true;
};

const expectedCount = (filter: BookFilters): number => seeds.filter((seed) => matches(seed, filter)).length;

function seedDb(database: Db): void {
  const insertBook = database.prepare(
    `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
     VALUES (?,?,?,?,?,NULL,?,?,?,NULL,?)`,
  );
  const insertIndex = database.prepare(
    "INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version) VALUES (?,?,0,0,?, '1|none')",
  );
  const insertProgress = database.prepare(
    "INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)",
  );
  const insertNote = database.prepare(
    "INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',0,0)",
  );
  database.transaction(() => {
    for (const seed of seeds) {
      insertBook.run(
        seed.id, seed.title, seed.author, seed.format, `/library/${seed.id}.${seed.format}`,
        1_000 + seed.addedAt, seed.addedAt, seed.sourceId, seed.status,
      );
      if (seed.indexState !== null) insertIndex.run(seed.id, seed.indexState, seed.addedAt);
      if (seed.percentage !== null && seed.updatedAt !== null) {
        insertProgress.run(seed.id, "pos", seed.percentage, seed.updatedAt);
      }
      for (let note = 0; note < seed.notes; note += 1) insertNote.run(`note-${seed.id}-${note}`, seed.id);
    }
    database.prepare("INSERT INTO sources (id,path) VALUES ('src-a','/a'),('src-b','/b'),('src-c','/c')").run();
  })();
}

let db: Db;
let reader: SqliteBookListQuery;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

beforeAll(async () => {
  db = openDb(join(root, "knowledge.db"));
  seedDb(db);
  reader = new SqliteBookListQuery(db, "filters-test-secret");
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { ...auth, ...headers } });

describe("library filters (read model)", () => {
  it("classifies each reading status with the domain thresholds", () => {
    for (const status of ["unread", "reading", "finished"] as const) {
      const expected = seeds.filter((seed) => statusOf(seed) === status).length;
      expect(reader.count({ read: [status] })).toBe(expected);
      const page = reader.page({ limit: 200, read: [status] });
      expect(page.rows).toHaveLength(200);
    }
    // A progress row under 0.5% still counts as unread; no row does too.
    expect(seeds.filter((seed) => statusOf(seed) === "unread").length).toBe(
      seeds.filter((seed) => seed.percentage === null || seed.percentage < 0.005).length,
    );
  });

  it("combines OR inside a parameter and AND across parameters", () => {
    const cases: BookFilters[] = [
      { read: ["reading", "finished"] },
      { read: ["unread", "reading"] },
      { read: ["reading"], format: "pdf" },
      { format: "epub", notes: true },
      { q: "História", format: "pdf" },
      { q: "Author 07", read: ["finished"] },
      { read: ["reading", "finished"], source: ["src-a", "src-b"], notes: true },
      { format: "epub", read: ["reading", "finished"], author: "author 07" },
    ];
    for (const filter of cases) {
      expect(reader.count(filter)).toBe(expectedCount(filter));
    }
    const allStatuses = reader.count({ read: ["unread", "reading", "finished"] });
    expect(allStatuses).toBe(TOTAL);
  });

  it("filters by indexing state and excludes metadata errors from pending", () => {
    expect(indexStatusOf(seeds.find((seed) => seed.id === "special-error-no-row")!)).toBe("none");
    for (const status of ["ready", "pending", "error"] as const) {
      const expected = seeds.filter((seed) => indexStatusOf(seed) === status).length;
      expect(reader.count({ index: [status] })).toBe(expected);
    }
    // pending counts "no row" and pending/indexing rows, never books.status='error'.
    expect(reader.count({ index: ["pending"] })).toBe(2201);
    expect(reader.count({ index: ["error"] })).toBe(1101);
    expect(reader.count({ index: ["pending", "error"] })).toBe(3302);
  });

  it("filters by source, upload and unknown ids", () => {
    expect(reader.count({ source: ["src-a"] })).toBe(expectedCount({ source: ["src-a"] }));
    expect(reader.count({ source: ["src-a", "src-b"] })).toBe(expectedCount({ source: ["src-a", "src-b"] }));
    expect(reader.count({ source: ["upload"] })).toBe(expectedCount({ source: ["upload"] }));
    expect(reader.count({ source: ["src-a", "upload"] })).toBe(expectedCount({ source: ["src-a", "upload"] }));
    expect(reader.count({ source: ["missing-source"] })).toBe(0);
    expect(reader.count({ source: ["src-a"], format: "epub", read: ["reading"] }))
      .toBe(expectedCount({ source: ["src-a"], format: "epub", read: ["reading"] }));
  });

  it("filters books with notes and keeps q wildcards literal", () => {
    expect(reader.count({ notes: true })).toBe(2200);
    expect(reader.count({ notes: true, read: ["finished"] })).toBe(expectedCount({ notes: true, read: ["finished"] }));
    expect(reader.count({ q: "%" })).toBe(0);
    expect(reader.count({ q: "_" })).toBe(0);
    expect(reader.count({ q: "Book 00" })).toBe(expectedCount({ q: "Book 00" }));
    // Values from requests are bound as parameters, so a quoted id is inert.
    expect(reader.count({ source: ["' OR 1=1 --"] })).toBe(0);
    expect(reader.count({ q: "' OR 1=1 --" })).toBe(0);
  });

  it("counts exactly the items the keyset walk returns", () => {
    const filters: BookFilters[] = [
      {},
      { format: "pdf" },
      { read: ["reading"] },
      { read: ["unread", "finished"], notes: true },
      { source: ["src-c", "upload"] },
      { index: ["ready", "pending"] },
      { q: "Book 1", format: "epub" },
    ];
    for (const filter of filters) {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = reader.page({ ...filter, limit: 200, ...(cursor ? { cursor } : {}) });
        for (const row of page.rows) {
          expect(seen.has(row.book.id)).toBe(false);
          seen.add(row.book.id);
        }
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(Math.ceil(TOTAL / 200) + 2);
      } while (cursor !== undefined);
      expect(seen.size).toBe(expectedCount(filter));
    }
  });
});

describe("keyset cursors", () => {
  const base: NormalizedQuery = { limit: 5, sort: "added", order: "desc", format: "pdf" };

  it("binds the cursor to every filter, sort and order", () => {
    const cursor = reader.page(base).nextCursor;
    expect(cursor).not.toBeNull();
    const variants: NormalizedQuery[] = [
      { ...base, format: "epub" },
      { ...base, read: ["reading"] },
      { ...base, index: ["ready"] },
      { ...base, source: ["src-a"] },
      { ...base, notes: true },
      { ...base, q: "Book" },
      { ...base, sort: "title", order: "asc" },
      { ...base, sort: "author", order: "asc" },
      { ...base, sort: "lastRead" },
      { ...base, order: "asc" },
    ];
    for (const query of variants) {
      expect(() => reader.page({ ...query, cursor: cursor! })).toThrow("cursor does not match the current query");
    }
    // The same query accepts it.
    expect(() => reader.page({ ...base, cursor: cursor! })).not.toThrow();
    // All three reading values normalize to "no filter", so a cursor from the unfiltered
    // query stays valid, while one bound to a single status does not.
    const unfiltered = reader.page({ limit: 5 }).nextCursor;
    expect(() => reader.page({ limit: 5, read: ["unread", "reading", "finished"], cursor: unfiltered! })).not.toThrow();
    const readingOnly = reader.page({ limit: 5, read: ["reading"] }).nextCursor;
    expect(() => reader.page({ limit: 5, read: ["unread", "reading", "finished"], cursor: readingOnly! }))
      .toThrow("cursor does not match the current query");
  });

  it("rejects version 1 cursors and tampered payloads", () => {
    const v1Cursor = (q: string | undefined, sortValue: string, id: string): string => {
      const header = Buffer.alloc(2 + 8);
      header.writeUInt8(1, 0);
      header.writeUInt8(1, 1); // title, ascending
      createHash("sha256").update(q ?? "").digest().subarray(0, 8).copy(header, 2);
      const text = Buffer.from(sortValue, "utf8");
      const value = Buffer.alloc(2 + text.length);
      value.writeUInt16BE(text.length, 0);
      text.copy(value, 2);
      const idBytes = Buffer.from(id, "utf8");
      const idField = Buffer.alloc(1 + idBytes.length);
      idField.writeUInt8(idBytes.length, 0);
      idBytes.copy(idField, 1);
      const body = Buffer.concat([header, value, idField]);
      const signature = createHmac("sha256", "filters-test-secret").update(body).digest().subarray(0, 12);
      return Buffer.concat([body, signature]).toString("base64url");
    };
    expect(() => reader.page({ limit: 5, sort: "title", order: "asc", cursor: v1Cursor(undefined, "Book 00000", "book-00000") }))
      .toThrow("cursor is invalid");

    const current = reader.page({ limit: 5, sort: "title", order: "asc" }).nextCursor!;
    const tampered = `${current[0] === "A" ? "B" : "A"}${current.slice(1)}`;
    expect(() => reader.page({ limit: 5, sort: "title", order: "asc", cursor: tampered })).toThrow("cursor is invalid");
  });

  it("walks all 11k rows with limit=7 on every sort without duplicates or omissions", () => {
    const idCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const sortVal = (seed: Seed, sort: BookSort): number | string => {
      if (sort === "title") return seed.title.toLowerCase();
      if (sort === "author") return seed.author.toLowerCase();
      if (sort === "lastRead") return seed.updatedAt!;
      return seed.addedAt;
    };
    const expectedOrder = (sort: BookSort): string[] => {
      const pool = sort === "lastRead" ? seeds.filter((seed) => seed.updatedAt !== null) : seeds;
      const direction = sort === "title" || sort === "author" ? 1 : -1;
      return [...pool]
        .sort((a, b) => {
          const left = sortVal(a, sort);
          const right = sortVal(b, sort);
          if (left !== right) return (left < right ? -1 : 1) * direction;
          return idCompare(a.id, b.id) * direction;
        })
        .map((seed) => seed.id);
    };

    for (const sort of ["added", "title", "author", "lastRead"] as const) {
      const order = sort === "title" || sort === "author" ? "asc" : "desc";
      const expected = expectedOrder(sort);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = reader.page({ limit: 7, sort, order, ...(cursor ? { cursor } : {}) });
        seen.push(...page.rows.map((row) => row.book.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(Math.ceil(TOTAL / 7) + 2);
      } while (cursor !== undefined);
      expect(seen).toEqual(expected);
    }

    // A filtered walk keeps the same keyset guarantees.
    const filter: BookFilters = { format: "epub", read: ["reading", "finished"], source: ["src-a", "src-b", "src-c"] };
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = reader.page({ ...filter, limit: 7, sort: "added", order: "desc", ...(cursor ? { cursor } : {}) });
      for (const row of page.rows) {
        expect(seen.has(row.book.id)).toBe(false);
        seen.add(row.book.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen.size).toBe(expectedCount(filter));
  });

  it("reflects the lastRead restriction in total", () => {
    expect(reader.count(undefined, { requireProgress: true })).toBe(seeds.filter((seed) => seed.percentage !== null).length);
    expect(reader.count({ read: ["finished"] }, { requireProgress: true }))
      .toBe(expectedCount({ read: ["finished"] }));
    // lastRead lists only books with progress, so unread (no row in that mode) is empty.
    expect(reader.page({ limit: 5, sort: "lastRead", read: ["unread"] }).rows).toEqual([]);
    expect(reader.count({ read: ["unread"] }, { requireProgress: true })).toBe(0);
  });
});

describe("query plans", () => {
  const details = (query: NormalizedQuery, anchor?: { sortValue: number | string; id: string }): string => {
    const { sql, params } = booksPageSql(query, anchor);
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params, query.limit + 1) as { detail: string }[])
      .map((row) => row.detail)
      .join(" | ");
  };
  const expectIndex = (query: NormalizedQuery, index: string, anchor?: { sortValue: number | string; id: string }): void => {
    const plan = details(query, anchor);
    expect(plan).toContain(index);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  };

  it("uses an index and no temporary sort for the required shapes", () => {
    for (const order of ["asc", "desc"] as const) {
      expectIndex({ limit: 60, sort: "added", order }, "books_added");
      expectIndex({ limit: 60, sort: "title", order }, "books_title");
      expectIndex({ limit: 60, sort: "author", order }, "books_author");
      expectIndex({ limit: 60, sort: "lastRead", order }, "web_progress_updated");
    }
    expectIndex({ limit: 60, sort: "added", order: "desc", format: "pdf" }, "books_added");
    expectIndex({ limit: 60, sort: "added", order: "desc", source: ["src-a", "src-b", "upload"] }, "books_added");
    expectIndex({ limit: 60, sort: "title", order: "asc", source: ["src-a"] }, "books_title");
    expectIndex({ limit: 60, sort: "lastRead", order: "desc", format: "epub", read: ["reading"], notes: true },
      "web_progress_updated");
    expectIndex({ limit: 60, sort: "added", order: "desc", read: ["reading", "finished"], index: ["pending"] }, "books");
    expectIndex({ limit: 60, sort: "added", order: "desc", notes: true }, "books");
    expectIndex({ limit: 60, sort: "title", order: "asc", q: "Book" }, "books_title");
  });

  it("seeks with the cursor on added and lastRead", () => {
    const added = details({ limit: 60, sort: "added", order: "desc" }, { sortValue: 9_500, id: "book-00500" });
    expect(added).toContain("books_added");
    expect(added).toMatch(/SEARCH books/);
    expect(added).not.toMatch(/TEMP B-TREE/);

    const lastRead = details(
      { limit: 60, sort: "lastRead", order: "desc", read: ["reading"] },
      { sortValue: 19_500, id: "book-00500" },
    );
    expect(lastRead).toContain("web_progress_updated");
    expect(lastRead).toMatch(/SEARCH p/);
    expect(lastRead).not.toMatch(/TEMP B-TREE/);
  });
});

describe("GET /api/books with filters", () => {
  it("validates values on the paged list", async () => {
    for (const url of [
      "/api/books?limit=5&read=bogus",
      "/api/books?limit=5&index=bogus",
      "/api/books?limit=5&source=bad!id",
      `/api/books?limit=5&source=${Array.from({ length: 11 }, (_, index) => `src-${index}`).join(",")}`,
      "/api/books?limit=5&notes=2",
      "/api/books?limit=5&sort=size",
      "/api/books?limit=5&order=up",
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json().message).toEqual(expect.any(String));
    }
  });

  it("reports a disabled index filter while keeping the other filters", async () => {
    const disabled = await get("/api/books?limit=5&index=ready");
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({ message: "indexing is disabled" });

    const status = await get("/api/books?limit=5&read=reading&sort=lastRead");
    expect(status.statusCode).toBe(200);
    expect(status.json().total).toBe(expectedCount({ read: ["reading"] }));
  });

  it("filters by exact author, ignoring case and surrounding whitespace", async () => {
    const author = "Author 07";
    const response = await get(`/api/books?limit=10&author=${encodeURIComponent(author.toLowerCase())}`);
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.total).toBe(expectedCount({ author }));
    expect(page.items).toHaveLength(10);
    expect(page.items.every((item: { author: string }) => item.author === author)).toBe(true);

    // Equality, not a prefix/contains match.
    const prefix = await get(`/api/books?limit=5&author=${encodeURIComponent("Author 0")}`);
    expect(prefix.statusCode).toBe(200);
    expect(prefix.json().total).toBe(0);

    const trimmed = await get(`/api/books?limit=1&author=${encodeURIComponent(`  ${author}  `)}`);
    expect(trimmed.statusCode).toBe(200);
    expect(trimmed.json().total).toBe(expectedCount({ author }));
  });

  it("caps the author text at 200 characters on the list and the facets", async () => {
    const accepted = await get(`/api/books?limit=1&author=${"a".repeat(200)}`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().total).toBe(0);

    const tooLong = "a".repeat(201);
    for (const url of [`/api/books?limit=1&author=${tooLong}`, `/api/books/facets?author=${tooLong}`]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ message: "author accepts at most 200 characters" });
    }
  });

  it("applies the author filter to every facet dimension", async () => {
    const author = "author 07";
    const response = await get(`/api/books/facets?author=${encodeURIComponent(author)}`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(expectedCount({ author }));
    expect(body.format.pdf).toBe(expectedCount({ author, format: "pdf" }));
    expect(body.format.epub).toBe(expectedCount({ author, format: "epub" }));
    expect(body.read.unread).toBe(expectedCount({ author, read: ["unread"] }));
    expect(body.read.reading).toBe(expectedCount({ author, read: ["reading"] }));
    expect(body.read.finished).toBe(expectedCount({ author, read: ["finished"] }));
    expect(body.notes.with).toBe(expectedCount({ author, notes: true }));
    expect(body.index).toBeNull();
    const sourceCount = (id: string): number | undefined =>
      (body.source as Array<{ id: string; count: number }>).find((entry) => entry.id === id)?.count;
    expect(sourceCount("src-a")).toBe(expectedCount({ author, source: ["src-a"] }));
    expect(sourceCount("upload")).toBe(expectedCount({ author, source: ["upload"] }));

    // Author is not a facet dimension of its own: combining it with format keeps it applied
    // while the format buckets ignore only format, as for every other non-own dimension.
    const combined = await get(`/api/books/facets?author=${encodeURIComponent(author)}&format=epub`);
    expect(combined.statusCode).toBe(200);
    expect(combined.json().total).toBe(expectedCount({ author, format: "epub" }));
    expect(combined.json().format.pdf).toBe(expectedCount({ author, format: "pdf" }));
    expect(combined.json().read.finished).toBe(expectedCount({ author, format: "epub", read: ["finished"] }));
  });

  it("returns totals from the same filters and ignores unknown parameters", async () => {
    const response = await get("/api/books?limit=10&read=reading&format=pdf&source=src-b&bogus=1");
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.items).toHaveLength(10);
    expect(page.total).toBe(expectedCount({ read: ["reading"], format: "pdf", source: ["src-b"] }));
    expect(page.items.every((book: { format: string }) => book.format === "pdf")).toBe(true);
  });

  it("uses all three reading values as no filter", async () => {
    const response = await get("/api/books?limit=1&read=unread,reading,finished");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(TOTAL);
  });

  it("reports lastRead totals over books with progress only", async () => {
    const response = await get("/api/books?limit=5&sort=lastRead");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(seeds.filter((seed) => seed.percentage !== null).length);
    // The page returns only books that have a progress row.
    for (const item of response.json().items as { id: string }[]) {
      expect(seeds.find((seed) => seed.id === item.id)?.percentage).not.toBeNull();
    }
  });

  it("rejects a cursor from another filter set", async () => {
    const first = await get("/api/books?limit=5&read=reading");
    const cursor = first.json().nextCursor as string;
    expect(typeof cursor).toBe("string");
    const mismatch = await get(`/api/books?limit=5&read=finished&cursor=${encodeURIComponent(cursor)}`);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toEqual({ message: "cursor does not match the current query" });
    const same = await get(`/api/books?limit=5&read=reading&cursor=${encodeURIComponent(cursor)}`);
    expect(same.statusCode).toBe(200);
  });

  it("binds cursors to the author filter", async () => {
    const author = "Author 07";
    const otherAuthor = "Author 08";
    const first = await get(`/api/books?limit=5&author=${encodeURIComponent(author)}`);
    expect(first.statusCode).toBe(200);
    expect(first.json().total).toBe(expectedCount({ author }));
    const cursor = first.json().nextCursor as string;
    expect(typeof cursor).toBe("string");

    const other = await get(
      `/api/books?limit=5&author=${encodeURIComponent(otherAuthor)}&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(other.statusCode).toBe(400);
    expect(other.json()).toEqual({ message: "cursor does not match the current query" });

    const unfiltered = await get("/api/books?limit=5");
    const missingAuthor = await get(
      `/api/books?limit=5&author=${encodeURIComponent(author)}&cursor=${encodeURIComponent(unfiltered.json().nextCursor as string)}`,
    );
    expect(missingAuthor.statusCode).toBe(400);
    expect(missingAuthor.json()).toEqual({ message: "cursor does not match the current query" });

    // The same author continues the keyset walk instead of restarting it.
    const same = await get(
      `/api/books?limit=5&author=${encodeURIComponent(author)}&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(same.statusCode).toBe(200);
    const firstIds = new Set((first.json().items as Array<{ id: string }>).map((item) => item.id));
    for (const item of same.json().items as Array<{ id: string; author: string }>) {
      expect(firstIds.has(item.id)).toBe(false);
      expect(item.author).toBe(author);
    }
  });

  it("keeps the legacy array untouched", async () => {
    const legacy = await get("/api/books?q=Hist%C3%B3ria");
    expect(legacy.statusCode).toBe(200);
    expect(Array.isArray(legacy.json())).toBe(true);
    expect(legacy.json()).toHaveLength(110);
    expect(legacy.headers.deprecation).toBe("true");
  });
});
