import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { LEXICAL_INDEX_SUFFIX } from "../../domain/knowledge/BookIndex.js";
import type {
  EmbeddingsStatus,
  EmbedQueryOptions,
  IngestionRunner,
  IngestJob,
  IngestOutcome,
  IngestSink,
} from "../../ports/knowledge.js";
import type { EmbedderConfig } from "./embed/create.js";
import { IngestError } from "./errors.js";
import { DEFAULT_MAX_BYTES, PIPELINE_VERSION } from "./pipeline.js";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.js";

export interface ThreadIngestionRunnerOptions {
  embedder: EmbedderConfig;
  /** Books above this size fail fast with `too_large`. */
  maxBytes?: number;
  maxOldGenerationSizeMb?: number;
  /**
   * Worker threads used for ingestion. Lexical extraction is CPU-bound per book, so a
   * small pool multiplies throughput; the wiring caps local embeddings at one worker
   * (ORT already uses its own threads) and HTTP at two.
   */
  workers?: number;
  /** Test seam: run an alternative worker entry point. */
  workerPath?: string;
  /**
   * Ceiling on query embeddings waiting for a worker. A busy ingestion worker would
   * otherwise let abandoned queries accumulate; past this limit the caller falls back to
   * lexical search instead of queueing more work.
   */
  maxQueryBacklog?: number;
  /**
   * Test seam: chunking strategy inside the worker. Production relies on the
   * domain `chunkSections` (the default) once that track lands.
   */
  chunking?: "domain" | "paragraph";
  log?: (message: string, error?: unknown) => void;
}

interface ActiveRun {
  sink: IngestSink;
  resolve: (outcome: IngestOutcome) => void;
  reject: (error: unknown) => void;
}

interface QueuedRun extends ActiveRun {
  job: IngestJob;
}

interface WorkerSlot {
  worker: Worker;
  active: ActiveRun | null;
  closing: boolean;
}

interface PendingQuery {
  slot: WorkerSlot;
  resolve: (vector: Float32Array | null) => void;
  reject: (error: unknown) => void;
  /** Removes the abort listener once the request settles for any reason. */
  detach: () => void;
}

const DEFAULT_MAX_QUERY_BACKLOG = 4;

function initialStatus(config: EmbedderConfig): EmbeddingsStatus {
  switch (config.kind) {
    case "local":
      return { mode: "local", model: config.model, state: "off" };
    case "http":
      return { mode: "http", model: config.model, state: "ready" };
    default:
      return { mode: "none", model: null, state: "off" };
  }
}

function configuredId(config: EmbedderConfig): string {
  switch (config.kind) {
    case "local":
      return `local:${config.model}`;
    case "http":
      return `http:${config.model}`;
    default:
      return LEXICAL_INDEX_SUFFIX;
  }
}

/** Resolves the sibling worker entry point, preferring the format of this module. */
export function resolveWorkerPath(override?: string): string {
  if (override) return override;
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const preferred = import.meta.url.endsWith(".ts")
    ? ["ingest.worker.ts", "ingest.worker.js"]
    : ["ingest.worker.js", "ingest.worker.ts"];
  for (const name of preferred) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The ingestion worker bundle is missing from the installation");
}

/**
 * Runs ingestion in a pool of dedicated worker threads so pdf.js and embedding
 * inference never block the API event loop. Each worker handles one job at a
 * time; a crashed worker is replaced by the next dispatch.
 */
