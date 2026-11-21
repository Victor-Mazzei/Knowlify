import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-json-body-"));
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.dataDir = root;
const db = openDb(":memory:");
const { app } = await buildApp(db);
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const json = { ...auth, "content-type": "application/json" };
const books = new SqliteBookRepository(db);

beforeAll(async () => {
  books.save({ id: "book-1", title: "Book", author: "Author", format: "epub", path: join(root, "book-1.epub"),
    cover_path: null, size: 1, added_at: 1000, source_id: null, mtime: null, status: "ready" });
  await app.ready();
});
afterAll(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });

describe("JSON content-type bodies", () => {
  it("parses an empty body as an empty object for body-less requests", async () => {
    const missing = await app.inject({ method: "DELETE", url: "/api/notes/missing", headers: json });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ message: "Not found" });

    const withCharset = await app.inject({ method: "DELETE", url: "/api/notes/missing", headers: { ...auth, "content-type": "application/json; charset=utf-8" } });
    expect(withCharset.statusCode).toBe(404);

    const note = await app.inject({ method: "POST", url: "/api/books/book-1/notes", headers: json, payload: { body: "note" } });
    expect(note.statusCode).toBe(201);
    const deleted = await app.inject({ method: "DELETE", url: `/api/notes/${note.json().id}`, headers: json });
    expect(deleted.statusCode).toBe(204);
  });

  it("keeps the Fastify 5 invalid-JSON error and applies existing body validation to empty bodies", async () => {
    const invalid = await app.inject({ method: "POST", url: "/api/sources", headers: json, payload: '{"path":' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });

    const empty = await app.inject({ method: "POST", url: "/api/books/book-1/notes", headers: json });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ message: "The note cannot be empty" });
  });

  it("rejects prototype poisoning without touching Object.prototype", async () => {
    const poisoned = await app.inject({ method: "POST", url: "/api/sources", headers: json, payload: '{"__proto__":{"polluted":true}}' });
    expect(poisoned.statusCode).toBe(400);
    expect(poisoned.json()).toMatchObject({ code: "FST_ERR_CTP_INVALID_JSON_BODY" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("enforces the JSON body limit", async () => {
    const tooLarge = await app.inject({ method: "POST", url: "/api/sources", headers: json, payload: JSON.stringify({ path: "a".repeat(1024 * 1024) }) });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });
  });
});
