import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import type { IngestionRunner, EmbeddingsStatus, IngestJob, IngestOutcome, IngestSink } from "../src/ports/knowledge.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-knowledge-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let epub: Buffer;
beforeAll(() => {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from('<package><metadata><title>Upload fixture</title><creator>Author</creator></metadata></package>'));
  epub = zip.toBuffer();
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

class ContractRunner implements IngestionRunner {
  status: EmbeddingsStatus = { mode: "local", model: "multilingual-e5-small", state: "ready" };
  version = "1|local:multilingual-e5-small";
  runs: IngestJob[] = [];
  gate: Promise<void> | null = null;
  handler: (job: IngestJob, sink: IngestSink) => Promise<IngestOutcome> = async (job, sink) => {
    if (this.gate) await this.gate;
    sink.onStart(`hash-${job.bookId}`);
    await sink.onBatch({ passages: [{ ordinal: 0, text: `indexed ${job.bookId}`, page: 1, section: null }], vectors: null });
    return { kind: "done", contentHash: `hash-${job.bookId}`, chunkCount: 1, indexVersion: job.indexVersion };
  };
  async run(job: IngestJob, sink: IngestSink): Promise<IngestOutcome> {
    this.runs.push(job);
    return this.handler(job, sink);
  }
  async embedQuery(): Promise<Float32Array | null> { return new Float32Array([1, 0]); }
  embeddings(): EmbeddingsStatus { return this.status; }
  indexVersion(): string { return this.version; }
  onEmbeddingsReady(): void {}
  async close(): Promise<void> {}
}

const apps: { app: FastifyInstance; db: Db }[] = [];
async function makeApp(runner?: IngestionRunner) {
  const db = openDb(":memory:");
  const { app, indexing } = await buildApp(db, false, undefined, runner);
  await app.ready();
  apps.push({ app, db });
  return { app, db, indexing };
}
afterEach(async () => {
  for (const { app, db } of apps.splice(0)) { await app.close(); db.close(); }
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const request = (app: FastifyInstance, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });

const book = (id: string, status: Book["status"] = "ready"): Book => ({
  id, title: `Title ${id}`, author: "Author", format: "epub", path: join(root, `${id}.epub`),
  cover_path: null, size: 10, added_at: 1, source_id: null, mtime: 1, status,
});
const readyRow = (bookId: string) => ({
  bookId, state: "ready" as const, priority: 0 as const, contentHash: "hash", indexVersion: "1|none", fingerprint: null,
  chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
});

describe("Knowledge HTTP contract", () => {
  it("reports status without secrets and with the frozen shape", async () => {
    const runner = new ContractRunner();
    const { app } = await makeApp(runner);
    const response = await request(app, "GET", "/api/index/status");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual([
      "counts", "current", "enabled", "etaSec", "paused", "rate", "retrieval", "revision", "search", "vectors", "workers",
    ]);
    expect(Object.keys(body.search).sort()).toEqual(["embeddings", "model", "semantic", "state"]);
    expect(Object.keys(body.vectors).sort()).toEqual(["maxBooks", "mode"]);
    expect(body).toMatchObject({
      enabled: true,
      search: { semantic: true, embeddings: "local", model: "multilingual-e5-small", state: "ready" },
      counts: { pending: 0, indexing: 0, ready: 0, error: 0 },
      current: null,
      paused: false,
      rate: null,
      etaSec: null,
      workers: expect.any(Number),
      vectors: { mode: "auto", maxBooks: 1000 },
      retrieval: {
        memory: { limitMB: expect.any(Number), budgetMB: expect.any(Number) },
        warmup: { mode: "auto", state: "off", reason: "disabled", warmedMB: 0, targetMB: 0 },
        cache: { enabled: false, entries: 0, maxEntries: 0, usedKB: 0, maxKB: 0, hits: 0, misses: 0 },
      },
    });
    expect(Object.keys(body.retrieval).sort()).toEqual(["cache", "memory", "warmup"]);
    expect(Object.keys(body.retrieval.warmup).sort()).toEqual(["mode", "state", "reason", "targetMB", "warmedMB"].sort());
    expect(response.body).not.toMatch(/api[_-]?key|secret|https?:\/\/|knowlify\.db/i);
    expect(typeof body.revision).toBe("number");
    expect(response.body).not.toMatch(/api[_-]?key|secret|https?:\/\//i);
    expect((await app.inject({ method: "GET", url: "/api/index/status" })).statusCode).toBe(401);
  });

  it("adds the index field to book DTOs with all states", async () => {
    const runner = new ContractRunner();
    const { app, db } = await makeApp(runner);
    const books = new SqliteBookRepository(db);
    const indexes = new SqliteBookIndexRepository(db);
    books.save(book("ready")); books.save(book("unindexed")); books.save(book("broken", "error")); books.save(book("failed"));
    indexes.save(readyRow("ready"));
    indexes.save({ ...readyRow("failed"), state: "error", error: { code: "no_text", message: "no extractable text" } });
    const rows = (await request(app, "GET", "/api/books")).json() as { id: string; index: unknown }[];
    const byId = new Map(rows.map((row) => [row.id, row.index]));
    expect(byId.get("ready")).toEqual({ state: "ready", error: null });
    expect(byId.get("unindexed")).toEqual({ state: "pending", error: null });
    expect(byId.get("broken")).toEqual({ state: "none", error: null });
    expect((await request(app, "GET", "/api/books/failed")).json().index)
      .toEqual({ state: "error", error: { code: "no_text", message: "no extractable text" } });
  });

  it("queues a single book and validates missing, unready and already queued books", async () => {
    const { app, db } = await makeApp(new ContractRunner());
    const books = new SqliteBookRepository(db);
    books.save(book("book")); books.save(book("pending", "pending"));
    expect((await request(app, "POST", "/api/books/missing/index")).statusCode).toBe(404);
    expect((await request(app, "POST", "/api/books/pending/index")).statusCode).toBe(409);
    const queued = await request(app, "POST", "/api/books/book/index");
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ state: "pending" });
    expect((await request(app, "POST", "/api/books/book/index")).json()).toEqual({ state: "pending" });
  });

  it("queues failed or all books and rejects invalid scopes", async () => {
    const { app, db } = await makeApp(new ContractRunner());
    const books = new SqliteBookRepository(db);
    const indexes = new SqliteBookIndexRepository(db);
    books.save(book("ready")); books.save(book("unindexed"));
    indexes.save(readyRow("ready"));
    expect((await request(app, "POST", "/api/index/reindex", { scope: "failed" })).json()).toEqual({ queued: 0 });
    expect((await request(app, "POST", "/api/index/reindex", { scope: "all" })).json()).toEqual({ queued: 2 });
    const invalid = await request(app, "POST", "/api/index/reindex", { scope: "everything" });
    expect(invalid.statusCode).toBe(400);
    expect(typeof invalid.json().message).toBe("string");
    expect((await request(app, "POST", "/api/index/reindex", {})).statusCode).toBe(400);
  });

  it("searches passages with limits, book filter and safe defaults", async () => {
    const runner = new ContractRunner();
    runner.status = { mode: "none", model: null, state: "off" };
    const { app, db } = await makeApp(runner);
    const books = new SqliteBookRepository(db);
    const indexes = new SqliteBookIndexRepository(db);
    const passages = new SqlitePassageRepository(db);
    books.save(book("one")); books.save(book("two"));
    indexes.save({ ...readyRow("one"), indexVersion: "1|none" });
    passages.append("one", [{ passage: { ordinal: 0, text: "a needle in the haystack", page: 42, section: null }, vector: null }]);
    passages.append("two", [{ passage: { ordinal: 0, text: "another needle", page: null, section: "Chapter 2" }, vector: null }]);

    const found = await request(app, "GET", "/api/passages/search?q=needle");
    expect(found.statusCode).toBe(200);
    const body = found.json();
    expect(body).toMatchObject({ mode: "lexical", coverage: { indexed: 1, total: 2 } });
    // The availability flag is internal to the tutor prompt; the API envelope is unchanged.
    expect(body).not.toHaveProperty("unavailable");
    expect(body.hits).toHaveLength(2);
    expect(body.hits.find((hit: { bookId: string }) => hit.bookId === "one")).toMatchObject({
      bookId: "one", bookTitle: "Title one", text: "a needle in the haystack", location: { page: 42, section: null },
    });
    expect(body.hits.find((hit: { bookId: string }) => hit.bookId === "two")).toMatchObject({
      bookId: "two", bookTitle: "Title two", text: "another needle", location: { page: null, section: "Chapter 2" },
    });
    expect(body.hits[0].score).toBe(1);
    const filtered = await request(app, "GET", "/api/passages/search?q=needle&bookId=two&limit=1");
    expect(filtered.json().hits).toHaveLength(1);
    expect(filtered.json().hits[0].bookId).toBe("two");
    for (const url of [
      "/api/passages/search?q=a",
      "/api/passages/search",
      "/api/passages/search?q=needle&limit=0",
      "/api/passages/search?q=needle&limit=21",
    ]) {
      expect((await request(app, "GET", url)).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/passages/search?q=needle" })).statusCode).toBe(401);
  });

  it("pauses and resumes idempotently, persisting the pause through a rebuild", async () => {
    const db = openDb(":memory:");
    try {
      const first = await buildApp(db, false, undefined, new ContractRunner());
      await first.app.ready();
      const pause = await request(first.app, "POST", "/api/index/pause");
      expect(pause.statusCode).toBe(200);
      expect(pause.json()).toEqual({ paused: true });
      expect((await request(first.app, "POST", "/api/index/pause")).json()).toEqual({ paused: true });
      expect((await request(first.app, "GET", "/api/index/status")).json().paused).toBe(true);
      await first.app.close();

      const rebuilt = await buildApp(db, false, undefined, new ContractRunner());
      await rebuilt.app.ready();
      expect((await request(rebuilt.app, "GET", "/api/index/status")).json().paused).toBe(true);
      expect((await request(rebuilt.app, "POST", "/api/index/resume")).json()).toEqual({ paused: false });
      expect((await request(rebuilt.app, "GET", "/api/index/status")).json().paused).toBe(false);
      await rebuilt.app.close();
    } finally {
      db.close();
    }
  });

  it("enqueues selections at priority 1 and counts unknown books as skipped", async () => {
    const { app, db } = await makeApp(new ContractRunner());
    const books = new SqliteBookRepository(db);
    const indexes = new SqliteBookIndexRepository(db);
    books.save(book("one")); books.save(book("two")); books.save(book("pending", "pending"));
    const queued = await request(app, "POST", "/api/index/enqueue", { bookIds: ["one", "two", "missing", "pending"] });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ queued: 2, skipped: 2 });
    expect(indexes.get("one")).toMatchObject({ state: "pending", priority: 1 });
    expect(indexes.get("two")).toMatchObject({ state: "pending", priority: 1 });
    expect((await request(app, "POST", "/api/index/enqueue", { bookIds: [] })).statusCode).toBe(400);
    expect((await request(app, "POST", "/api/index/enqueue", { bookIds: ["one"], vectors: "yes" })).statusCode).toBe(400);
  });

  it("disables all endpoints when no ingestion runner is wired", async () => {
    const { app, db } = await makeApp();
    const books = new SqliteBookRepository(db);
    books.save(book("book"));
    const status = await request(app, "GET", "/api/index/status");
    expect(status.json()).toMatchObject({ enabled: false, search: { semantic: false, embeddings: "none", state: "off" } });
    expect((await request(app, "GET", "/api/passages/search?q=needle")).statusCode).toBe(503);
    expect((await request(app, "POST", "/api/index/reindex", { scope: "all" })).statusCode).toBe(409);
    expect((await request(app, "POST", "/api/books/book/index")).statusCode).toBe(409);
    expect((await request(app, "POST", "/api/index/pause")).json()).toEqual({ paused: true });
    expect((await request(app, "POST", "/api/index/resume")).json()).toEqual({ paused: false });
    expect((await request(app, "POST", "/api/index/enqueue", { bookIds: ["book"] })).statusCode).toBe(409);
    expect((await request(app, "GET", "/api/books/book")).json().index).toEqual({ state: "none", error: null });
  });

  it("answers the upload before ingestion finishes and reports pending", async () => {
    const runner = new ContractRunner();
    let release!: () => void;
    let released = false;
    runner.gate = new Promise<void>((resolve) => { release = () => { released = true; resolve(); }; });
    const { app, indexing } = await makeApp(runner);
    indexing.start();
    try {
      const boundary = "knowlify-index-upload";
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`),
        epub,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = app.inject({
        method: "POST",
        url: "/api/books",
        headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      const result = await Promise.race([
        upload,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upload waited for ingestion")), 1_000)),
      ]);
      expect(result.statusCode).toBe(201);
      expect(result.json()).toMatchObject({ title: "Upload fixture", index: { state: "pending", error: null } });
      expect(released).toBe(false);
      expect(runner.runs).toHaveLength(1);
      const id = result.json().id as string;
      release();
      for (let i = 0; i < 200; i++) {
        const detail = (await request(app, "GET", `/api/books/${id}`)).json();
        if (detail.index.state === "ready") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect((await request(app, "GET", `/api/books/${id}`)).json().index.state).toBe("ready");
    } finally {
      release();
    }
  });
});
