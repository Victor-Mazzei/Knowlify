/**
 * Reproducible benchmark for the 11k-books scale task. No fixed ports: the app is exercised
 * with Fastify `inject` against a throw-away data dir.
 *
 *   cd apps/server && N=11000 PASSAGE_BOOKS=100 npx tsx ../../scripts/bench/bench.mts
 *
 * Short smoke run: N=200 PASSAGE_BOOKS=2 PASSAGES_PER_BOOK=20 npx tsx ../../scripts/bench/bench.mts
 *
 * Env: N (books, default 11000), PASSAGE_BOOKS (books that get synthetic passages, default 100),
 *      PASSAGES_PER_BOOK (default 400), DIM (vector dim, default 384), KEEP=1 (keep data dir).
 *      RAG=1 also measures ingestion throughput/DB size (RAG_BOOKS, RAG_PARAGRAPHS,
 *      RAG_WORKERS, RAG_MODES=none,http). Prints one JSON object; compare before/after by diffing.
 */
import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const N = Number(process.env.N ?? 11000);
const PASSAGE_BOOKS = Number(process.env.PASSAGE_BOOKS ?? 100);
const PER_BOOK = Number(process.env.PASSAGES_PER_BOOK ?? 400);
const DIM = Number(process.env.DIM ?? 384);
// server-import phase 0/after: generated source library.
const SCAN = process.env.SCAN !== "0";
const SCAN_N = Number(process.env.SCAN_N ?? N);
const SCAN_PDF = Number(process.env.SCAN_PDF ?? Math.min(300, SCAN_N));
const BASELINE_N = Number(process.env.BASELINE_N ?? Math.min(2000, SCAN_N));
const META_EPUB = Number(process.env.META_EPUB ?? (SCAN_N >= 1000 ? 3000 : Math.min(300, SCAN_N)));
const META_PDF = Number(process.env.META_PDF ?? Math.min(120, SCAN_PDF));
const META_CHAPTERS = Number(process.env.META_CHAPTERS ?? (SCAN_N >= 1000 ? 100 : 5));
const META_CHAPTER_KB = Number(process.env.META_CHAPTER_KB ?? 50);
const METADATA_WORKERS = Number(process.env.METADATA_WORKERS ?? 3);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY ?? 8);
const dir = mkdtempSync(join(tmpdir(), "knowlify-bench-"));
process.env.KNOWLIFY_DATA = dir; // must be set before importing config
process.env.KNOWLIFY_USER = "bench";
process.env.KNOWLIFY_PASSWORD = "bench";

const { openDb } = await import("../../apps/server/src/adapters/storage/db.js");
const { buildApp } = await import("../../apps/server/src/index.js");
const { config } = await import("../../apps/server/src/config.js");
const { SqliteBlobVectorStore } = await import("../../apps/server/src/adapters/storage/SqliteBlobVectorStore.js");
// Benchmarks for the index filters need the feature enabled; no worker is started by buildApp.
config.indexing.enabled = true;
const benchRunner = {
  run: async () => ({ kind: "done" as const, contentHash: "bench", chunkCount: 0, indexVersion: "1|none" }),
  embedQuery: async () => null,
  embeddings: () => ({ mode: "none" as const, model: null, state: "off" as const }),
  indexVersion: () => "1|none",
  onEmbeddingsReady: () => {},
  close: async () => {},
};

const out: Record<string, unknown> = { N, PASSAGE_BOOKS, PER_BOOK, DIM };
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const db = openDb(join(dir, "knowlify.db"));

// ---- seed: books, 70% with cover, 30% with progress, 20% with notes, 90% index ready
let t = performance.now();
const words = ["Clean", "Code", "Domain", "Driven", "Design", "Refactoring", "Patterns", "Systems", "Rust", "Async", "História", "Filosofia", "Cálculo"];
db.transaction(() => {
  const book = db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'ready')`);
  const idx = db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
    VALUES (?,?,0,0,?, '1|none')`);
  const prog = db.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)");
  const note = db.prepare("INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',?,?)");
  const tag = db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES (?,?,?, 'gray', ?)");
  const bookTag = db.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES (?,?,?)");
  const now = Date.now();
  for (let t = 0; t < 6; t++) tag.run(`tag-${t}`, `Tag ${t}`, `tag ${t}`, now);
  tag.run("tag-rare", "Rare", "rare", now);
  for (let i = 0; i < N; i++) {
    const id = `book-${String(i).padStart(6, "0")}`;
    const title = `${words[i % words.length]} ${words[(i * 7) % words.length]} Vol. ${i} — a fairly long realistic book title`;
    const source = i % 4 === 1 ? "src2" : i % 4 === 2 ? null : "src";
    book.run(id, title, `Author ${i % 900} Surname`, i % 3 ? "pdf" : "epub", `/lib/src${i % 40}/${id}.pdf`,
      i % 10 < 7 ? `/covers/${id}.jpg` : null, 1_000_000 + i, now - i * 1000, source, now);
    idx.run(id, i % 10 === 9 ? "pending" : i % 10 === 8 ? "error" : "ready", now);
    bookTag.run(id, `tag-${i % 6}`, now);
    bookTag.run(id, `tag-${(i + 1) % 6}`, now);
    if (i === 42) bookTag.run(id, "tag-rare", now);
    if (i % 10 < 3) {
      const percentage = i % 10 === 0 ? 0.004 : i % 10 === 1 ? 0.5 : 0.995;
      prog.run(id, "epubcfi(/6/2)", percentage, now - i * 1000);
    }
    if (i % 5 === 0) note.run(`note-${id}`, id, now, now);
  }
  db.prepare("INSERT INTO sources (id,path) VALUES ('src','/lib/src'),('src2','/lib/src2')").run();
})();
out.seedMs = ms(t);

