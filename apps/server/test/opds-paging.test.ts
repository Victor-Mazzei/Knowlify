import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";

const TOTAL = 250;
const root = await mkdtemp(join(tmpdir(), "knowlify-opds-paging-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const entries = (body: string): number => (body.match(/<entry>/g) ?? []).length;
const ids = (body: string): string[] =>
  [...body.matchAll(/<id>urn:knowlify:book:([^<]+)<\/id>/g)].map((match) => match[1]!);

beforeAll(async () => {
  db = openDb(join(root, "opds.db"));
  const insert = db.prepare(
    `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
     VALUES (?,?,?,?,?,NULL,?,?,NULL,NULL,'ready')`,
  );
  db.transaction(() => {
    for (let index = 0; index < TOTAL; index += 1) {
      insert.run(
        `book-${String(index).padStart(4, "0")}`,
        `Book ${String(index).padStart(4, "0")}`,
        "Author",
        index % 2 === 0 ? "epub" : "pdf",
        `/library/book-${index}.epub`,
        100,
        1_000 - index,
      );
    }
  })();
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

describe("OPDS pagination", () => {
  it("serves 100 entries per page with next and previous links", async () => {
    const first = await get("/opds/books");
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("kind=acquisition");
    expect(entries(first.body)).toBe(100);
    expect(first.body).toContain('<id>/opds/books</id>');
    expect(first.body).toContain('rel="next" href="/opds/books?page=2"');
    expect(first.body).not.toContain('rel="previous"');

    const second = await get("/opds/books?page=2");
    expect(entries(second.body)).toBe(100);
    expect(second.body).toContain('<id>/opds/books?page=2</id>');
    expect(second.body).toContain('rel="previous" href="/opds/books"');
    expect(second.body).toContain('rel="next" href="/opds/books?page=3"');

    const third = await get("/opds/books?page=3");
    expect(entries(third.body)).toBe(50);
    expect(third.body).toContain('rel="previous" href="/opds/books?page=2"');
    expect(third.body).not.toContain('rel="next"');

    const beyond = await get("/opds/books?page=4");
    expect(entries(beyond.body)).toBe(0);
    expect(beyond.body).toContain('rel="previous" href="/opds/books?page=3"');
    expect(beyond.body).not.toContain('rel="next"');
  });

  it("walks every book exactly once", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      seen.push(...ids((await get(`/opds/books?page=${page}`)).body));
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("paginates search results and keeps q in the navigation links", async () => {
    const first = await get("/opds/search?q=Book");
    expect(entries(first.body)).toBe(100);
    expect(first.body).toContain('<id>/opds/search?q=Book</id>');
    expect(first.body).toContain('rel="next" href="/opds/search?q=Book&amp;page=2"');

    const second = await get("/opds/search?q=Book&page=2");
    expect(entries(second.body)).toBe(100);
    expect(second.body).toContain('rel="previous" href="/opds/search?q=Book"');
    expect(second.body).toContain('rel="next" href="/opds/search?q=Book&amp;page=3"');
  });

  it("leaves /opds/recent unchanged, without paging links", async () => {
    const recent = await get("/opds/recent");
    expect(recent.statusCode).toBe(200);
    expect(entries(recent.body)).toBe(50);
    expect(recent.body).toContain('<id>/opds/recent</id>');
    expect(recent.body).not.toContain('rel="next"');
    expect(recent.body).not.toContain('rel="previous"');
  });

  it("validates page and compresses the XML feed", async () => {
    expect((await get("/opds/books?page=0")).statusCode).toBe(400);
    expect((await get("/opds/books?page=abc")).statusCode).toBe(400);

    const compressed = await get("/opds/books", { "accept-encoding": "gzip" });
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    const decoded = gunzipSync(compressed.rawPayload).toString("utf8");
    expect(entries(decoded)).toBe(100);
  });
});
