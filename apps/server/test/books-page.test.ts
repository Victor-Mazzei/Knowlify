import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { booksPageSql, type NormalizedQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book } from "../src/ports/index.js";

const TOTAL = 11_000;
const root = await mkdtemp(join(tmpdir(), "knowlify-books-page-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const idAt = (index: number): string => `book-${String(index).padStart(5, "0")}`;

function seed(database: Db): void {
  const insert = database.prepare(
    `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
     VALUES (?,?,?,?,?,NULL,?,?,NULL,NULL,'ready')`,
  );
  database.transaction(() => {
    for (let index = 0; index < TOTAL; index += 1) {
      // Ten books share every added_at timestamp, so every page boundary can land on a tie.
      insert.run(
        idAt(index),
        index % 100 === 0 ? `Book ${index} História` : `Book ${index}`,
        `Author ${index % 50}`,
        index % 2 === 0 ? "pdf" : "epub",
        `/library/${idAt(index)}.pdf`,
        1_000 + index,
        10_000 - Math.floor(index / 10),
      );
    }
  })();
}

beforeAll(async () => {
  db = openDb(join(root, "knowledge.db"));
  seed(db);
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

const details = (query: NormalizedQuery, anchor?: { sortValue: number | string; id: string }): string[] => {
  const { sql, params } = booksPageSql(query, anchor);
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params, query.limit + 1) as { detail: string }[])
    .map((row) => row.detail);
};

describe("GET /api/books pagination", () => {
  it("keeps the legacy array and marks it deprecated", async () => {
    const legacy = await get("/api/books");
    expect(legacy.statusCode).toBe(200);
    expect(Array.isArray(legacy.json())).toBe(true);
    expect(legacy.json()).toHaveLength(TOTAL);
    expect(legacy.headers.deprecation).toBe("true");
    expect(legacy.headers.vary).toBe("Authorization");

    const detail = await get(`/api/books/${idAt(42)}`);
    const listed = legacy.json().find((book: Book) => book.id === idAt(42));
    expect(detail.json()).toMatchObject(listed);
    expect(detail.json().tagIds).toEqual([]);
    expect(detail.json().metadata.title).toBe(detail.json().title);
  });

  it("keeps legacy query behaviour and ignores paging-only parameters without limit/ids", async () => {
    const legacy = await get("/api/books?q=História");
    expect(legacy.json()).toHaveLength(TOTAL / 100);
    // No limit/ids: the response is the legacy array even when sort is sent.
    const sorted = await get("/api/books?sort=title&order=asc&format=pdf");
    expect(Array.isArray(sorted.json())).toBe(true);
    expect(sorted.json()).toHaveLength(TOTAL);
    expect(sorted.headers.deprecation).toBe("true");
  });

  it("returns one page with total, cursor and the existing DTO", async () => {
    const response = await get("/api/books?limit=60");
    expect(response.statusCode).toBe(200);
    expect(response.headers.vary).toBe("Authorization");
    expect(response.headers.deprecation).toBeUndefined();
    const page = response.json();
    expect(Object.keys(page)).toEqual(["items", "nextCursor", "total"]);
    expect(page.items).toHaveLength(60);
    expect(page.total).toBe(TOTAL);
    expect(typeof page.nextCursor).toBe("string");
    expect(page.nextCursor.length).toBeLessThanOrEqual(200);
    expect(response.rawPayload.length).toBeLessThan(25 * 1024);
    expect(page.items[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      author: expect.any(String),
      format: expect.stringMatching(/^(pdf|epub)$/),
      size: expect.any(Number),
      addedAt: expect.any(Number),
      hasCover: false,
      status: "ready",
      source: false,
      index: { state: "none", error: null },
      progress: null,
    });
  });

  it("walks all 11k rows without duplicates or omissions when added_at ties", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let requests = 0;
    do {
      const url = `/api/books?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      const page = response.json();
      for (const book of page.items as Book[]) {
        expect(seen.has(book.id)).toBe(false);
        seen.add(book.id);
      }
      expect(page.total).toBe(TOTAL);
      cursor = page.nextCursor;
      requests += 1;
      expect(requests).toBeLessThanOrEqual(56);
    } while (cursor !== null);
    expect(requests).toBe(55);
    expect(seen.size).toBe(TOTAL);
    expect(seen.has(idAt(0))).toBe(true);
    expect(seen.has(idAt(TOTAL - 1))).toBe(true);
  });

  it("orders by added or title in both directions", async () => {
    const added = (await get("/api/books?limit=20&sort=added&order=desc")).json().items as Book[];
    expect(added.map((book) => book.addedAt)).toEqual([...added.map((book) => book.addedAt)].sort((a, b) => b - a));
    const addedAsc = (await get("/api/books?limit=20&sort=added&order=asc")).json().items as Book[];
    expect(addedAsc[0]!.addedAt).toBeLessThanOrEqual(addedAsc[1]!.addedAt);

    const titleAsc = (await get("/api/books?limit=60&sort=title&order=asc")).json().items as Book[];
    const titles = titleAsc.map((book) => book.title.toLocaleLowerCase());
    expect(titles).toEqual([...titles].sort());
    const titleDesc = (await get("/api/books?limit=60&sort=title&order=desc")).json().items as Book[];
    const desc = titleDesc.map((book) => book.title.toLocaleLowerCase());
    expect(desc).toEqual([...desc].sort().reverse());
  });

  it("searches title/author and counts the same filter", async () => {
    const response = await get("/api/books?limit=10&q=Hist%C3%B3ria");
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.total).toBe(TOTAL / 100);
    expect(page.items).toHaveLength(10);
    expect(page.items.every((book: Book) => book.title.includes("História"))).toBe(true);

    const byAuthor = await get("/api/books?limit=5&q=Author%207");
    expect(byAuthor.json().total).toBe(TOTAL / 50);
  });

  it("filters by format and keeps the cursor bound to the query", async () => {
    const pdf = await get("/api/books?limit=10&format=pdf");
    expect(pdf.json().total).toBe(TOTAL / 2);
    expect(pdf.json().items.every((book: Book) => book.format === "pdf")).toBe(true);

    const cursor = pdf.json().nextCursor as string;
    for (const url of [
      `/api/books?limit=10&format=epub&cursor=${encodeURIComponent(cursor)}`,
      `/api/books?limit=10&format=pdf&sort=title&cursor=${encodeURIComponent(cursor)}`,
      `/api/books?limit=10&format=pdf&order=asc&cursor=${encodeURIComponent(cursor)}`,
      `/api/books?limit=10&format=pdf&q=Book&cursor=${encodeURIComponent(cursor)}`,
    ]) {
      const response = await get(url);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: expect.stringContaining("cursor") });
    }
  });

  it("rejects invalid limits, enums, ids and tampered cursors", async () => {
    for (const url of [
      "/api/books?limit=0",
      "/api/books?limit=201",
      "/api/books?limit=1.5",
      "/api/books?limit=",
      "/api/books?limit=10&sort=size",
      "/api/books?limit=10&order=up",
      "/api/books?limit=10&format=cbz",
      `/api/books?limit=10&q=${"a".repeat(201)}`,
      `/api/books?ids=${Array.from({ length: 101 }, (_, index) => idAt(index)).join(",")}`,
      "/api/books?limit=10&cursor=not-a-cursor",
    ]) {
      expect((await get(url)).statusCode).toBe(400);
    }

    const first = (await get("/api/books?limit=5")).json();
    const cursor = first.nextCursor as string;
    const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
    const response = await get(`/api/books?limit=5&cursor=${encodeURIComponent(tampered)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "cursor is invalid" });
  });

  it("hydrates explicit ids in request order, omitting unknown ones", async () => {
    const response = await get(`/api/books?ids=${idAt(9)},${idAt(2)},missing,${idAt(2)}`);
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.items.map((book: Book) => book.id)).toEqual([idAt(9), idAt(2)]);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();

    const filtered = await get(`/api/books?ids=${idAt(0)},${idAt(1)}&format=epub`);
    expect(filtered.json().items.map((book: Book) => book.id)).toEqual([idAt(1)]);
    expect((await get("/api/books?ids=")).json()).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("compresses JSON above 1 KB and keeps the legacy payload under 400 KB", async () => {
    const page = await get("/api/books?limit=60", { "accept-encoding": "gzip" });
    expect(page.headers["content-encoding"]).toBe("gzip");
    expect(page.headers.vary).toContain("Authorization");
    const decoded = JSON.parse(gunzipSync(page.rawPayload).toString("utf8"));
    expect(decoded.items).toHaveLength(60);
    expect(decoded.total).toBe(TOTAL);

    const legacy = await get("/api/books", { "accept-encoding": "gzip" });
    expect(legacy.headers["content-encoding"]).toBe("gzip");
    expect(legacy.rawPayload.length).toBeLessThan(400 * 1024);
    expect(JSON.parse(gunzipSync(legacy.rawPayload).toString("utf8"))).toHaveLength(TOTAL);

    const small = await get(`/api/books/${idAt(0)}`, { "accept-encoding": "gzip" });
    expect(small.headers["content-encoding"]).toBeUndefined();
  });

  it("uses the indexes without a temporary sort for every keyset direction", () => {    const cases: Array<[NormalizedQuery, string]> = [
      [{ limit: 60, sort: "added", order: "asc" }, "books_added"],
      [{ limit: 60, sort: "added", order: "desc" }, "books_added"],
      [{ limit: 60, sort: "title", order: "asc" }, "books_title"],
      [{ limit: 60, sort: "title", order: "desc" }, "books_title"],
    ];
    for (const [query, index] of cases) {
      const plan = details(query);
      expect(plan.join(" ")).toContain(index);
      expect(plan.join(" ")).not.toMatch(/TEMP B-TREE/);
    }
    const cursorPlan = details({ limit: 60, sort: "added", order: "desc" }, { sortValue: 9_500, id: idAt(499) });
    expect(cursorPlan.join(" ")).toContain("books_added");
    expect(cursorPlan.join(" ")).toMatch(/SEARCH books/);
    expect(cursorPlan.join(" ")).not.toMatch(/TEMP B-TREE/);

    const titleCursorPlan = details({ limit: 60, sort: "title", order: "asc" }, { sortValue: "Book 0999", id: idAt(999) });
    expect(titleCursorPlan.join(" ")).toContain("books_title");
    expect(titleCursorPlan.join(" ")).not.toMatch(/TEMP B-TREE/);
  });
});
