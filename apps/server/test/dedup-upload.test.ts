import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { IngestionRunner } from "../src/ports/knowledge.js";
import type { FastifyInstance } from "fastify";

const root = await mkdtemp(join(tmpdir(), "knowlify-upload-dedup-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.dbFile = join(root, "knowlify.db");
let db: Db;
let app: FastifyInstance;
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const runner: IngestionRunner = {
  run: async () => ({ kind: "done", contentHash: "bench", chunkCount: 0, indexVersion: "1|none" }),
  embedQuery: async () => null,
  embeddings: () => ({ mode: "none", model: null, state: "off" }),
  indexVersion: () => "1|none",
  onEmbeddingsReady: () => {},
  close: async () => {},
};

const epubWithCover = (suffix: string): Buffer => {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from(`<package><metadata><title>Upload ${suffix}</title><creator>Author</creator></metadata><manifest><item id="cover" href="cover.png" properties="cover-image" media-type="image/png"/></manifest></package>`));
  zip.addFile("cover.png", Buffer.from(`cover ${suffix}`));
  return zip.toBuffer();
};

const upload = (bytes: Buffer, filename = "upload.epub") => {
  const boundary = `knowlify-${createHash("md5").update(bytes).digest("hex")}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/epub+zip\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/api/books",
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
};

beforeAll(async () => {
  db = openDb(":memory:");
  ({ app } = await buildApp(db, false, undefined, runner));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("duplicate uploads", () => {
  it("answers 200 with duplicateOf and writes no file, cover or index job", async () => {
    const epub = epubWithCover("first");
    const first = await upload(epub);
    expect(first.statusCode).toBe(201);
    const bookId = first.json().id;
    expect((await readdir(config.booksDir)).length).toBe(1);
    expect((await readdir(config.coversDir)).length).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM book_index").get()).toEqual({ n: 1 });

    const second = await upload(epub);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id: bookId, duplicateOf: bookId });
    expect((await readdir(config.booksDir)).length).toBe(1);
    expect((await readdir(config.coversDir)).length).toBe(1);
    expect((await readdir(join(config.dataDir, "tmp"))).length).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM book_index").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT content_hash FROM books WHERE id = ?").get(bookId)).toMatchObject({
      content_hash: createHash("sha256").update(epub).digest("hex"),
    });
  });

  it("serializes two simultaneous uploads of the same bytes into one book", async () => {
    const epub = epubWithCover("parallel");
    const [a, b] = await Promise.all([upload(epub, "parallel.epub"), upload(epub, "parallel.epub")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 2 });
    expect((await readdir(config.booksDir)).length).toBe(2);
  });

  it("keeps uploads with different bytes as separate books", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
    const a = await upload(Buffer.from("not really an epub a"), "a.epub");
    const b = await upload(Buffer.from("not really an epub b"), "b.epub");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: before + 2 });
  });
});
