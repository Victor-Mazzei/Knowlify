import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import { Indexing, IndexingDisabledError, type IndexingOptions } from "../src/use-cases/Indexing.js";
import { ConflictError, NotFoundError } from "../src/domain/errors.js";
import type { Book } from "../src/ports/index.js";
import type {
  EmbeddingsStatus,
  IngestBatch,
  IngestJob,
  IngestOutcome,
  IngestSink,
  IngestionRunner,
} from "../src/ports/knowledge.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); vi.restoreAllMocks(); });

const book = (id: string, overrides: Partial<Book> = {}): Book => ({
  id, title: `Title ${id}`, author: "", format: "pdf", path: `/${id}.pdf`, cover_path: null,
  size: 100, added_at: 1, source_id: null, mtime: 1, status: "ready", ...overrides,
});

class FakeClock {
  time = 1_000;
  now = (): number => this.time;
  advance(ms: number): void { this.time += ms; }
}

class FakeRunner implements IngestionRunner {
  version = "1|lexical";
  embeddingsStatus: EmbeddingsStatus = { mode: "none", model: null, state: "off" };
  runs: IngestJob[] = [];
  embedQueryCalls = 0;
  queryVector: Float32Array | null = null;
  private readyCallbacks: (() => void)[] = [];
  handler: (job: IngestJob, sink: IngestSink) => Promise<IngestOutcome> = async (job, sink) => {
    const hash = job.knownHash ?? `hash-${job.bookId}-${this.runs.length}`;
    sink.onStart(hash);
    await sink.onBatch({ passages: [{ ordinal: 0, text: `text of ${job.bookId}`, page: 1, section: null }], vectors: null });
    sink.onProgress(1);
    return { kind: "done", contentHash: hash, chunkCount: 1, indexVersion: job.indexVersion };
  };

  async run(job: IngestJob, sink: IngestSink): Promise<IngestOutcome> {
    this.runs.push(job);
    return this.handler(job, sink);
  }
  async embedQuery(): Promise<Float32Array | null> {
    this.embedQueryCalls++;
    return this.queryVector;
  }
  embeddings(): EmbeddingsStatus { return this.embeddingsStatus; }
  indexVersion(): string { return this.version; }
  onEmbeddingsReady(callback: () => void): void { this.readyCallbacks.push(callback); }
  async close(): Promise<void> {}
  becomeReady(version = "1|local:model", status: EmbeddingsStatus = { mode: "local", model: "model", state: "ready" }): void {
    this.embeddingsStatus = status;
    this.version = version;
    for (const callback of this.readyCallbacks) callback();
  }
}

function setup(overrides: Partial<IndexingOptions> = {}) {
  const db = openDb(":memory:");
  databases.push(db);
  const books = new SqliteBookRepository(db);
  const bookIndexes = new SqliteBookIndexRepository(db);
  const passages = new SqlitePassageRepository(db);
  const vectors = new SqliteBlobVectorStore(db);
  const clock = new FakeClock();
  const runner = new FakeRunner();
  const log = { info: vi.fn(), error: vi.fn() };
  const indexing = new Indexing(bookIndexes, passages, books, runner, clock, {
    enabled: true, maxBytes: 1_000, concurrency: 1, backfill: "auto", ...overrides,
  }, log);
  return { db, books, bookIndexes, passages, vectors, clock, runner, log, indexing };
}