// ---- synthetic passages for vector scan extrapolation
t = performance.now();
const vec = (seed: number) => {
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let k = 0; k < DIM; k++) { v[k] = Math.sin(seed * 12.9898 + k * 78.233); norm += v[k]! * v[k]!; }
  norm = Math.sqrt(norm);
  for (let k = 0; k < DIM; k++) v[k] = v[k]! / norm;
  return v;
};
db.transaction(() => {
  const chunk = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES (?,?,?,?,NULL)");
  const vector = db.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (?,?,?)");
  for (let b = 0; b < Math.min(PASSAGE_BOOKS, N); b++) {
    const id = `book-${String(b).padStart(6, "0")}`;
    for (let o = 0; o < PER_BOOK; o++) {
      const r = chunk.run(id, o, `lorem ipsum ${words[(b + o) % words.length]} `.repeat(60), o);
      vector.run(Number(r.lastInsertRowid), id, Buffer.from(vec(b * 1000 + o).buffer));
    }
  }
})();
out.passageSeedMs = ms(t);
const sample = PASSAGE_BOOKS * PER_BOOK;
out.sampleVectors = sample;

// ---- vector scan (exact) and extrapolation to the full library
const store = new SqliteBlobVectorStore(db);
t = performance.now();
await store.nearest(vec(42), 8);
const scanMs = ms(t);
const fullVectors = N * PER_BOOK;
out.vectorScanMs = { sample: scanMs, extrapolatedToFullLibrary: Math.round((scanMs / sample) * fullVectors), fullVectors, fullVectorsGiB: +(fullVectors * DIM * 4 / 2 ** 30).toFixed(2) };

// ---- HTTP: /api/books
const { app } = await buildApp(db, false, undefined, benchRunner);
const auth = { authorization: `Basic ${Buffer.from("bench:bench").toString("base64")}` };
const loop = monitorEventLoopDelay({ resolution: 5 });
async function get(url: string, headers: Record<string, string> = {}) {
  const start = performance.now();
  const res = await app.inject({ method: "GET", url, headers: { ...auth, ...headers } });
  return { status: res.statusCode, ms: ms(start), bytes: res.rawPayload.length };
}
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
};
loop.enable();
await get("/api/books"); // warm up
const runs = [];
for (let i = 0; i < 5; i++) runs.push(await get("/api/books"));
out.booksList = { runs, heapMiB: Math.round(process.memoryUsage().heapUsed / 2 ** 20) };
out.booksListSearch = await get("/api/books?q=Refactoring");

// ---- paged list: p95 of 20 page loads, cursor walk through the whole library
const pageRuns = [];
for (let i = 0; i < 20; i++) pageRuns.push(await get("/api/books?limit=60"));
out.booksPage = {
  runs: pageRuns.map((run) => run.ms),
  p95Ms: percentile(pageRuns.map((run) => run.ms), 0.95),
  bytes: pageRuns[0]!.bytes,
};
const searchPage = await get("/api/books?limit=60&q=Refactoring");
const searchRuns = [];
for (let i = 0; i < 10; i++) searchRuns.push(await get("/api/books?limit=60&q=Refactoring"));
out.booksPageSearch = { ...searchPage, p95Ms: percentile(searchRuns.map((run) => run.ms), 0.95) };
const walk = { pages: 0, unique: 0, ms: 0, stop: null as string | null };
{
  const seen = new Set<string>();
  let cursor: string | null = null;
  const start = performance.now();
  do {
    const response = await app.inject({
      method: "GET",
      url: `/api/books?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      headers: auth,
    });
    const body = response.json() as { items: { id: string }[]; nextCursor: string | null };
    body.items.forEach((book) => seen.add(book.id));
    cursor = body.nextCursor;
    walk.pages += 1;
    if (walk.pages > 100) { walk.stop = "page_limit"; break; }
  } while (cursor);
  walk.unique = seen.size;
  walk.ms = ms(start);
}
out.booksWalk = walk;
// Deep title pages still walk the index instead of sorting, but they start further in.
const titleWalk = { pages: 0, unique: 0, p95Ms: 0, maxMs: 0, lastMs: 0, stop: null as string | null };
{
  const seen = new Set<string>();
  const pageMs: number[] = [];
  let cursor: string | null = null;
  do {
    const started = performance.now();
    const response = await app.inject({
      method: "GET",
      url: `/api/books?limit=60&sort=title&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      headers: auth,
    });
    const body = response.json() as { items: { id: string }[]; nextCursor: string | null };
    pageMs.push(ms(started));
    body.items.forEach((book) => seen.add(book.id));
    cursor = body.nextCursor;
    titleWalk.pages += 1;
    if (titleWalk.pages > 400) { titleWalk.stop = "page_limit"; break; }
  } while (cursor);
  titleWalk.unique = seen.size;
  titleWalk.p95Ms = percentile(pageMs, 0.95);
  titleWalk.maxMs = Math.max(...pageMs);
  titleWalk.lastMs = pageMs[pageMs.length - 1] ?? 0;
}
out.booksTitleWalk = titleWalk;

