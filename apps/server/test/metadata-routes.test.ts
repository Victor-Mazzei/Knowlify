import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/SqliteBookRepository.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-metadata-routes-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let books: SqliteBookRepository;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id,
  title: `File ${id}`,
  author: `Author ${id}`,
  format: "epub",
  path: `/library/${id}.epub`,
  cover_path: `/covers/${id}.jpg`,
  size: 10,
  added_at: 1,
  source_id: null,
  mtime: 1,
  status: "ready",
  ...overrides,
});

const request = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

function multipart(field: string, filename: string, type: string, data: Buffer): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----knowlify${randomUUID()}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

const png = async (width = 300, height = 450): Promise<Buffer> => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#123456";
  context.fillRect(0, 0, width, height);
  return canvas.encode("png");
};

beforeAll(async () => {
  db = openDb(join(root, "metadata-routes.db"));
  books = new SqliteBookRepository(db);
  books.save(book("alpha", { title: "Zulu", author: "Zed" }));
  books.save(book("beta", { title: "Alpha", author: "Alpha" }));
  books.save(book("gamma", { title: "Middle", author: "Mike" }));
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/books/:id detail", () => {
  it("returns the list DTO plus tagIds and the metadata object", async () => {
    const response = await request("GET", "/api/books/alpha");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "alpha",
      title: "Zulu",
      author: "Zed",
      favorite: false,
      coverRev: null,
      tagIds: [],
      metadata: {
        title: "Zulu",
        author: "Zed",
        description: null,
        isbn10: null,
        isbn13: null,
        year: null,
        publisher: null,
        language: null,
        series: null,
        seriesIndex: null,
        file: { title: "Zulu", author: "Zed" },
        overridden: {
          title: false, author: false, description: false, isbn10: false, isbn13: false,
          year: false, publisher: false, language: false, series: false, cover: false,
        },
        source: null,
        updatedAt: null,
      },
    });
    expect(response.json().index).toBeDefined();
    expect(response.json().progress).toBeNull();
  });

  it("404s a missing book", async () => {
    expect((await request("GET", "/api/books/missing")).statusCode).toBe(404);
  });
});

describe("PATCH /api/books/:id/metadata", () => {
  it("edits partially and reflects the effective values in the detail and file snapshot", async () => {
    const response = await request("PATCH", "/api/books/alpha/metadata", {
      title: "Aardvark",
      author: "Zed",
      description: "<not html>",
      isbn13: "978-0-13-235088-4",
      year: 2008,
      series: "Saga",
      seriesIndex: 1.25,
      source: "googlebooks",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "alpha",
      title: "Aardvark",
      author: "Zed",
      metadata: {
        title: "Aardvark",
        author: "Zed",
        description: "<not html>",
        isbn13: "9780132350884",
        year: 2008,
        series: "Saga",
        seriesIndex: 1.25,
        file: { title: "Zulu", author: "Zed" },
        source: "googlebooks",
        updatedAt: expect.any(Number),
      },
    });
    expect(response.json().metadata.overridden).toMatchObject({
      title: true, author: true, description: true, isbn13: true, year: true, series: true, cover: false,
    });
    expect(books.get("alpha")).toMatchObject({
      title: "Aardvark",
      file_title: "Zulu",
      file_author: "Zed",
    });

    const cleared = await request("PATCH", "/api/books/alpha/metadata", { title: null, series: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      title: "Zulu",
      metadata: { title: "Zulu", series: null, seriesIndex: null },
    });
    expect(cleared.json().metadata.overridden.title).toBe(false);
  });

  it("rejects invalid fields, unknown keys, both-mode queries and large bodies", async () => {
    const invalid = [
      [{ title: "" }, "title"],
      [{ title: "x".repeat(301) }, "title"],
      [{ isbn10: "0132350883" }, "isbn10"],
      [{ isbn13: "9780132350885" }, "isbn13"],
      [{ year: 0 }, "year"],
      [{ language: "english" }, "language"],
      [{ seriesIndex: 1 }, "seriesIndex"],
      [{ description: "\u0007" }, "description"],
      [{ source: "web" }, "source"],
      [{ unknown: 1 }, "unknown"],
      [{}, "body"],
    ] as const;
    for (const [payload, field] of invalid) {
      const response = await request("PATCH", "/api/books/beta/metadata", payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ field });
    }
    const large = await request("PATCH", "/api/books/beta/metadata", { description: "x".repeat(17 * 1024) });
    expect(large.statusCode).toBe(413);
    expect((await request("PATCH", "/api/books/missing/metadata", { title: "x" })).statusCode).toBe(404);
  });
});

