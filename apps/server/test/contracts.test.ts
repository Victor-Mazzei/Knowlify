import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { openDb } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { extractEpub, extractPdf } from "../src/adapters/files/metadata.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-contract-"));
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.dataDir = root;
const db = openDb(":memory:");
const { app, scanner } = await buildApp(db);
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const syncAuth = { "x-auth-user": config.user, "x-auth-key": createHash("md5").update(config.password).digest("hex") };
const books = new SqliteBookRepository(db);
const epubPath = join(root, "fixture.epub");
let epub: Buffer;
let uploadEpub: Buffer;
let noteId: string;
let uploadId: string;
beforeAll(async () => {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from('<package><metadata><title>Fixture &amp; Book</title><creator>Author</creator></metadata><manifest><item id="cover" href="cover.png" properties="cover-image" media-type="image/png"/></manifest></package>'));
  zip.addFile("cover.png", Buffer.from("cover bytes"));
  epub = zip.toBuffer();
  // The upload fixture must differ from the source file or dedup (correctly) answers 200.
  const uploadZip = new AdmZip(epub);
  uploadZip.addFile("extra.txt", Buffer.from("unique upload"));
  uploadEpub = uploadZip.toBuffer();
  await writeFile(epubPath, epub);
  books.save({ id: "source-book", title: "Fixture & Book", author: "Author", format: "epub", path: epubPath,
    cover_path: null, size: epub.length, added_at: 1000, source_id: "source", mtime: 1, status: "ready" });
  await app.ready();
});
afterAll(async () => { await scanner.processPending(); await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
const request = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url, headers: auth, payload });

