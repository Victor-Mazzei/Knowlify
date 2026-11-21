import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository, SqliteNoteRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book, Note } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-notes-groups-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const book = (id: string, title: string, author: string, format: Book["format"], cover_path: string | null = null): Book => ({
  id, title, author, format, path: `/library/${id}.${format}`, cover_path,
  size: 1_000, added_at: 10, source_id: null, mtime: 1, status: "ready",
});

const note = (id: string, bookId: string, body: string, createdAt: number, updatedAt: number, extra: Partial<Note> = {}): Note => ({
  id, book_id: bookId, location: "p1", label: "", quote: "", body, created_at: createdAt, updated_at: updatedAt, ...extra,
});

const duneNotes = [
  note("dune-1", "dune", "The spice must flow", 10, 100, { label: "desert" }),
  note("dune-2", "dune", "Fear is the mind killer", 20, 300, { quote: "I must not fear" }),
  note("dune-3", "dune", "100% of the sand", 30, 200),
];
const cleanNotes = [
  note("clean-1", "clean", "Refactor mercilessly", 40, 400, { label: "practice" }),
  note("clean-2", "clean", "Uncle Bob writes again", 50, 50),
];

function seed(database: Db): void {
  const books = new SqliteBookRepository(database);
  const notes = new SqliteNoteRepository(database);
  books.save(book("dune", "Dune", "Frank Herbert", "pdf"));
  books.save(book("clean", "Clean Code", "Robert C. Martin", "epub", "/covers/clean.jpg"));
  for (const row of [...duneNotes, ...cleanNotes]) notes.save(row);
  // Orphan note: the book row is gone, so no endpoint may show it in groups or search.
  notes.save(note("orphan", "missing", "orphan note", 60, 999));
}