// ---- library filters and facets (library-filters acceptance): p95 per shape
const measure = async (urls: string[], runs = 20): Promise<Record<string, unknown>> => {
  const result: Record<string, unknown> = {};
  for (const url of urls) {
    const samples: number[] = [];
    let last = { status: 0, ms: 0, bytes: 0 };
    for (let i = 0; i < runs; i += 1) {
      last = await get(url);
      samples.push(last.ms);
    }
    result[url] = {
      status: last.status,
      p95Ms: percentile(samples, 0.95),
      maxMs: Math.max(...samples),
      bytes: last.bytes,
    };
  }
  return result;
};
out.booksFilters = await measure([
  "/api/books?limit=60&read=unread",
  "/api/books?limit=60&read=reading",
  "/api/books?limit=60&read=finished",
  "/api/books?limit=60&index=ready",
  "/api/books?limit=60&index=pending",
  "/api/books?limit=60&index=error",
  "/api/books?limit=60&source=src",
  "/api/books?limit=60&source=src,src2,upload",
  "/api/books?limit=60&notes=1",
  "/api/books?limit=60&sort=lastRead",
  "/api/books?limit=60&sort=author&order=asc",
  "/api/books?limit=60&format=epub&read=reading&source=src",
]);
out.booksFacets = await measure([
  "/api/books/facets",
  "/api/books/facets?format=pdf&read=reading",
  "/api/books/facets?index=ready&source=src&notes=1",
  "/api/books/facets?q=Refactoring&read=finished",
  "/api/books/facets?tag=tag-0",
], 20);

// ---- reading-first order (ADR-1): first page and a deep keyset page, no temp B-tree
const readingPageMs: number[] = [];
let readingFirst: { status: number; ms: number; bytes: number } | null = null;
let readingCursor: string | null = null;
let readingPages = 0;
const readingSeen = new Set<string>();
do {
  const started = performance.now();
  const response = await app.inject({
    method: "GET",
    url: `/api/books?limit=200&sort=reading${readingCursor ? `&cursor=${encodeURIComponent(readingCursor)}` : ""}`,
    headers: auth,
  });
  const elapsed = ms(started);
  const body = response.json() as { items: { id: string }[]; nextCursor: string | null };
  body.items.forEach((item) => readingSeen.add(item.id));
  if (readingFirst === null) readingFirst = { status: response.statusCode, ms: elapsed, bytes: response.rawPayload.length };
  else readingPageMs.push(elapsed);
  readingCursor = body.nextCursor;
  readingPages += 1;
  if (readingPages > 100) break;
} while (readingCursor);
out.booksReading = {
  first: readingFirst,
  deepPages: readingPageMs.length,
  deepP95Ms: readingPageMs.length === 0 ? null : percentile(readingPageMs, 0.95),
  pages: readingPages,
  unique: readingSeen.size,
};
out.booksReading60 = await measure(["/api/books?limit=60&sort=reading"], 20);

// ---- tags: filter p95, bulk by filter over the whole library and deletion with chunks
out.booksTagFilters = await measure([
  "/api/books?limit=60&tag=tag-0",
  "/api/books?limit=60&tag=tag-rare",
  "/api/books?limit=60&tag=tag-0,tag-rare",
  "/api/books?limit=60&sort=reading&tag=tag-0",
  "/api/books?limit=60&sort=reading&tag=tag-rare",
  "/api/books?limit=60&tag=tag-rare&format=pdf",
], 20);
{
  const created = await app.inject({
    method: "POST", url: "/api/tags", headers: auth, payload: { name: "Bench bulk", color: "blue" },
  });
  const tagId = (created.json() as { id: string }).id;
  const started = performance.now();
  const bulk = await app.inject({
    method: "PATCH", url: "/api/books/tags", headers: auth,
    payload: { selection: { filter: {}, expectedTotal: N }, add: [tagId] },
  });
  out.booksTagsBulk = { status: bulk.statusCode, ms: ms(started), added: (bulk.json() as { added: number }).added, books: N };
}
{
  const ids = (db.prepare(`SELECT books.id FROM books WHERE books.source_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.book_id = books.id)
    ORDER BY books.id LIMIT 100`).all() as { id: string }[]).map((row) => row.id);
  const insertChunk = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES (?,?,?,NULL,NULL)");
  db.transaction(() => {
    for (const id of ids) for (let ordinal = 0; ordinal < 50; ordinal += 1) {
      insertChunk.run(id, ordinal, `chunk ${ordinal} of ${id} `.repeat(20));
    }
  })();
  const started = performance.now();
  const removal = await app.inject({
    method: "POST", url: "/api/books/delete", headers: auth, payload: { selection: { ids }, confirmNotes: true },
  });
  const body = removal.json() as { removed: number; fileErrors: number; remaining: number };
  out.booksDelete100 = {
    status: removal.statusCode,
    ms: ms(started),
    removed: body.removed,
    fileErrors: body.fileErrors,
    remaining: body.remaining,
    chunksBefore: ids.length * 50,
  };
}