async function waitFor(check: () => boolean, message = "condition"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

const statusOf = (indexes: SqliteBookIndexRepository, id: string) => indexes.get(id)?.state;

describe("Indexing queue", () => {
  it("does nothing when indexing is off", async () => {
    const x = setup({ enabled: false });
    x.books.save(book("book"));
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.bookIndexes.get("book")).toBeUndefined();
    expect(x.runner.runs).toHaveLength(0);
    expect(() => x.indexing.reindex("book")).toThrow(IndexingDisabledError);
  });

  it("resumes a job left indexing by a previous process", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.bookIndexes.save({
      bookId: "book", state: "indexing", priority: 0, contentHash: null, indexVersion: null, fingerprint: "100:1",
      chunkCount: 0, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 2, finishedAt: null,
    });
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.state === "ready");
    expect(x.runner.runs).toHaveLength(1);
    expect(x.runner.runs[0]!.bookId).toBe("book");
  });

  it("runs uploads (priority 1) before scanner work (priority 0)", async () => {
    const x = setup();
    x.books.save(book("low")); x.books.save(book("high"));
    x.indexing.schedule({ id: "low", size: 100, mtime: 1 }, 0);
    x.indexing.schedule({ id: "high", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.runner.runs.length === 2 && statusOf(x.bookIndexes, "low") === "ready");
    expect(x.runner.runs.map((job) => job.bookId)).toEqual(["high", "low"]);
    expect(x.bookIndexes.counts()).toEqual({ pending: 0, indexing: 0, ready: 2, error: 0 });
  });

  it("skips a ready book with the same fingerprint and version", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");
    expect(x.runner.runs).toHaveLength(1);
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(1);
  });

  it("keeps chunks when a changed fingerprint resolves to the same content hash", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.handler = async (job, sink) => {
      if (job.knownHash) return { kind: "unchanged", contentHash: job.knownHash, indexVersion: job.indexVersion };
      sink.onStart("stable-hash");
      await sink.onBatch({ passages: [{ ordinal: 0, text: "kept text", page: 1, section: null }], vectors: null });
      return { kind: "done", contentHash: "stable-hash", chunkCount: 1, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");
    x.books.save(book("book", { mtime: 2 }));
    x.indexing.schedule({ id: "book", size: 100, mtime: 2 }, 0);
    await waitFor(() => x.runner.runs.length === 2 && statusOf(x.bookIndexes, "book") === "ready");
    expect(x.runner.runs[1]!.knownHash).toBe("stable-hash");
    expect(x.bookIndexes.get("book")).toMatchObject({ chunkCount: 1, contentHash: "stable-hash" });
    expect(x.passages.searchLexical("kept", 5)).toHaveLength(1);
  });

  it("retries transient failures and marks the book as error after three attempts", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.handler = async () => { throw Object.assign(new Error("boom"), { code: "unknown" }); };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();

    await waitFor(() => x.bookIndexes.get("book")?.attempts === 1);
    expect(x.bookIndexes.get("book")).toMatchObject({ state: "pending", nextAttemptAt: x.clock.now() + 60_000 });
    for (const attempt of [2, 3]) {
      x.bookIndexes.save({ ...x.bookIndexes.get("book")!, nextAttemptAt: 0 });
      x.indexing.kick();
      await waitFor(() => x.bookIndexes.get("book")?.attempts === attempt);
    }
    expect(x.bookIndexes.get("book")).toMatchObject({ state: "error", attempts: 3, error: { code: "unknown", message: "boom" } });
    expect(x.runner.runs).toHaveLength(3);
    x.indexing.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(3);
  });

  it("keeps the previous index when a source cannot be read and retries", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.passages.append("book", [{ passage: { ordinal: 0, text: "old text", page: 1, section: null }, vector: null }]);
    let fail = true;
    x.runner.handler = async (job, sink) => {
      if (fail) throw Object.assign(new Error("share is offline"), { code: "unreadable" });
      sink.onStart("new-hash");
      await sink.onBatch({ passages: [{ ordinal: 0, text: "new text", page: 1, section: null }], vectors: null });
      return { kind: "done", contentHash: "new-hash", chunkCount: 1, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.attempts === 1);
    expect(x.passages.searchLexical("old", 5)).toHaveLength(1);

    fail = false;
    x.bookIndexes.save({ ...x.bookIndexes.get("book")!, nextAttemptAt: 0 });
    x.indexing.kick();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");
    expect(x.passages.searchLexical("old", 5)).toEqual([]);
    expect(x.passages.searchLexical("new", 5)).toHaveLength(1);
  });

  it("preserves the previous complete hash when the failure happens before onStart", async () => {
    const x = setup();
    x.books.save(book("book"));
    let phase: "initial" | "fail" | "retry" = "initial";
    x.runner.handler = async (job, sink) => {
      if (phase === "initial") {
        sink.onStart("hash-v1");
        await sink.onBatch({ passages: [{ ordinal: 0, text: "old complete", page: 1, section: null }], vectors: null });
        return { kind: "done", contentHash: "hash-v1", chunkCount: 1, indexVersion: job.indexVersion };
      }
      if (phase === "fail") throw Object.assign(new Error("share is offline"), { code: "unreadable" });
      if (job.knownHash === "hash-v1") return { kind: "unchanged", contentHash: "hash-v1", indexVersion: job.indexVersion };
      throw new Error("unexpected full ingestion");
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");

    phase = "fail";
    x.books.save(book("book", { mtime: 2 }));
    x.indexing.schedule({ id: "book", size: 100, mtime: 2 }, 0);
    await waitFor(() => x.bookIndexes.get("book")?.attempts === 1);
    expect(x.bookIndexes.get("book")).toMatchObject({
      state: "pending",
      contentHash: "hash-v1",
      indexVersion: "1|lexical",
      chunkCount: 1,
    });
    expect(x.passages.searchLexical("old", 5)).toHaveLength(1);

    phase = "retry";
    x.bookIndexes.save({ ...x.bookIndexes.get("book")!, nextAttemptAt: 0 });
    x.indexing.kick();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready" && x.runner.runs.length === 3);
    expect(x.runner.runs[2]!.knownHash).toBe("hash-v1");
    expect(x.bookIndexes.get("book")).toMatchObject({ contentHash: "hash-v1", chunkCount: 1 });
    expect(x.passages.searchLexical("old", 5)).toHaveLength(1);
  });

  it("does not promote partial chunks when a retry sees the failed run's hash", async () => {
    const x = setup();
    x.books.save(book("book"));
    let phase: "initial" | "partial" | "retry" = "initial";
    x.runner.handler = async (job, sink) => {
      if (phase === "initial") {
        sink.onStart("hash-v1");
        await sink.onBatch({ passages: [{ ordinal: 0, text: "old complete", page: 1, section: null }], vectors: null });
        return { kind: "done", contentHash: "hash-v1", chunkCount: 1, indexVersion: job.indexVersion };
      }
      if (phase === "partial") {
        sink.onStart("hash-v2");
        await sink.onBatch({ passages: [{ ordinal: 0, text: "partial alpha", page: 1, section: null }], vectors: null });
        throw Object.assign(new Error("embedder hiccup"), { code: "unknown" });
      }
      // A runner that trusted the bookkeeping of the failed run would stop at this fast path.
      if (job.knownHash === "hash-v2") return { kind: "unchanged", contentHash: "hash-v2", indexVersion: job.indexVersion };
      sink.onStart("hash-v2");
      await sink.onBatch({
        passages: [
          { ordinal: 0, text: "full alpha", page: 1, section: null },
          { ordinal: 1, text: "full beta", page: 2, section: null },
          { ordinal: 2, text: "full gamma", page: 3, section: null },
        ],
        vectors: null,
      });
      return { kind: "done", contentHash: "hash-v2", chunkCount: 3, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");

    phase = "partial";
    x.books.save(book("book", { mtime: 2 }));
    x.indexing.schedule({ id: "book", size: 100, mtime: 2 }, 0);
    await waitFor(() => x.runner.runs.length === 2 && x.bookIndexes.get("book")?.attempts === 1);
    expect(x.bookIndexes.get("book")).toMatchObject({
      state: "pending",
      contentHash: null,
      indexVersion: null,
      chunkCount: 0,
    });

    phase = "retry";
    x.bookIndexes.save({ ...x.bookIndexes.get("book")!, nextAttemptAt: 0 });
    x.indexing.kick();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready" && x.runner.runs.length === 3);
    expect(x.runner.runs[2]!.knownHash).toBeNull();
    expect(x.bookIndexes.get("book")).toMatchObject({ contentHash: "hash-v2", chunkCount: 3 });
    expect(x.passages.searchLexical("full", 5)).toHaveLength(3);
    expect(x.passages.searchLexical("partial", 5)).toEqual([]);
  });

  it("invalidates the stored hash at onStart so a crash cannot promote partial chunks after restart", async () => {
    const x = setup();
    x.books.save(book("book"));
    let phase: "initial" | "crash" | "restart" = "initial";
    let crashed!: () => void;
    const crashReached = new Promise<void>((resolve) => { crashed = resolve; });
    const handler = async (job: IngestJob, sink: IngestSink): Promise<IngestOutcome> => {
      if (phase === "initial") {
        sink.onStart("hash-v1");
        await sink.onBatch({ passages: [{ ordinal: 0, text: "old complete", page: 1, section: null }], vectors: null });
        return { kind: "done", contentHash: "hash-v1", chunkCount: 1, indexVersion: job.indexVersion };
      }
      if (phase === "crash") {
        sink.onStart("hash-v2");
        await sink.onBatch({ passages: [{ ordinal: 0, text: "partial from v2", page: 1, section: null }], vectors: null });
        crashed();
        await new Promise<void>(() => {});
        return { kind: "done", contentHash: "hash-v2", chunkCount: 1, indexVersion: job.indexVersion };
      }
      // After the restart the file went back to the content that was fully indexed before.
      if (job.knownHash === "hash-v1") return { kind: "unchanged", contentHash: "hash-v1", indexVersion: job.indexVersion };
      sink.onStart("hash-v1");
      await sink.onBatch({
        passages: [
          { ordinal: 0, text: "restored alpha", page: 1, section: null },
          { ordinal: 1, text: "restored beta", page: 2, section: null },
        ],
        vectors: null,
      });
      return { kind: "done", contentHash: "hash-v1", chunkCount: 2, indexVersion: job.indexVersion };
    };
    x.runner.handler = handler;
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");

    phase = "crash";
    x.books.save(book("book", { mtime: 2 }));
    x.indexing.schedule({ id: "book", size: 100, mtime: 2 }, 0);
    await crashReached;
    expect(x.bookIndexes.get("book")).toMatchObject({
      state: "indexing",
      contentHash: null,
      indexVersion: null,
      chunkCount: 0,
    });

    // Simulate a process restart: the interrupted row must not carry a complete-looking hash.
    x.indexing.stop();
    x.clock.advance(10);
    phase = "restart";
    const restartedRunner = new FakeRunner();
    restartedRunner.handler = handler;
    const restarted = new Indexing(x.bookIndexes, x.passages, x.books, restartedRunner, x.clock, {
      enabled: true, maxBytes: 1_000, concurrency: 1, backfill: "auto",
    }, x.log);
    restarted.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready" && restartedRunner.runs.length === 1);
    expect(restartedRunner.runs[0]!.knownHash).toBeNull();
    expect(x.bookIndexes.get("book")).toMatchObject({ contentHash: "hash-v1", chunkCount: 2 });
    expect(x.passages.searchLexical("restored", 5)).toHaveLength(2);
    expect(x.passages.searchLexical("partial", 5)).toEqual([]);
    restarted.stop();
  });

  it("clears partial chunks when a failure happens after the previous index was discarded", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.handler = async (job, sink) => {
      sink.onStart(null);
      await sink.onBatch({ passages: [{ ordinal: 0, text: "partial text", page: 1, section: null }], vectors: null });
      throw Object.assign(new Error("file vanished"), { code: "unreadable" });
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.attempts === 1);
    expect(x.passages.searchLexical("partial", 5)).toEqual([]);
    expect(x.bookIndexes.get("book")).toMatchObject({ state: "pending", contentHash: null, indexVersion: null });
    x.indexing.stop();
  });

  it("does not resurrect a book deleted while its job runs", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.handler = async (job, sink) => {
      x.books.delete(job.bookId);
      await sink.onBatch({ passages: [{ ordinal: 0, text: "orphan", page: null, section: null }], vectors: null });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.runner.runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.books.get("book")).toBeUndefined();
    expect(x.bookIndexes.get("book")).toBeUndefined();
    expect(x.passages.searchLexical("orphan", 5)).toEqual([]);
  });

  it("reconciles degraded books when the embedder becomes ready", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.version = "1|none";
    x.runner.embeddingsStatus = { mode: "local", model: "model", state: "unavailable" };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.state === "ready");
    expect(x.bookIndexes.get("book")?.indexVersion).toBe("1|none");

    x.runner.becomeReady();
    await waitFor(() => x.runner.runs.length === 2 && x.bookIndexes.get("book")?.indexVersion === "1|local:model");
    expect(x.runner.runs[1]!.indexVersion).toBe("1|local:model");
  });

  it("persists the version the runner actually produced and retries it once http+auto allows", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.version = "1|http:m";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    x.runner.handler = async (job, sink) => {
      sink.onStart("hash");
      await sink.onBatch({ passages: [{ ordinal: 0, text: "fallback text", page: null, section: null }], vectors: null });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: "1|none" };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");
    expect(x.bookIndexes.get("book")).toMatchObject({ indexVersion: "1|none", contentHash: "hash" });
    // The in-memory fallback set is what authorises a retry of an already-sent book.
    x.indexing.stop();
    expect(x.indexing.reconcile()).toBe(1);
    expect(x.bookIndexes.get("book")?.state).toBe("pending");
  });

  it("preserves the job version when the runner reports an unchanged outcome", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.version = "1|http:m";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    x.bookIndexes.save({
      bookId: "book", state: "ready", priority: 0, contentHash: "kept", indexVersion: "1|http:m", fingerprint: "99:1",
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    x.runner.handler = async (job) => {
      expect(job.knownHash).toBe("kept");
      return { kind: "unchanged", contentHash: "kept", indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.runner.runs.length === 1 && x.bookIndexes.get("book")?.state === "ready");
    expect(x.bookIndexes.get("book")).toMatchObject({ contentHash: "kept", indexVersion: "1|http:m", chunkCount: 1 });
  });

  it("reindexes the degraded book after the embedder recovers and then stops", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.version = "1|http:m";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    let healthy = false;
    x.runner.handler = async (job, sink) => {
      sink.onStart("hash");
      await sink.onBatch({
        passages: [{ ordinal: 0, text: "recovered text", page: null, section: null }],
        vectors: healthy ? [new Float32Array([1, 0])] : null,
      });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: healthy ? job.indexVersion : "1|none" };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready" && x.bookIndexes.get("book")?.indexVersion === "1|none");

    healthy = true;
    x.runner.becomeReady("1|http:m", { mode: "http", model: "m", state: "ready" });
    await waitFor(() => x.runner.runs.length === 2 && x.bookIndexes.get("book")?.indexVersion === "1|http:m");
    expect(x.runner.runs[1]!.knownHash).toBeNull();
    expect(x.indexing.reconcile()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(2);
    expect(x.bookIndexes.get("book")?.state).toBe("ready");
  });

  it("marks a second book ingested while the provider is already unavailable and reindexes it after recovery", async () => {
    const x = setup();
    x.books.save(book("first"));
    x.books.save(book("second"));
    x.runner.version = "1|http:m";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    let healthy = true;
    x.runner.handler = async (job, sink) => {
      const hash = `hash-${job.bookId}`;
      sink.onStart(hash);
      await sink.onBatch({
        passages: [{ ordinal: 0, text: `text of ${job.bookId}`, page: null, section: null }],
        vectors: healthy ? [new Float32Array([1, 0])] : null,
      });
      return { kind: "done", contentHash: hash, chunkCount: 1, indexVersion: healthy ? job.indexVersion : "1|none" };
    };
    x.indexing.schedule({ id: "first", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("first")?.state === "ready");
    expect(x.bookIndexes.get("first")?.indexVersion).toBe("1|http:m");

    // The provider is already down when the second upload arrives: the job captures `1|none`
    // and produces `1|none`, so comparing captured and effective versions would miss it.
    healthy = false;
    x.runner.version = "1|none";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "unavailable" };
    x.indexing.schedule({ id: "second", size: 100, mtime: 1 }, 1);
    await waitFor(() => x.bookIndexes.get("second")?.state === "ready");
    expect(x.bookIndexes.get("second")?.indexVersion).toBe("1|none");

    healthy = true;
    x.runner.becomeReady("1|http:m", { mode: "http", model: "m", state: "ready" });
    await waitFor(() => x.bookIndexes.get("second")?.indexVersion === "1|http:m"
      && x.bookIndexes.get("first")?.indexVersion === "1|http:m");
    expect(x.runner.runs.map((job) => job.bookId)).toEqual(["first", "second", "second"]);
    expect(x.indexing.reconcile()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(3);
  });

  it("reconciles a recovery that arrives during a blocked job only after the job records its result", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.version = "1|none";
    x.runner.embeddingsStatus = { mode: "http", model: "m", state: "unavailable" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sawStart!: () => void;
    const started = new Promise<void>((resolve) => { sawStart = resolve; });
    x.runner.handler = async (job, sink) => {
      if (x.runner.runs.length === 1) {
        sink.onStart("hash");
        sawStart();
        // The worker's recovery probe can fire while the job is blocked beyond the cooldown.
        await gate;
        await sink.onBatch({ passages: [{ ordinal: 0, text: "fallback text", page: null, section: null }], vectors: null });
        return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: "1|none" };
      }
      sink.onStart("hash");
      await sink.onBatch({
        passages: [{ ordinal: 0, text: "embedded text", page: null, section: null }],
        vectors: [new Float32Array([1, 0])],
      });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await started;
    expect(statusOf(x.bookIndexes, "book")).toBe("indexing");

    x.runner.becomeReady("1|http:m", { mode: "http", model: "m", state: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    // The job is still blocked: reconcile must wait for its effective version and degraded entry.
    expect(x.runner.runs).toHaveLength(1);
    expect(statusOf(x.bookIndexes, "book")).toBe("indexing");

    release();
    await waitFor(() => x.runner.runs.length === 2 && x.bookIndexes.get("book")?.indexVersion === "1|http:m");
    expect(x.runner.runs[1]!.knownHash).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(x.runner.runs).toHaveLength(2);
    expect(x.indexing.reconcile()).toBe(0);
  });

  it("with http + auto retries only degraded books, while BACKFILL=on retries every obsolete book", async () => {
    const auto = setup();
    auto.books.save(book("degraded")); auto.books.save(book("old-config")); auto.books.save(book("unindexed"));
    auto.runner.version = "1|http:m";
    auto.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    auto.runner.handler = async (job, sink) => {
      sink.onStart("hash");
      await sink.onBatch({ passages: [{ ordinal: 0, text: "text", page: null, section: null }], vectors: null });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: "1|none" };
    };
    auto.indexing.schedule({ id: "degraded", size: 100, mtime: 1 }, 1);
    auto.indexing.start();
    await waitFor(() => statusOf(auto.bookIndexes, "degraded") === "ready");
    auto.indexing.stop();
    auto.bookIndexes.save({
      bookId: "old-config", state: "ready", priority: 0, contentHash: "old", indexVersion: "1|none", fingerprint: null,
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
    });

    expect(auto.indexing.reconcile()).toBe(1);
    expect(auto.bookIndexes.get("degraded")?.state).toBe("pending");
    expect(auto.bookIndexes.get("old-config")?.state).toBe("ready");
    expect(auto.bookIndexes.get("unindexed")).toBeUndefined();

    const explicitOn = setup({ backfill: "on" });
    explicitOn.books.save(book("one")); explicitOn.books.save(book("two"));
    explicitOn.runner.version = "1|http:m";
    explicitOn.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    for (const id of ["one", "two"]) {
      explicitOn.bookIndexes.save({
        bookId: id, state: "ready", priority: 0, contentHash: "old", indexVersion: "1|none", fingerprint: null,
        chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
      });
    }
    expect(explicitOn.indexing.reconcile()).toBe(2);
    expect(explicitOn.bookIndexes.get("one")?.state).toBe("pending");
    expect(explicitOn.bookIndexes.get("two")?.state).toBe("pending");
  });

  it("backfills unindexed books only when policy allows", () => {
    const autoHttp = setup();
    autoHttp.books.save(book("book"));
    autoHttp.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    expect(autoHttp.indexing.reconcile()).toBe(0);
    expect(autoHttp.bookIndexes.get("book")).toBeUndefined();

    const autoLocal = setup();
    autoLocal.books.save(book("book"));
    expect(autoLocal.indexing.reconcile()).toBe(1);
    expect(autoLocal.bookIndexes.get("book")?.state).toBe("pending");

    const explicitOn = setup({ backfill: "on" });
    explicitOn.books.save(book("book"));
    explicitOn.runner.embeddingsStatus = { mode: "http", model: "m", state: "ready" };
    expect(explicitOn.indexing.reconcile()).toBe(1);

    const off = setup({ backfill: "off" });
    off.books.save(book("book"));
    expect(off.indexing.reconcile()).toBe(0);
  });

  it("forces a reindex and validates the book state", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => statusOf(x.bookIndexes, "book") === "ready");
    expect(x.indexing.reindex("book")).toBe("pending");
    await waitFor(() => x.runner.runs.length === 2 && statusOf(x.bookIndexes, "book") === "ready");
    expect(x.runner.runs[1]!.knownHash).toBeNull();
    expect(() => x.indexing.reindex("missing")).toThrow(NotFoundError);
    x.books.save(book("pending", { status: "pending" }));
    expect(() => x.indexing.reindex("pending")).toThrow(ConflictError);
  });

  it("requeues failed and all books, including unindexed ones", () => {
    const x = setup();
    x.books.save(book("ready")); x.books.save(book("unindexed"));
    x.bookIndexes.save({
      bookId: "ready", state: "error", priority: 0, contentHash: null, indexVersion: null, fingerprint: null,
      chunkCount: 0, attempts: 3, nextAttemptAt: 0, error: { code: "unknown", message: "x" },
      requestedAt: 1, startedAt: 1, finishedAt: 2,
    });
    expect(x.indexing.reindexAll("failed")).toBe(1);
    expect(x.bookIndexes.get("ready")?.state).toBe("pending");
    expect(x.bookIndexes.get("unindexed")).toBeUndefined();
    // "ready" is already pending, so only the book that had no row is newly queued.
    expect(x.indexing.reindexAll("all")).toBe(1);
    expect(x.bookIndexes.get("unindexed")?.state).toBe("pending");
    x.indexing.stop();
  });

  it("reports the current job and its progress", async () => {
    const x = setup();
    x.books.save(book("book"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sawProgress!: () => void;
    const progress = new Promise<void>((resolve) => { sawProgress = resolve; });
    x.runner.handler = async (job, sink) => {
      sink.onStart("hash");
      sink.onProgress(0.42);
      sawProgress();
      await gate;
      await sink.onBatch({ passages: [{ ordinal: 0, text: "late", page: null, section: null }], vectors: null });
      return { kind: "done", contentHash: "hash", chunkCount: 1, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await progress;    expect(x.indexing.status().current).toEqual({ bookId: "book", progress: 0.42 });
    release();
    await waitFor(() => x.indexing.status().current === null);
    expect(x.indexing.status().counts.ready).toBe(1);
    expect(x.indexing.status().revision).toBeGreaterThan(0);
  });

  it("stops claiming a queued book whose metadata failed", async () => {
    const x = setup();
    x.books.save(book("book", { status: "error" }));
    x.bookIndexes.upsertPending({ bookId: "book", priority: 1, fingerprint: "100:1", now: 1, resetAttempts: false });
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.state === "error");
    expect(x.runner.runs).toHaveLength(0);
    expect(x.bookIndexes.get("book")?.error?.code).toBe("unreadable");
    x.indexing.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(0);
  });

  it("leaves oversized books in error without calling the runner and drops the previous hash with the chunks", async () => {
    const x = setup({ maxBytes: 50 });
    x.books.save(book("book"));
    x.passages.append("book", [{ passage: { ordinal: 0, text: "old text", page: 1, section: null }, vector: null }]);
    x.bookIndexes.save({
      bookId: "book", state: "ready", priority: 0, contentHash: "old-hash", indexVersion: "1|none", fingerprint: "99:1",
      chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 2, finishedAt: 3,
    });
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.state === "error");
    expect(x.runner.runs).toHaveLength(0);
    expect(x.bookIndexes.get("book")).toMatchObject({
      error: { code: "too_large" },
      contentHash: null,
      indexVersion: null,
      chunkCount: 0,
    });
    expect(x.passages.searchLexical("old", 5)).toEqual([]);
  });

  it("stops pumping new jobs after stop()", async () => {
    const x = setup();
    x.indexing.start();
    x.indexing.stop();
    x.books.save(book("book"));
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(x.runner.runs).toHaveLength(0);
    expect(x.bookIndexes.get("book")?.state).toBe("pending");
  });
});

describe("Ingestion sink contract", () => {
  it("passes batches to the passage repository and records chunk counts", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.runner.handler = async (job, sink) => {
      const batch: IngestBatch = {
        passages: [
          { ordinal: 0, text: "first passage", page: 1, section: null },
          { ordinal: 1, text: "second passage", page: 2, section: null },
        ],
        vectors: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      };
      sink.onStart("hash");
      await sink.onBatch(batch);
      await sink.onBatch({ passages: [{ ordinal: 2, text: "third passage", page: 3, section: null }], vectors: null });
      return { kind: "done", contentHash: "hash", chunkCount: 3, indexVersion: job.indexVersion };
    };
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.bookIndexes.get("book")?.state === "ready");
    expect(x.bookIndexes.get("book")).toMatchObject({ chunkCount: 3, contentHash: "hash", indexVersion: "1|lexical" });
    expect(x.passages.hydrate([1, 2, 3]).map((view) => view.text)).toEqual(["first passage", "second passage", "third passage"]);
    expect((x.db.prepare("SELECT COUNT(*) AS n FROM chunk_vectors").get() as { n: number }).n).toBe(2);
  });
});
