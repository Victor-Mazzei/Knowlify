import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository, SqliteSourceRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { contentGroupKey } from "../src/domain/library/ContentIdentity.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-duplicates-routes-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.dbFile = join(root, "knowlify.db");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const hashA = sha("group a");
const hashB = sha("group b");
let db: Db;
let app: FastifyInstance;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const book = (id: string, path: string, size: number, contentHash: string, addedAt: number): Book => ({
  id, title: id, author: "", format: "epub", path, cover_path: null, size, added_at: addedAt,
  source_id: "src", mtime: 1, status: "ready", content_hash: contentHash,
});

beforeAll(async () => {
  db = openDb(":memory:");
  new SqliteSourceRepository(db).save({ id: "src", path: "/lib" });
  const books = new SqliteBookRepository(db);
  const library = join(root, "library");
  await mkdir(library, { recursive: true });
  const saved = (id: string, size: number, contentHash: string, addedAt: number) => {
    const path = join(library, `${id}.epub`);
    writeFileSync(path, Buffer.alloc(size));
    const mtime = Math.floor(statSync(path).mtimeMs);
    books.save({ ...book(id, path, size, contentHash, addedAt), mtime });
  };
  saved("a1", 10, hashA, 1);
  saved("a2", 10, hashA, 2);
  saved("b1", 20, hashB, 3);
  saved("b2", 20, hashB, 4);
  db.prepare(`INSERT INTO book_duplicates (path,book_id,source_id,size,mtime,content_hash,detected_at)
    VALUES ('/lib/a-copy.epub','a1','src',10,1,?,1)`).run(hashA);
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

const get = (url: string, headers = auth) => app.inject({ method: "GET", url, headers });
const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url, headers: auth, payload: payload as object });

describe("duplicate routes", () => {
  it("requires authentication", async () => {
    expect((await app.inject("/api/duplicates")).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/duplicates/scan" })).statusCode).toBe(401);
  });

  it("pages groups with a signed cursor and reports the summary", async () => {
    const first = (await get("/api/duplicates?limit=1")).json();
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]).toMatchObject({
      key: contentGroupKey(20, hashB), size: 20, contentHash: hashB, canonicalId: "b1",
      books: [
        expect.objectContaining({ id: "b1", canonical: true, sourceLabel: "/lib", indexed: false }),
        expect.objectContaining({ id: "b2", canonical: false }),
      ],
      aliases: [],
    });
    expect(first.summary).toMatchObject({ groups: 2, redundantBooks: 2 });
    expect(typeof first.nextCursor).toBe("string");

    const second = (await get(`/api/duplicates?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]).toMatchObject({ key: contentGroupKey(10, hashA), aliases: ["/lib/a-copy.epub"] });
    expect(second.nextCursor).toBeNull();
  });

  it("rejects invalid limits and cursors", async () => {
    expect((await get("/api/duplicates?limit=0")).statusCode).toBe(400);
    expect((await get("/api/duplicates?limit=x")).statusCode).toBe(400);
    expect((await get("/api/duplicates?cursor=garbage")).statusCode).toBe(400);
  });

  it("runs analysis on demand and exposes the duplicate summary in scan status", async () => {
    const started = await post("/api/duplicates/scan");
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ state: expect.stringMatching(/idle|hashing|ready/) });
    let status = (await get("/api/scan")).json();
    for (let attempt = 0; attempt < 50 && status.duplicates.state !== "ready"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await get("/api/scan")).json();
    }
    expect(status.duplicates).toEqual({ state: "ready", progress: null, groups: 2, redundantBooks: 2 });
    expect(status).toMatchObject({ scanning: false, skippedDuplicates: 0, movedFiles: 0 });
  });

  it("validates merge bodies and applies a reviewed merge", async () => {
    const key = contentGroupKey(10, hashA);
    expect((await post("/api/duplicates/merge", {})).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { groups: [] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { groups: [{ key: "bad" }] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { groups: [{ key, canonicalId: "missing" }] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { confirm: [] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { confirm: "nope" })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { confirm: [{ key }] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { confirm: [{ key, fingerprint: "zzz" }] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", { confirm: [{ key, fingerprint: "0".repeat(64) }, { key, fingerprint: "0".repeat(64) }] })).statusCode).toBe(400);
    expect((await post("/api/duplicates/merge", {
      confirm: Array.from({ length: 501 }, (_, index) => ({ key: contentGroupKey(index + 1, hashA), fingerprint: "0".repeat(64) })),
    })).statusCode).toBe(400);

    const dry = (await post("/api/duplicates/merge", { groups: [{ key }], dryRun: true })).json();
    expect(dry).toMatchObject({ merged: 0, plan: { groups: 1, booksRemoved: 1, notesMoved: 0 } });
    expect(Array.isArray(dry.warnings)).toBe(true);
    expect(dry.accepted).toEqual([{ key, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(dry.omitted).toEqual([]);

    const wrong = (await post("/api/duplicates/merge", {
      confirm: [{ key, fingerprint: "0".repeat(64) }],
      dryRun: false,
    })).json();
    expect(wrong).toMatchObject({ merged: 0, skipped: [{ key, reason: "changed" }] });

    const applied = (await post("/api/duplicates/merge", { confirm: dry.accepted, dryRun: false })).json();
    expect(applied).toMatchObject({ merged: 1, booksRemoved: 1, skipped: [] });
    expect((await get("/api/duplicates")).json().summary).toMatchObject({ groups: 1, redundantBooks: 1 });

    const again = (await post("/api/duplicates/merge", { confirm: dry.accepted, dryRun: false })).json();
    expect(again).toMatchObject({ merged: 0, skipped: [{ key, reason: "gone" }] });
  });

  it("merges everything remaining with all", async () => {
    const result = (await post("/api/duplicates/merge", { groups: "all", dryRun: false })).json();
    expect(result.merged).toBe(1);
    expect((await get("/api/duplicates")).json().summary).toMatchObject({ groups: 0, redundantBooks: 0 });
  });
});
