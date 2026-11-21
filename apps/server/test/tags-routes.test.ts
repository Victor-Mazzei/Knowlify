import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteTagRepository } from "../src/adapters/storage/SqliteTagRepository.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { BULK_LIMITS } from "../src/ports/library-tags.js";
import { Tags } from "../src/use-cases/Tags.js";
import { SqliteBookListQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { SqliteUnitOfWork } from "../src/adapters/storage/SqliteBookDuplicateRepository.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-tags-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let books: SqliteBookRepository;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id, title: `Book ${id}`, author: "", format: "epub", path: `/library/${id}.epub`, cover_path: null,
  size: 100, added_at: 1_000, source_id: null, mtime: 1, status: "ready", ...overrides,
});

const request = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });

const seedBook = (id: string, overrides: Partial<Book> = {}) => {
  books.save(book(id, overrides));
};

beforeAll(async () => {
  db = openDb(join(root, "tags.db"));
  books = new SqliteBookRepository(db);
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("tag domain and CRUD", () => {
  it("normalizes names and rejects invalid input", async () => {
    const invalid = [
      [{}, 400],
      [{ name: "" }, 400],
      [{ name: "   " }, 400],
      [{ name: "a".repeat(41) }, 400],
      [{ name: "bad\u0007name" }, 400],
      [{ name: "Valid", color: "chartreuse" }, 400],
    ] as const;
    for (const [payload, status] of invalid) {
      expect((await request("POST", "/api/tags", payload as object)).statusCode).toBe(status);
    }
    const created = await request("POST", "/api/tags", { name: "  Ação   e   Reação  ", color: "amber" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), name: "Ação e Reação", color: "amber", createdAt: expect.any(Number) });
    expect(created.json().id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    // Case folding (NFKC + lower) makes these the same name.
    for (const name of ["ação e reação", "AÇÃO E REAÇÃO"]) {
      const duplicate = await request("POST", "/api/tags", { name });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toEqual({ message: expect.any(String), code: "tag_name_taken" });
    }
    const list = await request("GET", "/api/tags");
    expect(list.json().items).toEqual([{ ...created.json(), count: 0 }]);

    // NFKC folds compatibility forms: full-width letters are the same tag as ASCII.
    expect((await request("POST", "/api/tags", { name: "Ｆｕｌｌ" })).statusCode).toBe(201);
    expect((await request("POST", "/api/tags", { name: "Full" })).json()).toMatchObject({ code: "tag_name_taken" });
  });

  it("renames (only-case allowed), recolors, lists by name_key and deletes associations only", async () => {
    const alpha = (await request("POST", "/api/tags", { name: "Alpha" })).json();
    const zeta = (await request("POST", "/api/tags", { name: "Zeta" })).json();
    expect((await request("PATCH", `/api/tags/${alpha.id}`, { name: "ALPHA" })).statusCode).toBe(200);
    expect((await request("PATCH", `/api/tags/${alpha.id}`, { name: "Zeta" })).json()).toMatchObject({ code: "tag_name_taken" });
    expect((await request("PATCH", `/api/tags/${alpha.id}`, { color: "pink" })).json()).toMatchObject({ color: "pink", name: "ALPHA" });
    expect((await request("PATCH", `/api/tags/${alpha.id}`, {})).statusCode).toBe(400);
    expect((await request("PATCH", "/api/tags/missing", { color: "pink" })).statusCode).toBe(404);

    seedBook("alpha-book");
    const add = await request("PATCH", "/api/books/tags", { selection: { ids: ["alpha-book"] }, add: [alpha.id, zeta.id] });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toEqual({ matched: 1, added: 2, removed: 0 });
    expect((await request("DELETE", `/api/tags/${alpha.id}`)).statusCode).toBe(204);
    expect((await request("DELETE", `/api/tags/${alpha.id}`)).statusCode).toBe(404);
    const page = (await request("GET", "/api/books?limit=10&ids=alpha-book")).json();
    expect(page.items[0].tagIds).toEqual([zeta.id]);
    const list = (await request("GET", "/api/tags")).json().items;
    expect(list.find((tag: { id: string }) => tag.id === zeta.id).count).toBe(1);
  });

  it("orders tagIds by name_key, not by id", async () => {
    const beta = (await request("POST", "/api/tags", { name: "beta" })).json();
    const gamma = (await request("POST", "/api/tags", { name: "Gamma" })).json();
    seedBook("order-book");
    await request("PATCH", "/api/books/tags", { selection: { ids: ["order-book"] }, add: [gamma.id, beta.id] });
    const page = (await request("GET", "/api/books?limit=5&ids=order-book")).json();
    expect(page.items[0].tagIds).toEqual([beta.id, gamma.id]);
    // The legacy array keeps its exact shape (no tagIds key).
    const legacy = (await request("GET", "/api/books?q=Book%20order-book")).json();
    expect(legacy[0]).not.toHaveProperty("tagIds");
  });
});

describe("tag limits and atomic batches", () => {
  it("rejects the 201st tag", async () => {
    const limitRoot = await mkdtemp(join(tmpdir(), "knowlify-tags-limit-"));
    const limitDb = openDb(":memory:");
    const insert = limitDb.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES (?,?,?, 'gray', 1)");
    limitDb.transaction(() => {
      for (let index = 0; index < 200; index += 1) insert.run(`tag-${index}`, `Tag ${index}`, `tag ${index}`);
    })();
    const { app: limitApp } = await buildApp(limitDb);
    await limitApp.ready();
    const response = await limitApp.inject({
      method: "POST", url: "/api/tags", headers: auth, payload: { name: "One more" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "tag_limit_reached" });
    await limitApp.close();
    limitDb.close();
    await rm(limitRoot, { recursive: true, force: true });
  });

  it("rolls back every book when one would exceed the per-book limit", async () => {
    const limitAppRoot = await mkdtemp(join(tmpdir(), "knowlify-tags-book-limit-"));
    config.dataDir = limitAppRoot;
    const limitDb = openDb(":memory:");
    const limitBooks = new SqliteBookRepository(limitDb);
    const seedBooks = ["limited-a", "limited-b"];
    for (const id of seedBooks) limitBooks.save(book(id));
    const tagIds: string[] = [];
    limitDb.transaction(() => {
      for (let index = 0; index < 51; index += 1) {
        const id = `limit-tag-${index}`;
        tagIds.push(id);
        limitDb.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES (?,?,?,'gray',1)")
          .run(id, `Limit ${index}`, `limit ${index}`);
      }
      for (let index = 0; index < 49; index += 1) {
        limitDb.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES (?,?,1)").run("limited-a", tagIds[index]!);
      }
    })();
    const { app: limitApp } = await buildApp(limitDb);
    await limitApp.ready();
    const response = await limitApp.inject({
      method: "PATCH", url: "/api/books/tags", headers: auth,
      payload: { selection: { ids: seedBooks }, add: [tagIds[49], tagIds[50]] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "book_tag_limit" });
    const counts = limitDb.prepare("SELECT book_id, COUNT(*) AS n FROM book_tags GROUP BY book_id ORDER BY book_id")
      .all() as { book_id: string; n: number }[];
    // Nothing changed: A stays at 49 and B never received either tag.
    expect(counts).toEqual([{ book_id: "limited-a", n: 49 }]);
    await limitApp.close();
    limitDb.close();
    await rm(limitAppRoot, { recursive: true, force: true });
    config.dataDir = root;
  });

  it("applies by filter after re-counting, and rejects a changed selection", async () => {
    for (let index = 0; index < 6; index += 1) {
      seedBook(`filter-${index}`, { format: index % 2 === 0 ? "pdf" : "epub", added_at: 2_000 + index });
    }
    const tag = (await request("POST", "/api/tags", { name: "Filtered" })).json();
    const stale = await request("PATCH", "/api/books/tags", {
      selection: { filter: { q: "Book filter-" }, expectedTotal: 5 }, add: [tag.id],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "selection_changed", total: 6 });

    const applied = await request("PATCH", "/api/books/tags", {
      selection: { filter: { q: "Book filter-", format: "pdf" }, expectedTotal: 3 }, add: [tag.id],
    });
    expect(applied.json()).toEqual({ matched: 3, added: 3, removed: 0 });
    const filtered = (await request("GET", "/api/books?limit=10&tag=" + tag.id)).json();
    expect(filtered.items).toHaveLength(3);
    expect(filtered.items.every((book: { format: string }) => book.format === "pdf")).toBe(true);
    expect(filtered.total).toBe(3);

    // Idempotent: adding the same tag again changes nothing.
    const again = await request("PATCH", "/api/books/tags", {
      selection: { filter: { q: "Book filter-", format: "pdf" }, expectedTotal: 3 }, add: [tag.id],
    });
    expect(again.json()).toEqual({ matched: 3, added: 0, removed: 0 });

    const missing = await request("PATCH", "/api/books/tags", {
      selection: { ids: ["filter-0"] }, add: ["no-such-tag"],
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "tag_not_found" });

    for (const payload of [
      { selection: { ids: ["filter-0"] } },
      { selection: { ids: ["filter-0"] }, add: [tag.id], remove: [tag.id] },
      { selection: { ids: ["filter-0"] }, add: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
      { selection: { ids: Array.from({ length: 201 }, (_, index) => `book-${index}`) }, add: [tag.id] },
      { selection: { filter: {}, expectedTotal: 6 } },
    ]) {
      expect((await request("PATCH", "/api/books/tags", payload)).statusCode).toBe(400);
    }
  });

  it("enforces the 20k filter ceiling inside the transaction", () => {
    const bigDb = openDb(":memory:");
    const bigBooks = new SqliteBookRepository(bigDb);
    bigDb.transaction(() => {
      const insert = bigDb.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
        VALUES (?,?,'','epub',?,NULL,1,1,NULL,NULL,'ready')`);
      for (let index = 0; index < BULK_LIMITS.maxFilterSelection + 1; index += 1) {
        const id = `big-${index}`;
        insert.run(id, id, `/library/${id}.epub`);
      }
    })();
    const tags = new Tags(
      new SqliteTagRepository(bigDb),
      new SqliteBookListQuery(bigDb),
      new SqliteUnitOfWork(bigDb),
      { now: () => 1 },
      { next: () => "generated" },
    );
    const tag = tags.create({ name: "Big" });
    expect(() => tags.apply({ filter: {}, expectedTotal: BULK_LIMITS.maxFilterSelection + 1 }, [tag.id], []))
      .toThrowError(expect.objectContaining({ code: "selection_too_large" }));
    expect(bigDb.prepare("SELECT COUNT(*) AS n FROM book_tags").get()).toEqual({ n: 0 });
    bigDb.close();
  });

  it("counts forBooks with a bounded number of queries (no N+1)", () => {
    const spy = vi.spyOn(db, "prepare");
    const repository = new SqliteTagRepository(db);
    const ids = Array.from({ length: 200 }, (_, index) => `book-${index}`);
    repository.forBooks(ids);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("tag filter and facets", () => {
  it("returns a disjunctive tag facet including tags with zero books", async () => {
    const unused = (await request("POST", "/api/tags", { name: "Unused" })).json();
    const common = (await request("POST", "/api/tags", { name: "Common" })).json();
    for (let index = 0; index < 4; index += 1) seedBook(`facet-${index}`, { format: index < 2 ? "pdf" : "epub" });
    await request("PATCH", "/api/books/tags", { selection: { ids: ["facet-0", "facet-1"] }, add: [common.id] });

    const all = (await request("GET", "/api/books/facets")).json();
    expect(all.tag).toEqual(expect.arrayContaining([{ id: unused.id, count: 0 }, { id: common.id, count: 2 }]));

    // The tag facet ignores the tag filter itself but applies the other filters.
    const filtered = (await request("GET", `/api/books/facets?tag=${common.id}&format=pdf`)).json();
    expect(filtered.total).toBe(2);
    expect(filtered.tag.find((entry: { id: string }) => entry.id === common.id).count).toBe(2);
    const epubOnly = (await request("GET", "/api/books/facets?format=epub")).json();
    expect(epubOnly.tag.find((entry: { id: string }) => entry.id === common.id).count).toBe(0);
  });

  it("ORs tag ids inside one parameter and ANDs parameters with read/index filters", async () => {
    const first = (await request("POST", "/api/tags", { name: "First" })).json();
    const second = (await request("POST", "/api/tags", { name: "Second" })).json();
    seedBook("or-a", { format: "pdf" });
    seedBook("or-b", { format: "pdf" });
    seedBook("or-c", { format: "epub" });
    await request("PATCH", "/api/books/tags", { selection: { ids: ["or-a"] }, add: [first.id] });
    await request("PATCH", "/api/books/tags", { selection: { ids: ["or-b", "or-c"] }, add: [second.id] });
    const or = (await request("GET", `/api/books?limit=10&tag=${first.id},${second.id}`)).json();
    expect(new Set(or.items.map((book: { id: string }) => book.id))).toEqual(new Set(["or-a", "or-b", "or-c"]));
    const and = (await request("GET", `/api/books?limit=10&tag=${first.id},${second.id}&format=pdf`)).json();
    expect(new Set(and.items.map((book: { id: string }) => book.id))).toEqual(new Set(["or-a", "or-b"]));
    expect((await request("GET", `/api/books?limit=10&tag=${"a".repeat(65)}`)).statusCode).toBe(400);
    expect((await request("GET", `/api/books?limit=10&tag=${Array.from({ length: 11 }, (_, index) => `t${index}`).join(",")}`)).statusCode).toBe(400);
  });
});