describe("custom cover upload, URL validation and reset", () => {
  it("uploads a re-encoded JPEG, bumps coverRev, serves it and resets", async () => {
    const form = multipart("file", "cover.png", "image/png", await png());
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/books/gamma/cover",
      headers: { ...auth, "content-type": form.contentType },
      payload: form.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const detail = uploaded.json();
    expect(detail.coverRev).toEqual(expect.any(Number));
    expect(detail.hasCover).toBe(true);
    expect(detail.metadata.overridden.cover).toBe(true);

    const cover = await request("GET", "/api/books/gamma/cover");
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/jpeg");
    const bytes = await readFile(join(root, "covers", "custom", "gamma.jpg"));
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const thumb = await request("GET", "/api/books/gamma/cover?size=thumb");
    expect(thumb.statusCode).toBe(200);

    const reset = await request("DELETE", "/api/books/gamma/metadata");
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ coverRev: null, metadata: { source: null } });
    expect(reset.json().metadata.overridden.cover).toBe(false);
    await expect(readFile(join(root, "covers", "custom", "gamma.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await request("GET", "/api/books/gamma/cover")).statusCode).toBe(404);

    expect((await request("DELETE", "/api/books/missing/metadata")).statusCode).toBe(404);
  });

  it("rejects a non-image upload with 415, a missing file with 400 and an oversized file with 413", async () => {
    const text = multipart("file", "cover.jpg", "image/jpeg", Buffer.from("not an image"));
    const rejected = await app.inject({
      method: "PUT",
      url: "/api/books/beta/cover",
      headers: { ...auth, "content-type": text.contentType },
      payload: text.payload,
    });
    expect(rejected.statusCode).toBe(415);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/books/beta/cover",
      headers: { ...auth, "content-type": "multipart/form-data; boundary=x" },
      payload: Buffer.from("--x--\r\n"),
    });
    expect(missing.statusCode).toBe(400);

    const oversized = multipart("file", "cover.png", "image/png", Buffer.alloc(5 * 1024 * 1024 + 1));
    const tooLarge = await app.inject({
      method: "PUT",
      url: "/api/books/beta/cover",
      headers: { ...auth, "content-type": oversized.contentType },
      payload: oversized.payload,
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  it("delete cover restores the file cover state and is idempotent", async () => {
    const form = multipart("file", "cover.png", "image/png", await png());
    await app.inject({
      method: "PUT",
      url: "/api/books/beta/cover",
      headers: { ...auth, "content-type": form.contentType },
      payload: form.payload,
    });
    const cleared = await request("DELETE", "/api/books/beta/cover");
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ coverRev: null, metadata: { overridden: { cover: false } } });
    expect((await request("DELETE", "/api/books/beta/cover")).statusCode).toBe(200);
    expect((await request("DELETE", "/api/books/missing/cover")).statusCode).toBe(404);
  });

  it("deleting a book drops the override, the custom cover and leaves the library file", async () => {
    const library = join(root, "library");
    await mkdir(library, { recursive: true });
    await writeFile(join(library, "delta.epub"), "library bytes");
    books.save(book("delta", { path: join(library, "delta.epub"), source_id: "src" }));
    const form = multipart("file", "cover.png", "image/png", await png());
    await app.inject({
      method: "PUT",
      url: "/api/books/delta/cover",
      headers: { ...auth, "content-type": form.contentType },
      payload: form.payload,
    });
    await request("PATCH", "/api/books/delta/metadata", { title: "Edited before delete" });

    expect((await request("DELETE", "/api/books/delta")).statusCode).toBe(204);
    expect(books.get("delta")).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS n FROM book_metadata_overrides WHERE book_id = 'delta'").get() as { n: number }).n).toBe(0);
    await expect(readFile(join(root, "covers", "custom", "delta.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ignored_books WHERE path = ?").get(join(library, "delta.epub")) as { n: number }).n).toBe(1);
    expect(await readFile(join(library, "delta.epub"), "utf8")).toBe("library bytes");
  });

  it("validates the URL before any network access", async () => {
    const response = await request("POST", "/api/books/beta/cover/from-url", { url: "http://evil.example/x.jpg" });
    expect(response.statusCode).toBe(400);
    expect((await request("POST", "/api/books/beta/cover/from-url", {})).statusCode).toBe(400);
    expect((await request("POST", "/api/books/missing/cover/from-url", { url: "https://covers.openlibrary.org/b/id/1-L.jpg" })).statusCode).toBe(404);
  });
});

describe("effective metadata in list, sort, q and OPDS", () => {
  it("uses the materialized values without extra joins", async () => {
    await request("PATCH", "/api/books/alpha/metadata", { title: "Aardvark", author: "Zulu" });
    const sorted = await request("GET", "/api/books?limit=10&sort=title");
    expect(sorted.statusCode).toBe(200);
    expect(sorted.json().items.map((item: { id: string }) => item.id)).toEqual(["alpha", "beta", "gamma"]);

    const searched = await request("GET", "/api/books?limit=10&q=Aardvark");
    expect(searched.json().items.map((item: { id: string }) => item.id)).toEqual(["alpha"]);

    const byAuthor = await request("GET", "/api/books?limit=10&sort=author");
    expect(byAuthor.json().items.map((item: { id: string }) => item.id)).toEqual(["beta", "gamma", "alpha"]);

    const opds = await app.inject({ method: "GET", url: "/opds/books?q=Aardvark", headers: auth });
    expect(opds.statusCode).toBe(200);
    expect(opds.body).toContain("<title>Aardvark</title>");
  });
});

describe("metadata lookup routes", () => {
  it("reports status without keys and validates the search query", async () => {
    const status = await request("GET", "/api/metadata/status");
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: true,
      providers: [
        { id: "openlibrary", keyConfigured: false },
        { id: "googlebooks", keyConfigured: false },
      ],
    });
    expect((await request("GET", "/api/metadata/search")).statusCode).toBe(400);
    expect((await request("GET", "/api/metadata/search?isbn=0132350884")).statusCode).toBe(400);
    expect((await request("GET", "/api/metadata/search?isbn=9780132350884&title=x")).statusCode).toBe(400);
    expect((await request("GET", "/api/metadata/search?title=")).statusCode).toBe(400);
  });

  it("answers 403 lookup_disabled without touching the network when the feature is off", async () => {
    const previous = config.metadata.lookup;
    config.metadata.lookup = false;
    const disabledDb = openDb(join(root, "disabled.db"));
    const disabled = await buildApp(disabledDb);
    try {
      await disabled.app.ready();
      const status = await disabled.app.inject({ method: "GET", url: "/api/metadata/status", headers: auth });
      expect(status.json()).toMatchObject({ enabled: false });
      const search = await disabled.app.inject({
        method: "GET",
        url: "/api/metadata/search?isbn=9780132350884",
        headers: auth,
      });
      expect(search.statusCode).toBe(403);
      expect(search.json()).toMatchObject({ code: "lookup_disabled" });
      const url = await disabled.app.inject({
        method: "POST",
        url: "/api/books/alpha/cover/from-url",
        headers: auth,
        payload: { url: "https://covers.openlibrary.org/b/id/1-L.jpg" },
      });
      expect(url.statusCode).toBe(403);
      expect(url.json()).toMatchObject({ code: "lookup_disabled" });
    } finally {
      await disabled.app.close();
      disabledDb.close();
      config.metadata.lookup = previous;
    }
  });
});