export class ThreadIngestionRunner implements IngestionRunner {
  private slots: WorkerSlot[] = [];
  private readonly queue: QueuedRun[] = [];
  private queries = new Map<number, PendingQuery>();
  private queryId = 0;
  private status: EmbeddingsStatus;
  private closing = false;
  private workerPath: string | null = null;
  private readonly readyListeners = new Set<() => void>();
  private readonly maxBytes: number;
  private readonly maxWorkers: number;
  private readonly maxQueryBacklog: number;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: ThreadIngestionRunnerOptions) {
    this.status = initialStatus(options.embedder);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxWorkers = Math.max(1, Math.floor(options.workers ?? 1));
    this.maxQueryBacklog = Math.max(1, Math.floor(options.maxQueryBacklog ?? DEFAULT_MAX_QUERY_BACKLOG));
    this.log = options.log ?? (() => {});
  }

  run(job: IngestJob, sink: IngestSink): Promise<IngestOutcome> {
    if (this.closing) return Promise.reject(new IngestError("unknown", "Ingestion runner closed"));
    return new Promise<IngestOutcome>((resolve, reject) => {
      this.queue.push({ job, sink, resolve, reject });
      this.dispatch();
    });
  }

  async embedQuery(text: string, options: EmbedQueryOptions = {}): Promise<Float32Array | null> {
    if (this.options.embedder.kind === "none" || this.closing) return null;
    if (options.signal?.aborted) return null;
    if (this.queries.size >= this.maxQueryBacklog) {
      this.log("Query embedding skipped; the ingestion worker is busy");
      return null;
    }
    let slot: WorkerSlot;
    try {
      slot = this.pickQuerySlot();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.queryId;
    return new Promise<Float32Array | null>((resolve, reject) => {
      const signal = options.signal;
      const onAbort = (): void => {
        if (!this.queries.delete(id)) return;
        detach();
        this.cancelQuery(slot, id);
        resolve(null);
      };
      const detach = (): void => signal?.removeEventListener("abort", onAbort);
      this.queries.set(id, { slot, resolve, reject, detach });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        slot.worker.postMessage({ type: "query", id, text, embedder: this.options.embedder } satisfies WorkerRequest);
      } catch (error) {
        this.queries.delete(id);
        detach();
        reject(error);
      }
    });
  }

  embeddings(): EmbeddingsStatus {
    return { ...this.status };
  }

  indexVersion(): string {
    const id = this.options.embedder.kind === "none"
      ? LEXICAL_INDEX_SUFFIX
      : this.status.state === "unavailable"
        ? "none"
        : configuredId(this.options.embedder);
    return `${PIPELINE_VERSION}|${id}`;
  }

  onEmbeddingsReady(callback: () => void): void {
    this.readyListeners.add(callback);
  }

  async close(): Promise<void> {
    this.closing = true;
    const queued = this.queue.splice(0);
    for (const task of queued) task.reject(new IngestError("unknown", "Ingestion runner closed"));
    this.failQueries(new IngestError("unknown", "Ingestion runner closed"));
    for (const slot of this.slots) {
      slot.closing = true;
      const active = slot.active;
      slot.active = null;
      active?.reject(new IngestError("unknown", "Ingestion runner closed"));
    }
    const closing = this.slots.map((slot) => this.closeSlot(slot));
    this.readyListeners.clear();
    await Promise.all(closing);
    this.slots = [];
  }

  private dispatch(): void {
    if (this.closing) return;
    while (this.queue.length > 0) {
      const slot = this.acquireSlot();
      if (!slot) return;
      const task = this.queue.shift()!;
      this.start(slot, task);
    }
  }

  private acquireSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (slot.active === null && !slot.closing) return slot;
    }
    if (this.slots.length >= this.maxWorkers) return null;
    const slot = this.createSlot();
    this.slots.push(slot);
    return slot;
  }

  /** Queries may share a busy worker: the worker services messages between batches. */
  private pickQuerySlot(): WorkerSlot {
    for (const slot of this.slots) {
      if (slot.active === null && !slot.closing) return slot;
    }
    if (this.slots.length > 0) return this.slots[0]!;
    const slot = this.createSlot();
    this.slots.push(slot);
    return slot;
  }

  private start(slot: WorkerSlot, task: QueuedRun): void {
    slot.active = { sink: task.sink, resolve: task.resolve, reject: task.reject };
    try {
      slot.worker.postMessage({
        type: "run",
        job: task.job,
        embedder: this.options.embedder,
        limits: { maxBytes: this.maxBytes },
        chunking: this.options.chunking ?? "domain",
      } satisfies WorkerRequest);
    } catch (error) {
      slot.active = null;
      task.reject(error);
      this.dispatch();
    }
  }

  private createSlot(): WorkerSlot {
    const path = (this.workerPath ??= resolveWorkerPath(this.options.workerPath));
    const worker = new Worker(path, {
      resourceLimits: { maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb ?? 1024 },
      ...(path.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    const slot: WorkerSlot = { worker, active: null, closing: false };
    worker.on("message", (message: WorkerResponse) => {
      try {
        this.handleMessage(slot, message);
      } catch (error) {
        this.log("Ingestion runner failed to handle a worker message", error);
      }
    });
    worker.on("error", (error) => {
      this.log("Ingestion worker crashed", error);
      this.discardSlot(slot, "Ingestion worker crashed");
    });
    worker.on("exit", (code) => {
      if (slot.closing || this.closing) return;
      this.log(`Ingestion worker exited with code ${code}`);
      this.discardSlot(slot, "Ingestion worker exited unexpectedly");
    });
    return slot;
  }

  private discardSlot(slot: WorkerSlot, message: string): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    slot.closing = true;
    void slot.worker.terminate().catch(() => {});
    const run = slot.active;
    slot.active = null;
    run?.reject(new IngestError("unknown", message));
    this.failQueriesFor(slot, new IngestError("unknown", message));
    this.dispatch();
  }

  private closeSlot(slot: WorkerSlot): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void slot.worker.terminate().then(() => resolve());
      }, 2_000);
      slot.worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        slot.worker.postMessage({ type: "close" } satisfies WorkerRequest);
      } catch {
        clearTimeout(timer);
        void slot.worker.terminate().then(() => resolve());
      }
    });
  }

  private failQueries(error: unknown): void {
    const pending = [...this.queries.values()];
    this.queries.clear();
    for (const query of pending) {
      query.detach();
      query.reject(error);
    }
  }

  private failQueriesFor(slot: WorkerSlot, error: unknown): void {
    for (const [id, query] of this.queries) {
      if (query.slot !== slot) continue;
      this.queries.delete(id);
      query.detach();
      query.reject(error);
    }
  }

  /** Tells the worker to skip a query no caller waits for anymore. Never stops a run. */
  private cancelQuery(slot: WorkerSlot, id: number): void {
    try {
      slot.worker.postMessage({ type: "query-cancel", id } satisfies WorkerRequest);
    } catch {
      /* the worker is gone; the exit handler already dropped its pending queries */
    }
  }

  private handleMessage(slot: WorkerSlot, message: WorkerResponse): void {
    switch (message.type) {
      case "started":
        slot.active?.sink.onStart(message.contentHash);
        return;
      case "progress":
        slot.active?.sink.onProgress(message.fraction);
        return;
      case "batch":
        this.handleBatch(slot, message);
        return;
      case "unchanged":
        this.finishRun(slot, {
          kind: "unchanged",
          contentHash: message.contentHash,
          indexVersion: message.indexVersion,
        });
        return;
      case "done":
        this.finishRun(slot, {
          kind: "done",
          contentHash: message.contentHash,
          chunkCount: message.chunkCount,
          indexVersion: message.indexVersion,
        });
        return;
      case "failed":
        this.finishRun(slot, new IngestError(message.code, message.message));
        return;
      case "query-result": {
        const query = this.queries.get(message.id);
        if (!query) return;
        this.queries.delete(message.id);
        query.detach();
        query.resolve(message.vector);
        return;
      }
      case "embeddings":
        this.handleStatus(message.status);
    }
  }

  private handleBatch(slot: WorkerSlot, message: Extract<WorkerResponse, { type: "batch" }>): void {
    const run = slot.active;
    if (!run) return;
    const acknowledge = (): void => {
      try {
        slot.worker.postMessage({ type: "batch-ack", id: message.id } satisfies WorkerRequest);
      } catch {
        /* the worker is gone; the exit handler rejects the run */
      }
    };
    let batch: Promise<void>;
    try {
      batch = run.sink.onBatch({ passages: message.passages, vectors: message.vectors });
    } catch (error) {
      acknowledge();
      this.cancel(slot);
      this.finishRun(slot, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    void batch.then(acknowledge, (error: unknown) => {
      acknowledge();
      this.cancel(slot);
      this.finishRun(slot, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private cancel(slot: WorkerSlot): void {
    try {
      slot.worker.postMessage({ type: "cancel" } satisfies WorkerRequest);
    } catch {
      /* the worker is gone; nothing to cancel */
    }
  }

  private finishRun(slot: WorkerSlot, result: IngestOutcome | Error): void {
    const run = slot.active;
    if (!run) return;
    slot.active = null;
    if (result instanceof Error) run.reject(result);
    else run.resolve(result);
    this.dispatch();
  }

  private handleStatus(status: EmbeddingsStatus): void {
    const wasReady = this.status.state === "ready";
    this.status = status;
    if (!wasReady && status.state === "ready") {
      for (const listener of this.readyListeners) {
        try {
          listener();
        } catch (error) {
          this.log("Embeddings ready listener failed", error);
        }
      }
    }
  }
}