describe("HTTP contracts", () => {
  it("challenges with Basic only for OPDS and direct navigation, never for app fetches", async () => {
    const challenge = 'Basic realm="knowlify"';
    const health = await app.inject("/health");
    expect(health.json()).toEqual({ ok: true });
    expect(health.headers["www-authenticate"]).toBeUndefined();
    for (const url of ["/api/books", "/api/fs", "/opds/", "/kosync/users/auth"]) expect((await app.inject(url)).statusCode).toBe(401);

    // OPDS readers need the challenge on any failed request, including browser-like fetches.
    expect((await app.inject("/opds/")).headers["www-authenticate"]).toBe(challenge);
    for (const accept of ["application/atom+xml", "application/json", "*/*"]) {
      const response = await app.inject({ url: "/opds/", headers: { accept, "sec-fetch-dest": "empty" } });
      expect(response.headers["www-authenticate"]).toBe(challenge);
    }
    // Direct navigation (Accept: text/html) gets the native prompt; the app's own fetches do not.
    for (const accept of ["text/html", "text/html,application/xhtml+xml", "TEXT/HTML;q=0.9"]) {
      expect((await app.inject({ url: "/api/books", headers: { accept } })).headers["www-authenticate"]).toBe(challenge);
    }
    for (const accept of ["*/*", "application/json"]) {
      expect((await app.inject({ url: "/api/books", headers: { accept, "sec-fetch-dest": "empty" } })).headers["www-authenticate"]).toBeUndefined();
    }
    expect((await app.inject("/api/books")).headers["www-authenticate"]).toBeUndefined();
    expect((await app.inject("/kosync/users/auth")).headers["www-authenticate"]).toBeUndefined();
  });
  it("lists, searches and returns books with the original DTO", async () => {
    const index = { state: "none", error: null };
    const dto = { id: "source-book", title: "Fixture & Book", author: "Author", format: "epub", size: epub.length, addedAt: 1000, hasCover: false, favorite: false, coverRev: null, status: "ready", source: true, index, progress: null };
    expect((await request("GET", "/api/books?q=Fixture")).json()).toEqual([dto]);
    const detail = (await request("GET", "/api/books/source-book")).json();
    expect(detail).toMatchObject(dto);
    expect(detail.tagIds).toEqual([]);
    expect(detail.metadata).toMatchObject({ title: "Fixture & Book", author: "Author" });
    expect((await request("GET", "/api/books/missing")).json()).toEqual({ message: "Not found" });
    // Deleting a library-folder book now removes the row and remembers the tombstone; the
    // file itself is never touched. A disposable row keeps `source-book` for the suite.
    books.save({ id: "delete-me", title: "Delete me", author: "", format: "epub", path: join(root, "delete-me.epub"),
      cover_path: null, size: 10, added_at: 1000, source_id: "source", mtime: 1, status: "ready" });
    expect((await request("DELETE", "/api/books/delete-me")).statusCode).toBe(204);
    expect(books.get("delete-me")).toBeUndefined();
    expect((await request("DELETE", "/api/books/missing")).statusCode).toBe(404);
  });
  it("streams book and cover files, including missing responses", async () => {
    const file = await request("GET", "/api/books/source-book/file");
    expect(file.rawPayload).toEqual(epub);
    expect(file.headers["content-type"]).toBe("application/epub+zip");
    expect(file.headers["content-disposition"]).toContain("Fixture%20%26%20Book.epub");
    expect((await request("GET", "/api/books/missing/file")).statusCode).toBe(404);
    expect((await request("GET", "/api/books/source-book/cover")).json()).toEqual({ message: "No cover" });
    const cover = join(root, "cover.png"); await writeFile(cover, "image");
    books.save({ ...books.get("source-book")!, cover_path: cover });
    const response = await request("GET", "/api/books/source-book/cover");
    expect(response.body).toBe("image"); expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("private, max-age=86400");
  });
  it("imports multipart uploads and deletes only owned books and notes", async () => {
    expect((await request("POST", "/api/books")).statusCode).toBe(406);
    const empty = await app.inject({ method: "POST", url: "/api/books", headers: { ...auth, "content-type": "multipart/form-data; boundary=empty" }, payload: "--empty--\r\n" });
    expect(empty.statusCode).toBe(400); expect(empty.json()).toEqual({ message: "Missing file" });
    const boundary = "knowlify-test";
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`), uploadEpub, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const result = await app.inject({ method: "POST", url: "/api/books", headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(result.statusCode).toBe(201); uploadId = result.json().id;
    expect(result.json()).toMatchObject({ title: "Fixture & Book", hasCover: true, source: false, progress: null });
    expect((await request("POST", `/api/books/${uploadId}/notes`, { body: "owned" })).statusCode).toBe(201);
    const unsupported = await app.inject({ method: "POST", url: "/api/books", headers: { ...auth, "content-type": "multipart/form-data; boundary=invalid" }, payload: '--invalid\r\nContent-Disposition: form-data; name="file"; filename="book.txt"\r\n\r\ntext\r\n--invalid--\r\n' });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toEqual({ message: "Only PDF and EPUB are supported" });
    // The upload has notes, so deleting it requires the explicit confirmation flag.
    const blocked = await request("DELETE", `/api/books/${uploadId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ message: expect.stringContaining("notes"), code: "notes_confirmation_required", notes: 1 });
    expect((await request("DELETE", `/api/books/${uploadId}?confirmNotes=1`)).statusCode).toBe(204);
    expect((await request("GET", `/api/books/${uploadId}/notes`)).json()).toEqual([]);
  });
  it("gets and saves web progress and exposes it in book DTOs", async () => {
    expect((await request("GET", "/api/books/source-book/progress")).json()).toEqual({ message: "No progress" });
    expect((await request("GET", "/api/books/source-book")).json()).toMatchObject({ progress: null });
    expect((await request("PUT", "/api/books/missing/progress", { position: "1", percentage: 0.5 })).statusCode).toBe(404);
    expect((await request("PUT", "/api/books/source-book/progress", { position: "epubcfi(/6)", percentage: 0.5 })).statusCode).toBe(204);
    expect((await request("GET", "/api/books/source-book/progress")).json()).toEqual({ position: "epubcfi(/6)", percentage: 0.5 });
    const detail = (await request("GET", "/api/books/source-book")).json();
    expect(detail.progress).toEqual({ percentage: 0.5, updatedAt: expect.any(Number) });
    expect((await request("GET", "/api/books")).json()[0].progress).toEqual(detail.progress);
    // The DTO clamps out-of-range values without rewriting the stored progress.
    await request("PUT", "/api/books/source-book/progress", { position: "epubcfi(/6)", percentage: 1.5 });
    expect((await request("GET", "/api/books/source-book")).json().progress.percentage).toBe(1);
    expect((await request("GET", "/api/books/source-book/progress")).json().percentage).toBe(1.5);
    await request("PUT", "/api/books/source-book/progress", { position: "epubcfi(/6)", percentage: 0.5 });
  });
  it("adds, lists, searches, edits and deletes notes with original validation order", async () => {
    expect((await request("POST", "/api/books/missing/notes", { body: "" })).statusCode).toBe(404);
    expect((await request("POST", "/api/books/source-book/notes", { body: " " })).json()).toEqual({ message: "The note cannot be empty" });
    const added = await request("POST", "/api/books/source-book/notes", { body: "  hello  ", quote: "quote", location: "page", label: "label" });
    expect(added.statusCode).toBe(201); noteId = added.json().id;
    expect(added.json()).toMatchObject({ body: "hello", bookId: "source-book", quote: "quote", location: "page", label: "label" });
    expect((await request("GET", "/api/books/source-book/notes")).json()).toEqual([added.json()]);
    expect((await request("GET", "/api/notes?q=hello")).json()).toEqual([{ ...added.json(), bookTitle: "Fixture & Book" }]);
    expect((await request("PATCH", `/api/notes/${noteId}`, { body: "edited", quote: "ignored" })).json()).toMatchObject({ body: "edited", quote: "quote" });
    expect((await request("PATCH", "/api/notes/missing", { body: "" })).statusCode).toBe(400);
    expect((await request("PATCH", "/api/notes/missing", { body: "valid" })).statusCode).toBe(404);
    expect((await request("DELETE", `/api/notes/${noteId}`)).statusCode).toBe(204);
    expect((await request("DELETE", `/api/notes/${noteId}`)).statusCode).toBe(404);
  });
  it("browses directories and manages sources and scan status", async () => {
    const dir = join(root, "empty"); await mkdir(dir);
    expect((await request("GET", `/api/fs?path=${encodeURIComponent(root)}`)).json()).toMatchObject({ path: root, books: 1, entries: expect.arrayContaining([{ name: "empty", path: dir }]) });
    expect((await request("GET", "/api/fs?path=/does-not-exist-knowlify")).statusCode).toBe(400);
    expect((await request("POST", "/api/sources", {})).json()).toEqual({ message: "path is required" });
    expect((await request("POST", "/api/sources", { path: "/does-not-exist-knowlify" })).statusCode).toBe(400);
    const source = await request("POST", "/api/sources", { path: dir }); expect(source.statusCode).toBe(201);
    await scanner.scan();
    expect((await request("GET", "/api/sources")).json()).toContainEqual({ ...source.json(), accessible: true, books: 0 });
    expect((await request("GET", "/api/scan")).json()).toMatchObject({ pending: 0, lastScanAt: expect.any(Number) });
    expect((await request("POST", "/api/scan")).statusCode).toBe(202);
    expect((await request("DELETE", `/api/sources/${source.json().id}`)).statusCode).toBe(204);
    expect((await request("DELETE", "/api/sources/missing")).statusCode).toBe(404);
  });
  it.each(["/opds", "/opds/", "/opds/books", "/opds/recent", "/opds/search?q=Fixture", "/opds/search.xml"])("serves OPDS %s", async url => {
    const response = await request("GET", url);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    if (url.includes("books") || url.includes("recent") || url.includes("search?")) {
      expect(response.body).toContain("Fixture &amp; Book");
      expect(response.body).toContain('href="/api/books/source-book/file"');
      expect(response.body).toContain("1970-01-01T00:00:01.000Z");
    }
  });
  it("preserves the complete acquisition feed XML", async () => {
    const response = await request("GET", "/opds/books");
    expect(response.headers["content-type"]).toContain("application/atom+xml;profile=opds-catalog;kind=acquisition");
    expect(response.body).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>/opds/books</id><title>All books</title><updated>1970-01-01T00:00:01.000Z</updated>
<author><name>Knowlify</name></author>
<link rel="self" href="/opds/books" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/><link rel="start" href="/opds/" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
<link rel="search" href="/opds/search.xml" type="application/opensearchdescription+xml"/>
<entry><id>urn:knowlify:book:source-book</id><title>Fixture &amp; Book</title>
<updated>1970-01-01T00:00:01.000Z</updated><author><name>Author</name></author>
<link rel="http://opds-spec.org/acquisition" href="/api/books/source-book/file" type="application/epub+zip"/>
<link rel="http://opds-spec.org/image" href="/api/books/source-book/cover" type="image/png"/><link rel="http://opds-spec.org/image/thumbnail" href="/api/books/source-book/cover" type="image/png"/></entry></feed>`);
  });
  it("implements KOSync independently of web progress", async () => {
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url: `/kosync${url}`, headers: syncAuth, payload });
    expect((await call("POST", "/users/create")).statusCode).toBe(201);
    expect((await call("POST", "/users/create")).json()).toEqual({ username: config.user });
    expect((await call("GET", "/users/auth")).json()).toEqual({ authorized: "OK" });
    expect((await call("GET", "/syncs/progress/missing")).json()).toEqual({ message: "Document not found on server" });
    const progress = { document: "source-book", progress: "page:10", percentage: 0.2, device: "KOReader", device_id: "device" };
    const saved = await call("PUT", "/syncs/progress", progress);
    expect(saved.json()).toEqual({ document: "source-book", timestamp: expect.any(Number) });
    expect((await call("GET", "/syncs/progress/source-book")).json()).toEqual({ ...progress, timestamp: saved.json().timestamp });
    expect((await call("PUT", "/syncs/progress", { ...progress, percentage: 2 })).statusCode).toBe(400);
    expect((await request("GET", "/api/books/source-book/progress")).json()).toEqual({ position: "epubcfi(/6)", percentage: 0.5 });
  });
});

describe("file extraction", () => {
  it("extracts a generated EPUB and cover", async () => {
    expect(await extractEpub(epubPath)).toEqual({ title: "Fixture & Book", author: "Author", cover: { data: Buffer.from("cover bytes"), ext: "png" } });
  });
  it("extracts a generated PDF", async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([100, 100]); pdf.setTitle("PDF title"); pdf.setAuthor("PDF author");
    const path = join(root, "fixture.pdf"); await writeFile(path, await pdf.save());
    const meta = await extractPdf(path); expect(meta).toMatchObject({ title: "PDF title", author: "PDF author" });
    expect(meta.cover?.ext).toBe("jpg"); expect(meta.cover?.data.length).toBeGreaterThan(0);
  });
});
