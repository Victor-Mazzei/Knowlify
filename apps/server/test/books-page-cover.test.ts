import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-books-cover-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let books: SqliteBookRepository;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const makeCover = async (width: number, height: number): Promise<Buffer> => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#224466";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#eeeeee";
  context.fillRect(20, 20, width - 40, height - 40);
  return canvas.encode("jpeg", 80);
};

const book = (id: string, coverPath: string | null): Book => ({
  id,
  title: `Title ${id}`,
  author: "Author",
  format: "epub",
  path: join(root, "books", `${id}.epub`),
  cover_path: coverPath,
  size: 10,
  added_at: 1,
  source_id: null,
  mtime: null,
  status: "ready",
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { ...auth, ...headers } });

beforeAll(async () => {
  await mkdir(config.booksDir, { recursive: true });
  await mkdir(config.coversDir, { recursive: true });
  db = openDb(join(root, "knowledge.db"));
  books = new SqliteBookRepository(db);
  const cover = join(config.coversDir, "cover-source.jpg");
  await writeFile(cover, await makeCover(480, 720));
  books.save(book("with-cover", cover));
  books.save(book("missing-file", join(config.coversDir, "gone.jpg")));
  books.save(book("no-cover", null));
  const cachedSource = join(config.coversDir, "cached-source.jpg");
  await writeFile(cachedSource, await makeCover(300, 400));
  books.save(book("cached-thumb", cachedSource));
  const broken = join(config.coversDir, "broken.jpg");
  await writeFile(broken, "not an image");
  books.save(book("broken-cover", broken));
  books.save(book("with-png", join(config.coversDir, "cover.png")));
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/books/:id/cover", () => {
  it("streams the full cover with revalidation headers", async () => {
    const response = await get("/api/books/with-cover/cover");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, max-age=86400");
    expect(response.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.rawPayload.equals(await readFile(books.get("with-cover")!.cover_path!))).toBe(true);

    const notModified = await get("/api/books/with-cover/cover", { "if-none-match": response.headers.etag as string });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers.etag).toBe(response.headers.etag);

    const wildcard = await get("/api/books/with-cover/cover", { "if-none-match": "*" });
    expect(wildcard.statusCode).toBe(304);
    const stale = await get("/api/books/with-cover/cover", { "if-none-match": '"stale"' });
    expect(stale.statusCode).toBe(200);
  });

  it("generates a 240 px JPEG thumbnail on demand and caches it", async () => {
    const response = await get("/api/books/with-cover/cover?size=thumb");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("private, max-age=86400");
    const thumbnail = await loadImage(response.rawPayload);
    expect(thumbnail.width).toBe(240);
    expect(thumbnail.height).toBe(360);
    expect(response.rawPayload.length).toBeLessThan(20 * 1024);

    const cached = join(config.coversDir, "thumbs", "with-cover.jpg");
    expect((await stat(cached)).size).toBe(response.rawPayload.length);
    const notModified = await get(`/api/books/with-cover/cover?size=thumb`, {
      "if-none-match": response.headers.etag as string,
    });
    expect(notModified.statusCode).toBe(304);

    const again = await get("/api/books/with-cover/cover?size=thumb");
    expect(again.statusCode).toBe(200);
    expect(again.headers.etag).toBe(response.headers.etag);
    const notCompressed = await get("/api/books/with-cover/cover?size=thumb", { "accept-encoding": "gzip" });
    expect(notCompressed.headers["content-encoding"]).toBeUndefined();
  });

  it("falls back to the full image for png covers and defaults to full", async () => {
    const png = await createCanvas(120, 180).encode("png");
    await writeFile(join(config.coversDir, "cover.png"), png);
    const response = await get("/api/books/with-png/cover");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(png);
  });

  it("returns 404 for missing books, files and covers, and 400 for an invalid size", async () => {
    const source = books.get("cached-thumb")!.cover_path!;
    expect((await get("/api/books/cached-thumb/cover?size=thumb")).statusCode).toBe(200);
    await rm(source, { force: true });
    expect((await get("/api/books/cached-thumb/cover?size=thumb")).statusCode).toBe(404);

    for (const url of [
      "/api/books/missing/cover",
      "/api/books/no-cover/cover",
      "/api/books/missing-file/cover",
      "/api/books/missing-file/cover?size=thumb",
      "/api/books/broken-cover/cover?size=thumb",
    ]) {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ message: "No cover" });
    }
    const invalid = await get("/api/books/with-cover/cover?size=large");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ message: "size must be full or thumb" });
  });
});