// ---- compression (rawPayload is the network size on the wire)
out.booksListGzip = await get("/api/books", { "accept-encoding": "gzip" });
out.booksPageGzip = await get("/api/books?limit=60", { "accept-encoding": "gzip" });
out.opdsFirstPage = await get("/opds/books");
out.opdsFirstPageGzip = await get("/opds/books", { "accept-encoding": "gzip" });
out.indexStatus = await get("/api/index/status");
out.coverRequest = await get(`/api/books/book-000001/cover`); // 404 here: cover files are not materialized
loop.disable();
out.eventLoopP99Ms = +(loop.percentile(99) / 1e6).toFixed(1);
out.eventLoopMaxMs = +(loop.max / 1e6).toFixed(1);

// ---- the 'revision' storm: how many full reloads a backfill would trigger
out.dbFileMiB = Math.round((await import("node:fs")).statSync(join(dir, "knowlify.db")).size / 2 ** 20);

// Other tracks extend this harness (RAG/scan sections below; the paged list is covered by the HTTP validation).
// ---- RAG ingestion (R0/R1/R2): throughput per mode, DB size per book ----
if (process.env.RAG === "1") {
  const ragBooks = Number(process.env.RAG_BOOKS ?? 24);
  const ragParagraphs = Number(process.env.RAG_PARAGRAPHS ?? 120);
  const ragWorkers = Number(process.env.RAG_WORKERS ?? 1);
  const ragFormat = process.env.RAG_FORMAT === "pdf" ? "pdf" : "epub";
  const pdfLines = Number(process.env.RAG_PDF_LINES ?? 24);
  const pdfLineChars = Number(process.env.RAG_PDF_LINE_CHARS ?? 100);
  // Illustrated/scanned books have many pages but text on only some of them.
  const pdfTextEvery = Math.max(1, Number(process.env.RAG_PDF_TEXT_EVERY ?? 1));
  const ragChapters = Math.max(1, Number(process.env.RAG_CHAPTERS ?? 1));
  const ragModes = (process.env.RAG_MODES ?? "none,http").split(",").map((mode) => mode.trim()).filter(Boolean);
  const { mkdtempSync: mkRagDir, writeFileSync, statSync } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const { tmpdir: osTmp } = await import("node:os");
  const AdmZip = (await import("adm-zip")).default;
  const { openDb: openRagDb } = await import("../../apps/server/src/adapters/storage/db.js");
  const { SqliteBookRepository: RagBookRepository } = await import("../../apps/server/src/adapters/storage/repositories.js");
  const { SqliteBookIndexRepository: RagIndexRepository, SqlitePassageRepository: RagPassageRepository } = await import(
    "../../apps/server/src/adapters/storage/SqliteKnowledgeRepositories.js"
  );
  const { ThreadIngestionRunner } = await import("../../apps/server/src/adapters/indexing/ThreadIngestionRunner.js");
  const { Indexing } = await import("../../apps/server/src/use-cases/Indexing.js");

  const ragDir = mkRagDir(joinPath(osTmp(), "knowlify-rag-bench-"));
  const booksDir = joinPath(ragDir, "books");
  await (await import("node:fs/promises")).mkdir(booksDir, { recursive: true });
  const paragraph = "The quick brown fox jumps over the lazy dog. "
    + "Knowledge systems retrieve passages and cite their source. ".repeat(12);
  const bookIds: string[] = [];
  const paths: string[] = [];
  if (ragFormat === "pdf") {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    for (let index = 0; index < ragBooks; index += 1) {
      const id = `rag-${String(index).padStart(4, "0")}`;
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (let pageIndex = 0; pageIndex < ragParagraphs; pageIndex += 1) {
        const page = pdf.addPage([595, 842]);
        if (pageIndex % pdfTextEvery !== 0) continue;
        for (let line = 0; line < pdfLines; line += 1) {
          page.drawText(`${index}.${pageIndex}.${line} ${paragraph.slice(0, pdfLineChars)}`, {
            x: 36, y: 810 - line * 30, size: 9, font,
          });
        }
      }
      const path = joinPath(booksDir, `${id}.pdf`);
      writeFileSync(path, await pdf.save());
      paths.push(path);
      bookIds.push(id);
    }
  } else {
    for (let index = 0; index < ragBooks; index += 1) {
      const id = `rag-${String(index).padStart(4, "0")}`;
      const zip = new AdmZip();
      zip.addFile("mimetype", Buffer.from("application/epub+zip"));
      zip.addFile("META-INF/container.xml", Buffer.from(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ));
      const manifest = Array.from({ length: ragChapters }, (_, chapter) =>
        `<item id="c${chapter}" href="c${chapter}.xhtml" media-type="application/xhtml+xml"/>`).join("");
      const spine = Array.from({ length: ragChapters }, (_, chapter) => `<itemref idref="c${chapter}"/>`).join("");
      zip.addFile("OEBPS/content.opf", Buffer.from(
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
          + `<dc:title>RAG ${index}</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`,
      ));
      const perChapter = Math.ceil(ragParagraphs / ragChapters);
      for (let chapter = 0; chapter < ragChapters; chapter += 1) {
        let body = "";
        for (let p = 0; p < perChapter; p += 1) body += `<p>${paragraph} ${chapter}-${p}</p>`;
        zip.addFile(`OEBPS/c${chapter}.xhtml`, Buffer.from(`<html><body>${body}</body></html>`));
      }
      const path = joinPath(booksDir, `${id}.epub`);
      writeFileSync(path, zip.toBuffer());
      paths.push(path);
      bookIds.push(id);
    }
  }

  async function serveBenchEmbeddings(): Promise<{ url: string; close: () => Promise<void> }> {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: payload.input.map((_, index) => ({ embedding: [1, 0, 0, 0], index })),
        }));
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    };
  }

  const warmupPath = joinPath(booksDir, `warmup.${ragFormat}`);
  if (ragFormat === "pdf") {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([300, 300]);
    page.drawText("Warm up the ingestion workers.", { x: 20, y: 250, size: 10, font });
    writeFileSync(warmupPath, await pdf.save());
  } else {
    const zip = new AdmZip();
    zip.addFile("META-INF/container.xml", Buffer.from(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ));
    zip.addFile("OEBPS/content.opf", Buffer.from(
      '<package><metadata><title>Warmup</title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>'
        + '</manifest><spine><itemref idref="c"/></spine></package>',
    ));
    zip.addFile("OEBPS/c.xhtml", Buffer.from("<html><body><p>Warm up the ingestion workers.</p></body></html>"));
    writeFileSync(warmupPath, zip.toBuffer());
  }

  type BenchEmbedder = { kind: "none" } | { kind: "http"; url: string; model: string };

  async function measure(mode: string, workers: number, embedder: BenchEmbedder) {
    const dataDir = joinPath(ragDir, `run-${mode}-${workers}`);
    await (await import("node:fs/promises")).mkdir(dataDir, { recursive: true });
    const ragDb = openRagDb(joinPath(dataDir, "knowlify.db"));
    const books = new RagBookRepository(ragDb);
    const indexes = new RagIndexRepository(ragDb);
    const passages = new RagPassageRepository(ragDb);
    const now = Date.now();
    for (let index = 0; index < ragBooks; index += 1) {
      const id = bookIds[index]!;
      const size = statSync(paths[index]!).size;
      books.save({
        id, title: `RAG ${index}`, author: "", format: ragFormat, path: paths[index]!, cover_path: null,
        size, added_at: now, source_id: null, mtime: now, status: "ready",
      });
    }
    const runner = new ThreadIngestionRunner({ embedder, ...(workers > 1 ? { workers } : {}) });
    if (process.env.RAG_WARMUP !== "0") {
      // Steady-state throughput: load pdf.js and start every pool worker before the timer.
      await Promise.all(Array.from({ length: Math.min(workers, 4) }, () =>
        runner.run(
          { bookId: "warmup", path: warmupPath, format: ragFormat, knownHash: null, indexVersion: "1|lexical", vectors: false },
          { onStart: () => {}, onBatch: async () => {}, onProgress: () => {} },
        )));
    }
    const indexing = new Indexing(indexes, passages, books, runner, { now: () => Date.now() }, {
      enabled: true, maxBytes: 200 * 1024 * 1024, concurrency: workers, backfill: "on",
      workers, vectorsMaxBooks: 1_000_000,
    }, { info: () => {}, error: () => {} });
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const started = performance.now();
    indexing.start();
    try {
      for (;;) {
        const counts = indexes.counts();
        if (counts.pending === 0 && counts.indexing === 0) break;
        if (performance.now() - started > 15 * 60_000) throw new Error(`rag bench ${mode} timed out`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      indexing.stop();
      await runner.close();
    }
    const elapsedMs = ms(started);
    loop.disable();
    const chunks = (ragDb.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const vectors = (ragDb.prepare("SELECT COUNT(*) AS n FROM chunk_vectors").get() as { n: number }).n;
    ragDb.pragma("wal_checkpoint(TRUNCATE)");
    const dbBytes = (await import("node:fs")).statSync(joinPath(dataDir, "knowlify.db")).size;
    const result = {
      mode,
      workers,
      format: ragFormat,
      books: ragBooks,
      chunks,
      vectors,
      elapsedMs,
      seconds: +(elapsedMs / 1000).toFixed(2),
      passagesPerSecond: +(chunks / (elapsedMs / 1000)).toFixed(1),
      booksPerSecond: +(ragBooks / (elapsedMs / 1000)).toFixed(2),
      dbMiB: +(dbBytes / 2 ** 20).toFixed(1),
      dbKiBPerBook: +(dbBytes / 1024 / ragBooks).toFixed(1),
      eventLoopP99Ms: +(loop.percentile(99) / 1e6).toFixed(1),
    };
    ragDb.close();
    return result;
  }

  const results: unknown[] = [];
  const provider = ragModes.includes("http") ? await serveBenchEmbeddings() : null;
  try {
    for (const mode of ragModes) {
      if (mode === "none") {
        results.push(await measure("none", ragWorkers, { kind: "none" }));
      } else if (mode === "http" && provider) {
        results.push(await measure("http", ragWorkers, { kind: "http", url: provider.url, model: "bench" }));
      } else if (mode === "local") {
        results.push({ mode: "local", skipped: "requires the optional model and a warm model directory" });
      }
    }
  } finally {
    await provider?.close();
  }
  out.rag = {
    format: ragFormat,
    books: ragBooks,
    ...(ragFormat === "pdf"
      ? { pagesPerBook: ragParagraphs, pdfLines, pdfLineChars, pdfTextEvery }
      : { paragraphsPerBook: ragParagraphs, chaptersPerBook: ragChapters }),
    workers: ragWorkers,
    results,
  };
  if (!process.env.KEEP) rmSync(ragDir, { recursive: true, force: true });
}

// ---- R1: boot-time reconcile over a large unindexed library (default 11k) ----
if (process.env.RAG_RECONCILE === "1") {
  const count = Number(process.env.RAG_RECONCILE_BOOKS ?? 11000);
  const { mkdtempSync: mkRecDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const { tmpdir: osTmp } = await import("node:os");
  const { openDb: openRecDb } = await import("../../apps/server/src/adapters/storage/db.js");
  const { SqliteBookRepository: RecBookRepository } = await import("../../apps/server/src/adapters/storage/repositories.js");
  const { SqliteBookIndexRepository: RecIndexRepository } = await import(
    "../../apps/server/src/adapters/storage/SqliteKnowledgeRepositories.js"
  );
  const { SqlitePassageRepository: RecPassageRepository } = await import(
    "../../apps/server/src/adapters/storage/SqliteKnowledgeRepositories.js"
  );
  const { Indexing } = await import("../../apps/server/src/use-cases/Indexing.js");
  const recDir = mkRecDir(joinPath(osTmp(), "knowlify-reconcile-bench-"));
  const recDb = openRecDb(joinPath(recDir, "knowlify.db"));
  const recBooks = new RecBookRepository(recDb);
  const now = Date.now();
  recDb.transaction(() => {
    const insert = recDb.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'ready')`);
    for (let index = 0; index < count; index += 1) {
      insert.run(`rec-${index}`, `Book ${index}`, "", "epub", `/lib/${index}.epub`, null, 1000, now - index, "src", now);
    }
  })();
  const runner = {
    run: async () => { throw new Error("not used"); },
    embedQuery: async () => null,
    embeddings: () => ({ mode: "none" as const, model: null, state: "off" as const }),
    indexVersion: () => "1|none",
    onEmbeddingsReady: () => {},
    close: async () => {},
  };
  const indexing = new Indexing(
    new RecIndexRepository(recDb),
    new RecPassageRepository(recDb),
    recBooks,
    runner,
    { now: () => Date.now() },
    { enabled: true, maxBytes: 200 * 1024 * 1024, concurrency: 1, backfill: "auto" },
  );
  if (process.env.RAG_RECONCILE_ASYNC === "1") {
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const started = performance.now();
    indexing.start();
    while (performance.now() - started < 30_000) {
      const counts = indexing.status().counts;
      if (counts.pending + counts.indexing >= count) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    loop.disable();
    out.reconcile = {
      books: count,
      queued: indexing.status().counts.pending + indexing.status().counts.indexing,
      ms: ms(started),
      eventLoopP99Ms: +(loop.percentile(99) / 1e6).toFixed(1),
      eventLoopMaxMs: +(loop.max / 1e6).toFixed(1),
      mode: "start",
    };
  } else {
    const started = performance.now();
    const queued = indexing.reconcile();
    out.reconcile = { books: count, queued, ms: ms(started), mode: "reconcile" };
  }
  indexing.stop();
  recDb.close();
  if (!process.env.KEEP) rmSync(recDir, { recursive: true, force: true });
}

await app.close();

if (SCAN) {
  const [
    { default: AdmZip },
    { PDFDocument },
    { Scanner },
    { SqliteBookRepository },
    { SqliteSourceRepository },
    { DiskFileStore },
    { createMetadataExtractors },
    { extractEpub },
  ] = await Promise.all([
    import("adm-zip"),
    import("pdf-lib"),
    import("../../apps/server/src/use-cases/Scanner.js"),
    import("../../apps/server/src/adapters/storage/SqliteBookRepository.js"),
    import("../../apps/server/src/adapters/storage/SqliteSourceRepository.js"),
    import("../../apps/server/src/adapters/files/FileStore.js"),
    import("../../apps/server/src/adapters/files/strategies.js"),
    import("../../apps/server/src/adapters/files/metadata.js"),
  ]);

  /** Pre-change PDF path: pdf-lib loads the file and pdf.js parses it again for the cover. */
  const extractPdfBaseline = async (path: string): Promise<{ title?: string; author?: string; cover?: unknown }> => {
    const bytes = await readFile(path);
    const out: { title?: string; author?: string; cover?: unknown } = {};
    try {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
      out.title = doc.getTitle()?.trim() || undefined;
      out.author = doc.getAuthor()?.trim() || undefined;
    } catch {
      /* baseline kept going without metadata */
    }
    try {
      const [{ getDocument }, { createCanvas }] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("@napi-rs/canvas"),
      ]);
      const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 480 / base.width });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
        out.cover = canvas.toBuffer("image/jpeg", 80);
      } finally {
        await doc.destroy();
      }
    } catch {
      /* baseline cover was best effort too */
    }
    return out;
  };

  const library = join(dir, "scan-library");
  mkdirSync(library, { recursive: true });
  const folders = 22;
  for (let index = 0; index < folders; index += 1) mkdirSync(join(library, `dir${String(index).padStart(2, "0")}`), { recursive: true });

  const fixtureStart = performance.now();
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from('<package><metadata><title>Bench title</title><creator>Bench author</creator></metadata><manifest/></package>'));
  const epub = zip.toBuffer();
  const epubPaths: string[] = [];
  for (let index = 0; index < SCAN_N - SCAN_PDF; index += 1) {
    epubPaths.push(join(library, `dir${String(index % folders).padStart(2, "0")}`, `book-${String(index).padStart(6, "0")}.epub`));
  }
  const pdfPaths: string[] = [];
  for (let index = 0; index < SCAN_PDF; index += 1) {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    pdf.setTitle(`Bench PDF ${index}`);
    pdf.setAuthor("Bench author");
    pdfPaths.push(join(library, `dir${String(index % folders).padStart(2, "0")}`, `pdf-${String(index).padStart(4, "0")}.pdf`));
    await writeFile(pdfPaths.at(-1)!, await pdf.save());
  }
  let next = 0;
  await Promise.all(Array.from({ length: 64 }, async () => {
    while (next < epubPaths.length) {
      const path = epubPaths[next++]!;
      await writeFile(path, epub);
    }
  }));
  const fixtureMs = ms(fixtureStart);

  // Baseline: the pre-change serial walk (one stat + one byPath + one autocommit save per file).
  const baselineDb = openDb(join(dir, "baseline.db"));
  const baselineBooks = new SqliteBookRepository(baselineDb);
  const baselineFiles = new DiskFileStore(join(dir, "baseline-books"), join(dir, "baseline-covers"));
  const baselinePaths = epubPaths.slice(0, Math.min(BASELINE_N, epubPaths.length));
  let baselineStart = performance.now();
  for (let index = 0; index < baselinePaths.length; index += 1) {
    const path = baselinePaths[index]!;
    const st = await baselineFiles.stat(path);
    const book = baselineBooks.byPath(path);
    if (!book) baselineBooks.save({ id: `baseline-${index}`, title: path, author: "", format: "epub", path,
      cover_path: null, size: st.size, added_at: Date.now(), source_id: null, mtime: st.mtime, status: "ready" });
  }
  const baselineMs = ms(baselineStart);
  baselineDb.close();

  const scanDb = openDb(join(dir, "scan.db"));
  const scanBooks = new SqliteBookRepository(scanDb);
  const scanSources = new SqliteSourceRepository(scanDb);
  const scanFiles = new DiskFileStore(join(dir, "scan-books"), join(dir, "scan-covers"));
  const clock = { now: () => Date.now() };
  const ids = { next: () => crypto.randomUUID() };
  const fakeMetadata = { epub: { extract: async () => ({}) }, pdf: { extract: async () => ({}) } };
  const quiet = { info: () => {}, error: () => {} };
  const scanner = new Scanner(scanBooks, scanSources, scanFiles, clock, ids, fakeMetadata, quiet, undefined, [], {
    scanConcurrency: SCAN_CONCURRENCY,
    metadataWorkers: METADATA_WORKERS,
  });
  // Discovery only: pending extraction is measured separately below.
  Object.assign(scanner, { processPending: async () => {} });
  scanSources.save({ id: "src", path: library });

  const scanLoop = monitorEventLoopDelay({ resolution: 5 });
  scanLoop.enable();
  baselineStart = performance.now();
  await scanner.scan();
  const optimizedScanMs = ms(baselineStart);
  scanLoop.disable();

  const metaFixtureStart = performance.now();
  const metaLibrary = join(dir, "meta-library");
  mkdirSync(metaLibrary, { recursive: true });
  const realistic = new AdmZip();
  realistic.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  realistic.addFile("book.opf", Buffer.from('<package><metadata><title>Metadata title</title><creator>Metadata author</creator></metadata><manifest/></package>'));
  for (let chapter = 0; chapter < META_CHAPTERS; chapter += 1) {
    realistic.addFile(`text/ch${chapter}.xhtml`, Buffer.alloc(META_CHAPTER_KB * 1024, 97));
  }
  const realisticEpub = realistic.toBuffer();
  const metaEpubPaths = Array.from({ length: META_EPUB }, (_, index) => join(metaLibrary, `book-${index}.epub`));
  if (metaEpubPaths[0]) {
    await writeFile(metaEpubPaths[0], realisticEpub);
    for (let index = 1; index < metaEpubPaths.length; index += 1) {
      // Hard links keep the fixture physically small: the repetitive filler
      // compresses to ~18 KB, so the sample stresses AdmZip's central-directory
      // parse and the pool's IPC, not disk bandwidth (real books are bigger and
      // add the same I/O cost to both the serial and the pooled run).
      try {
        linkSync(metaEpubPaths[0], metaEpubPaths[index]!);
      } catch {
        await writeFile(metaEpubPaths[index]!, realisticEpub);
      }
    }
  }
  const metaPdfPaths = Array.from({ length: META_PDF }, (_, index) => join(metaLibrary, `pdf-${index}.pdf`));
  for (let index = 0; index < metaPdfPaths.length; index += 1) {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 300]);
    pdf.setTitle(`Metadata PDF ${index}`);
    pdf.setAuthor("Metadata author");
    await writeFile(metaPdfPaths[index]!, await pdf.save());
  }
  const metaFixtureMs = ms(metaFixtureStart);

  let serialStart = performance.now();
  for (const path of metaEpubPaths) await extractEpub(path);
  const serialEpubMs = ms(serialStart);
  // One-off module loading (pdf-lib + pdf.js + canvas, ~750 ms) is not throughput.
  // Warm the reference path so both sides of the comparison measure steady state.
  if (metaPdfPaths[0]) await extractPdfBaseline(metaPdfPaths[0]);
  serialStart = performance.now();
  for (const path of metaPdfPaths) await extractPdfBaseline(path);
  const serialPdfMs = ms(serialStart);

  const metadata = createMetadataExtractors(METADATA_WORKERS, { log: () => {} });
  if (metaEpubPaths[0]) {
    await Promise.all(Array.from({ length: Math.min(METADATA_WORKERS, metaEpubPaths.length) }, (_, index) => metadata.epub.extract(metaEpubPaths[index]!)));
  }
  let poolStart = performance.now();
  await Promise.all(metaEpubPaths.map((path) => metadata.epub.extract(path)));
  const poolEpubMs = ms(poolStart);
  // Same for the pool: pdf.js/canvas load lazily in each worker on its first PDF.
  if (metaPdfPaths[0]) {
    await Promise.all(Array.from({ length: Math.min(METADATA_WORKERS, metaPdfPaths.length) }, (_, index) => metadata.pdf.extract(metaPdfPaths[index]!)));
  }
  poolStart = performance.now();
  await Promise.all(metaPdfPaths.map((path) => metadata.pdf.extract(path)));
  const poolPdfMs = ms(poolStart);

  const pendingScanner = new Scanner(scanBooks, scanSources, scanFiles, clock, ids, metadata, quiet, undefined, [], {
    metadataWorkers: METADATA_WORKERS,
    pendingReadBatch: Math.max(50, METADATA_WORKERS * 20),
  });
  const pendingLoop = monitorEventLoopDelay({ resolution: 5 });
  pendingLoop.enable();
  const pendingStart = performance.now();
  await pendingScanner.processPending();
  const pendingMs = ms(pendingStart);
  pendingLoop.disable();
  const pendingLeft = scanBooks.pendingCount();
  await metadata.close();
  scanDb.close();

  const perSecond = (count: number, elapsedMs: number) => +(count / (elapsedMs / 1000)).toFixed(1);
  out.scanLibrary = {
    files: SCAN_N,
    fixtureMs,
    baseline: {
      sample: baselinePaths.length,
      ms: baselineMs,
      extrapolatedTo11kMs: baselinePaths.length === 0 ? null : Math.round((baselineMs / baselinePaths.length) * SCAN_N),
    },
    optimized: {
      ms: optimizedScanMs,
      filesPerSecond: perSecond(SCAN_N, optimizedScanMs),
      records: SCAN_N,
      eventLoopP99Ms: +(scanLoop.percentile(99) / 1e6).toFixed(1),
      eventLoopMaxMs: +(scanLoop.max / 1e6).toFixed(1),
    },
    metadata: {
      workers: METADATA_WORKERS,
      steadyState: true,
      epubFixtureBytes: realisticEpub.length,
      fixtureMs: metaFixtureMs,
      serial: {
        epub: { files: metaEpubPaths.length, ms: serialEpubMs, perSecond: perSecond(metaEpubPaths.length, serialEpubMs) },
        pdf: { files: metaPdfPaths.length, ms: serialPdfMs, perSecond: perSecond(metaPdfPaths.length, serialPdfMs) },
      },
      pool: {
        epub: { files: metaEpubPaths.length, ms: poolEpubMs, perSecond: perSecond(metaEpubPaths.length, poolEpubMs), speedup: +(serialEpubMs / poolEpubMs).toFixed(2) },
        pdf: { files: metaPdfPaths.length, ms: poolPdfMs, perSecond: perSecond(metaPdfPaths.length, poolPdfMs), speedup: +(serialPdfMs / poolPdfMs).toFixed(2) },
      },
      overallSpeedup: +((serialEpubMs + serialPdfMs) / (poolEpubMs + poolPdfMs)).toFixed(2),
      fullPending: {
        books: SCAN_N,
        ms: pendingMs,
        booksPerSecond: perSecond(SCAN_N, pendingMs),
        eventLoopP99Ms: +(pendingLoop.percentile(99) / 1e6).toFixed(1),
        eventLoopMaxMs: +(pendingLoop.max / 1e6).toFixed(1),
        pendingLeft,
      },
    },
  };
}
if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
