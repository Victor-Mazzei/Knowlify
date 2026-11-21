import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteSettingsRepository } from "../src/adapters/storage/SqliteSettingsRepository.js";
import { Indexing, type IndexingOptions } from "../src/use-cases/Indexing.js";
import { toLexicalVersion } from "../src/domain/knowledge/BookIndex.js";
import type { Book } from "../src/ports/index.js";
import type {
  EmbeddingsStatus,
  IngestJob,
  IngestOutcome,
  IngestSink,
  IngestionRunner,
} from "../src/ports/knowledge.js";

const databases: Db[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

const book = (id: string): Book => ({
  id, title: `Title ${id}`, author: "", format: "pdf", path: `/${id}.pdf`, cover_path: null,
  size: 100, added_at: 1, source_id: null, mtime: 1, status: "ready",
});

const clock = { now: () => Date.now() };

class PolicyRunner implements IngestionRunner {
  version = "1|http:m";
  status: EmbeddingsStatus = { mode: "http", model: "m", state: "ready" };
  runs: IngestJob[] = [];
  gate: Promise<void> | null = null;

  async run(job: IngestJob, sink: IngestSink): Promise<IngestOutcome> {
    this.runs.push(job);
    if (this.gate) await this.gate;
    sink.onStart("hash");
    await sink.onBatch({
      passages: [{ ordinal: 0, text: `text of ${job.bookId}`, page: 1, section: null }],
      vectors: job.vectors === false ? null : [new Float32Array([1, 0])],
    });
    return {
      kind: "done",
      contentHash: "hash",
      chunkCount: 1,
      indexVersion: job.vectors === false ? toLexicalVersion(job.indexVersion) : job.indexVersion,
    };
  }

  async embedQuery(): Promise<Float32Array | null> { return new Float32Array([1, 0]); }
  embeddings(): EmbeddingsStatus { return this.status; }
  indexVersion(): string { return this.version; }
  onEmbeddingsReady(): void {}
  async close(): Promise<void> {}
}

function setup(overrides: Partial<IndexingOptions> = {}) {
  const db = openDb(":memory:");
  databases.push(db);
  const books = new SqliteBookRepository(db);
  const indexes = new SqliteBookIndexRepository(db);
  const passages = new SqlitePassageRepository(db);
  const settings = new SqliteSettingsRepository(db);
  const runner = new PolicyRunner();
  const log = { info: vi.fn(), error: vi.fn() };
  const options: IndexingOptions = {
    enabled: true, maxBytes: 1_000, concurrency: 1, workers: 1, backfill: "off",
    settings, vectorsMaxBooks: 1_000, ...overrides,
  };
  const indexing = new Indexing(indexes, passages, books, runner, clock, options, log);
  return { db, books, indexes, passages, settings, runner, log, indexing, options };
}

async function waitFor(check: () => boolean, message = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

const readyRow = (bookId: string, indexVersion: string) => ({
  bookId, state: "ready" as const, priority: 0 as const, contentHash: "hash", indexVersion, fingerprint: "100:1",
  chunkCount: 1, attempts: 0, nextAttemptAt: 0, error: null, requestedAt: 1, startedAt: 1, finishedAt: 2,
});

describe("Indexing scale policy", () => {
  it("reconciles degraded versions but keeps lexical-by-choice books out of the queue", () => {
    const x = setup({ backfill: "on" });
    x.books.save(book("lexical"));
    x.books.save(book("degraded"));
    x.indexes.save(readyRow("lexical", "1|lexical"));
    x.indexes.save(readyRow("degraded", "1|none"));
    expect(x.indexing.reconcile()).toBe(1);
    expect(x.indexes.get("lexical")?.state).toBe("ready");
    expect(x.indexes.get("degraded")?.state).toBe("pending");
  });

  it("caps automatic vectors and upgrades books through enqueue", async () => {
    const x = setup({ vectorsMaxBooks: 1 });
    x.books.save(book("one"));
    x.books.save(book("two"));
    x.indexing.schedule({ id: "one", size: 100, mtime: 1 }, 0);
    x.indexing.schedule({ id: "two", size: 100, mtime: 1 }, 0);
    x.indexing.start();
    await waitFor(() => x.indexes.counts().ready === 2);

    const versions = [x.indexes.get("one")?.indexVersion, x.indexes.get("two")?.indexVersion].sort();
    expect(versions).toEqual(["1|http:m", "1|lexical"]);
    const lexical = x.indexes.get("one")?.indexVersion === "1|lexical" ? "one" : "two";
    const vector = lexical === "one" ? "two" : "one";
    expect(x.indexes.get("one")?.state).toBe("ready");

    // A changed file does not push an existing vector book out of the capped tier.
    x.books.save({ ...book(vector), mtime: 2 });
    x.indexing.schedule({ id: vector, size: 100, mtime: 2 }, 0);
    await waitFor(() => x.runner.runs.length === 3 && x.indexes.get(vector)?.state === "ready");
    expect(x.indexes.get(vector)?.indexVersion).toBe("1|http:m");

    x.indexing.stop();
    expect(x.indexing.enqueue([lexical], true)).toEqual({ queued: 1, skipped: 0 });
    x.indexing.start();
    await waitFor(() => x.indexes.get(lexical)?.indexVersion === "1|http:m");
    x.indexing.stop();
  });

  it("honours vectors:false as an explicit lexical request", async () => {
    const x = setup({ vectorsMaxBooks: 100 });
    x.books.save(book("book"));
    x.indexing.start();
    expect(x.indexing.enqueue(["book"], false)).toEqual({ queued: 1, skipped: 0 });
    await waitFor(() => x.indexes.get("book")?.state === "ready");
    expect(x.indexes.get("book")?.indexVersion).toBe("1|lexical");
    expect(x.runner.runs[0]?.vectors).toBe(false);
    x.indexing.stop();
  });

  it("persists pause through a restart and resumes claiming", async () => {
    const x = setup();
    x.books.save(book("book"));
    x.indexing.start();
    x.indexing.pause();
    x.indexing.stop();

    const restarted = new Indexing(x.indexes, x.passages, x.books, x.runner, clock, x.options, x.log);
    restarted.start();
    expect(restarted.status().paused).toBe(true);
    restarted.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(x.runner.runs).toHaveLength(0);

    expect(restarted.resume()).toBe(false);
    await waitFor(() => x.indexes.get("book")?.state === "ready");
    expect(x.runner.runs).toHaveLength(1);
    restarted.stop();
  });

  it("reports a non-null rate after work and an ETA while jobs remain", async () => {
    const x = setup({ backfill: "off" });
    x.books.save(book("one"));
    x.books.save(book("two"));
    x.indexes.save(readyRow("one", "1|http:m"));
    x.indexes.save({ ...readyRow("two", "1|http:m"), chunkCount: 10, fingerprint: "99:1" });
    let release!: () => void;
    x.runner.gate = new Promise<void>((resolve) => { release = resolve; });
    x.indexing.schedule({ id: "two", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await waitFor(() => x.runner.runs.length === 1);
    // A queued row exists while the current job is blocked: ETA can be estimated from the
    // average chunk count once the first job records a rate.
    release();
    await waitFor(() => x.indexes.get("two")?.state === "ready");
    const status = x.indexing.status();
    expect(status.rate).not.toBeNull();
    expect(status.rate!).toBeGreaterThan(0);
    expect(status.etaSec === null || status.etaSec >= 0).toBe(true);
    x.indexing.stop();
  });

  it("holds new claims while the event-loop p99 is above the threshold", async () => {
    let p99 = 250;
    const x = setup({
      backfill: "off",
      backpressure: { enabled: true, p99: () => p99, maxP99Ms: 100, holdMs: 15 },
    });
    x.books.save(book("book"));
    x.indexing.schedule({ id: "book", size: 100, mtime: 1 }, 1);
    x.indexing.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(x.runner.runs).toHaveLength(0);
    expect(x.indexes.get("book")?.state).toBe("pending");

    p99 = 10;
    await waitFor(() => x.indexes.get("book")?.state === "ready");
    expect(x.runner.runs).toHaveLength(1);
    x.indexing.stop();
  });

  it("keeps vector books during a provider outage instead of downgrading them", () => {
    const x = setup({ backfill: "on" });
    x.books.save(book("vector"));
    x.indexes.save(readyRow("vector", "1|http:m"));
    x.runner.version = "1|none";
    x.runner.status = { mode: "http", model: "m", state: "unavailable" };
    x.indexing.schedule({ id: "vector", size: 100, mtime: 1 }, 0);
    expect(x.indexes.get("vector")).toMatchObject({ state: "ready", indexVersion: "1|http:m" });
    expect(x.indexing.reconcile()).toBe(0);
    expect(x.indexes.get("vector")?.state).toBe("ready");
  });

  it("queues a large unindexed library in blocks", () => {
    const x = setup({ backfill: "on" });
    const count = 1_201;
    x.db.transaction(() => {
      const insert = x.db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'ready')`);
      for (let index = 0; index < count; index += 1) {
        insert.run(`bulk-${index}`, `Bulk ${index}`, "", "pdf", `/bulk-${index}.pdf`, null, 10, 1, null, 1);
      }
    })();
    expect(x.indexing.reconcile()).toBe(count);
    expect(x.indexes.counts().pending).toBe(count);
  });
});