beforeAll(async () => {
  db = openDb(":memory:");
  seed(db);
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

const duneGroup = {
  book: { id: "dune", title: "Dune", author: "Frank Herbert", format: "pdf", hasCover: false },
  noteCount: 3,
  lastNoteAt: 300,
  notes: [duneNotes[1], duneNotes[2], duneNotes[0]].map((row) => ({
    id: row.id, bookId: row.book_id, bookTitle: "Dune", location: row.location,
    label: row.label, quote: row.quote, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
  })),
  hasMore: false,
};
const cleanGroup = {
  book: { id: "clean", title: "Clean Code", author: "Robert C. Martin", format: "epub", hasCover: true },
  noteCount: 2,
  lastNoteAt: 400,
  notes: cleanNotes.map((row) => ({
    id: row.id, bookId: row.book_id, bookTitle: "Clean Code", location: row.location,
    label: row.label, quote: row.quote, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
  })),
  hasMore: false,
};

describe("GET /api/notes/groups", () => {
  it("groups notes by book, orders groups by their latest matching note and honours the exact contract", async () => {
    const response = await get("/api/notes/groups");
    expect(response.statusCode).toBe(200);
    expect(response.headers.vary).toBe("Authorization");
    expect(response.json()).toEqual({
      items: [cleanGroup, duneGroup],
      nextCursor: null,
      totalBooks: 2,
      totalNotes: 5,
    });
    expect(Object.keys(response.json().items[0].book)).toEqual(["id", "title", "author", "format", "hasCover"]);
  });

  it("limits notes per group and reports hasMore without changing noteCount", async () => {
    const page = (await get("/api/notes/groups?perGroup=1")).json();
    expect(page.items.map((group: { book: { id: string } }) => group.book.id)).toEqual(["clean", "dune"]);
    expect(page.items[0].notes.map((row: { id: string }) => row.id)).toEqual(["clean-1"]);
    expect(page.items[0]).toMatchObject({ noteCount: 2, hasMore: true });
    expect(page.items[1].notes.map((row: { id: string }) => row.id)).toEqual(["dune-2"]);
    expect(page.items[1]).toMatchObject({ noteCount: 3, hasMore: true, lastNoteAt: 300 });
  });

  it("pages by group without repeating or losing a book", async () => {
    const seen: string[] = [];
    let url: string | null = "/api/notes/groups?limit=1&perGroup=1";
    let requests = 0;
    while (url !== null) {
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      seen.push(...body.items.map((group: { book: { id: string } }) => group.book.id));
      url = body.nextCursor === null
        ? null
        : `/api/notes/groups?limit=1&perGroup=1&cursor=${encodeURIComponent(body.nextCursor)}`;
      requests += 1;
    }
    expect(seen).toEqual(["clean", "dune"]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(requests).toBe(2);
    const empty = await get("/api/notes/groups?limit=1&cursor=" + encodeURIComponent("eyJsYXN0Tm90ZUF0IjowLCJib29rSWQiOiJhIn0"));
    expect(empty.json().items).toEqual([]);
    expect(empty.json().nextCursor).toBeNull();
  });

  it("matches note body, quote, label and the book title or author", async () => {
    const byBody = (await get("/api/notes/groups?q=spice")).json();
    expect(byBody.items).toHaveLength(1);
    expect(byBody.items[0]).toMatchObject({ noteCount: 1, lastNoteAt: 100, book: { id: "dune" } });
    expect(byBody).toMatchObject({ totalBooks: 1, totalNotes: 1 });
    expect(byBody.items[0].notes.map((row: { id: string }) => row.id)).toEqual(["dune-1"]);

    const byQuote = (await get("/api/notes/groups?q=fear")).json();
    expect(byQuote.items[0].notes.map((row: { id: string }) => row.id)).toEqual(["dune-2"]);

    const byLabel = (await get("/api/notes/groups?q=desert")).json();
    expect(byLabel.items[0].notes.map((row: { id: string }) => row.id)).toEqual(["dune-1"]);

    const byAuthor = (await get("/api/notes/groups?q=herbert")).json();
    expect(byAuthor.items).toHaveLength(1);
    expect(byAuthor.items[0]).toMatchObject({ noteCount: 3, notes: duneGroup.notes });
    expect(byAuthor).toMatchObject({ totalBooks: 1, totalNotes: 3 });

    const byTitle = (await get("/api/notes/groups?q=clean")).json();
    expect(byTitle.items).toHaveLength(1);
    expect(byTitle.items[0]).toMatchObject({ noteCount: 2, notes: cleanGroup.notes });

    const literal = (await get("/api/notes/groups?q=100%25")).json();
    expect(literal.items[0].notes.map((row: { id: string }) => row.id)).toEqual(["dune-3"]);

    const trimmed = (await get("/api/notes/groups?q=%20%20spice%20%20")).json();
    expect(trimmed).toMatchObject({ totalBooks: 1, totalNotes: 1 });
  });

  it("rejects malformed limits, queries and cursors with 400", async () => {
    for (const url of [
      "/api/notes/groups?limit=0",
      "/api/notes/groups?limit=51",
      "/api/notes/groups?limit=abc",
      "/api/notes/groups?perGroup=0",
      "/api/notes/groups?perGroup=21",
      "/api/notes/groups?perGroup=1.5",
      `/api/notes/groups?q=${"x".repeat(201)}`,
      "/api/notes/groups?cursor=not-a-cursor",
      `/api/notes/groups?cursor=${Buffer.from("{}").toString("base64url")}`,
      `/api/notes/groups?cursor=${Buffer.from("[]").toString("base64url")}`,
      `/api/notes/groups?cursor=${Buffer.from(JSON.stringify({ lastNoteAt: "x", bookId: "dune" })).toString("base64url")}`,
      `/api/notes/groups?cursor=${Buffer.from(JSON.stringify({ lastNoteAt: 1, bookId: "" })).toString("base64url")}`,
      `/api/notes/groups?cursor=${Buffer.from(JSON.stringify({ lastNoteAt: 1, bookId: "dune", extra: true })).toString("base64url")}`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ message: expect.any(String) });
    }
    const repeated = await get("/api/notes/groups?q=a&q=b");
    expect(repeated.statusCode).toBe(400);
  });

  it("keeps GET /api/notes byte-for-byte identical without the new parameter", async () => {
    const response = await get("/api/notes");
    expect(response.statusCode).toBe(200);
    const expected = [cleanNotes[0], duneNotes[1], duneNotes[2], duneNotes[0], cleanNotes[1]].map((row) => ({
      id: row.id, bookId: row.book_id, bookTitle: row.book_id === "dune" ? "Dune" : "Clean Code",
      location: row.location, label: row.label, quote: row.quote, body: row.body,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
    expect(response.json()).toEqual(expected);
    // The legacy search still looks only at body, quote and title (not author or label).
    expect((await get("/api/notes?q=herbert")).json()).toEqual([]);
    expect((await get("/api/notes?q=spice")).json()).toEqual([expected[3]]);
    expect((await get("/api/notes?q=100%25")).json()).toEqual([expected[2]]);
  });
});

describe("GET /api/books/:id/notes?q", () => {
  it("keeps the existing response without q", async () => {
    const response = await get("/api/books/dune/notes");
    expect(response.statusCode).toBe(200);
    expect(response.json().map((row: { id: string }) => row.id)).toEqual(["dune-3", "dune-2", "dune-1"]);
    expect((await get("/api/books/missing/notes")).json().map((row: { id: string }) => row.id)).toEqual(["orphan"]);
  });

  it("filters by note fields and by the book title or author, preserving created_at DESC", async () => {
    expect((await get("/api/books/dune/notes?q=spice")).json().map((row: { id: string }) => row.id)).toEqual(["dune-1"]);
    expect((await get("/api/books/dune/notes?q=fear")).json().map((row: { id: string }) => row.id)).toEqual(["dune-2"]);
    expect((await get("/api/books/dune/notes?q=desert")).json().map((row: { id: string }) => row.id)).toEqual(["dune-1"]);
    expect((await get("/api/books/dune/notes?q=herbert")).json().map((row: { id: string }) => row.id))
      .toEqual(["dune-3", "dune-2", "dune-1"]);
    expect((await get("/api/books/dune/notes?q=clean")).json()).toEqual([]);
    expect((await get("/api/books/dune/notes?q=100%25")).json().map((row: { id: string }) => row.id)).toEqual(["dune-3"]);
    expect((await get("/api/books/dune/notes?q=%20%20")).json()).toHaveLength(3);
    expect((await get(`/api/books/dune/notes?q=${"x".repeat(201)}`)).statusCode).toBe(400);
    expect((await get("/api/books/dune/notes?q=a&q=b")).statusCode).toBe(400);
  });
});
