import { parentPort, type MessagePort } from "node:worker_threads";

import type { IngestBatch, IngestSink } from "../../ports/knowledge.js";
import { createEmbedder, type EmbedderConfig } from "./embed/create.js";
import type { Embedder } from "./embed/Embedder.js";
import { describeFailure } from "./errors.js";
import { EpubTextExtractor } from "./extract/EpubTextExtractor.js";
import { PdfTextExtractor } from "./extract/PdfTextExtractor.js";
import { INGEST_BATCH_SIZE, LEXICAL_BATCH_SIZE, ingestFile, paragraphChunks } from "./pipeline.js";
import { safeErrorType } from "../logging/safeError.js";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.js";

const port = requirePort(parentPort);

function requirePort(value: typeof parentPort): MessagePort {
  if (!value) throw new Error("The ingestion worker must run inside a worker thread");
  return value;
}

let embedder: Embedder | null = null;
let embedderKey = "";
let embedderConfig: EmbedderConfig = { kind: "none" };
let lexicalEmbedder: Embedder | null = null;
let running = false;
let cancelled = false;
let batchId = 0;
let ack: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryGeneration = 0;
/** Runs are serialized: a run posted during the cancellation of the previous one waits. */
let runs: Promise<void> = Promise.resolve();
/**
 * Queries are serialized too, and cancelled ids are remembered until their turn: the
 * main thread aborts a timed-out embedding, and the worker must drop the queued query
 * instead of paying for it later. A query already inside the embedder cannot be
 * interrupted (local inference is synchronous); its result is simply discarded.
 */
let queries: Promise<void> = Promise.resolve();
const cancelledQueries = new Set<number>();
const MAX_CANCELLED_QUERIES = 64;

function post(message: WorkerResponse, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

function stopRetry(): void {
  retryGeneration += 1;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * A degraded HTTP provider must recover even when the queue is idle; a local
 * model failure is permanent, so only `http` is polled. The timer is unref'd
 * so it never keeps the worker (and the process) alive by itself.
 */
function scheduleRetry(target: Embedder): void {
  stopRetry();
  if (target !== embedder || embedderConfig.kind !== "http") return;
  if (target.status().state !== "unavailable") return;
  const delay = target.retryInMs?.();
  if (delay === null || delay === undefined) return;
  const generation = retryGeneration;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (generation !== retryGeneration || target !== embedder) return;
    void target.prepare().then(
      () => postStatus(target),
      (error: unknown) => {
        console.warn(`[indexing worker] embeddings recovery probe failed (${safeErrorType(error)})`);
        postStatus(target);
      },
    );
  }, delay);
  retryTimer.unref();
}

function postStatus(target: Embedder): void {
  post({ type: "embeddings", status: target.status() });
  scheduleRetry(target);
}

function embedderFor(config: EmbedderConfig): Embedder {
  const key = JSON.stringify(config);
  if (embedder && key === embedderKey) return embedder;
  stopRetry();
  if (embedder) void embedder.dispose().catch(() => {});
  embedderKey = key;
  embedderConfig = config;
  embedder = createEmbedder(config, {
    log: (message) => {
      if (embedder) postStatus(embedder);
      console.warn(`[indexing worker] ${message}`);
    },
  });
  return embedder;
}

function sinkFor(): IngestSink {
  return {
    onStart(contentHash) {
      post({ type: "started", contentHash });
    },
    onProgress(fraction) {
      post({ type: "progress", fraction });
    },
    async onBatch(batch: IngestBatch): Promise<void> {
      if (cancelled) throw new Error("Ingestion cancelled");
      const id = ++batchId;
      const transfer = batch.vectors?.map((vector) => vector.buffer as ArrayBuffer) ?? [];
      post({ type: "batch", id, passages: batch.passages, vectors: batch.vectors }, transfer);
      await new Promise<void>((resolve) => {
        ack = resolve;
      });
      if (cancelled) throw new Error("Ingestion cancelled");
    },
  };
}

async function handleRun(message: Extract<WorkerRequest, { type: "run" }>): Promise<void> {
  if (running) {
    post({ type: "failed", code: "unknown", message: "Ingestion worker is busy" });
    return;
  }
  running = true;
  cancelled = false;
  const active = embedderFor(message.embedder);
  const useVectors = active.id !== "none" && message.job.vectors !== false;
  lexicalEmbedder ??= createEmbedder({ kind: "none" });
  try {
    if (useVectors) await active.prepare();
    postStatus(active);
    const extractor = message.job.format === "pdf" ? new PdfTextExtractor() : new EpubTextExtractor();
    const outcome = await ingestFile(message.job, sinkFor(), {
      extractor,
      embedder: useVectors ? active : lexicalEmbedder,
      maxBytes: message.limits.maxBytes,
      batchSize: useVectors ? INGEST_BATCH_SIZE : LEXICAL_BATCH_SIZE,
      chunk: message.chunking === "paragraph" ? paragraphChunks : undefined,
    });
    if (outcome.kind === "unchanged") {
      post({ type: "unchanged", contentHash: outcome.contentHash, indexVersion: outcome.indexVersion });
    } else {
      post({
        type: "done",
        contentHash: outcome.contentHash,
        chunkCount: outcome.chunkCount,
        indexVersion: outcome.indexVersion,
      });
    }
  } catch (error) {
    const failure = describeFailure(error);
    post({ type: "failed", code: failure.code, message: failure.message });
  } finally {
    ack = null;
    running = false;
    postStatus(active);
  }
}

async function handleQuery(message: Extract<WorkerRequest, { type: "query" }>): Promise<void> {
  if (cancelledQueries.delete(message.id)) return;
  const active = embedderFor(message.embedder);
  try {
    const vector = await active.embedQuery(message.text);
    // The caller gave up while the embedder was working: never post its result.
    if (cancelledQueries.delete(message.id)) return;
    post({ type: "query-result", id: message.id, vector }, vector ? [vector.buffer as ArrayBuffer] : []);
  } catch (error) {
    // A query failure is not a run failure: report it only to the waiting caller so an
    // active ingestion is never interrupted by a retrieval error.
    console.warn(`[indexing worker] query embedding failed (${safeErrorType(error)})`);
    post({ type: "query-result", id: message.id, vector: null });
  } finally {
    postStatus(active);
  }
}

function rememberCancelledQuery(id: number): void {
  cancelledQueries.add(id);
  while (cancelledQueries.size > MAX_CANCELLED_QUERIES) {
    const oldest = cancelledQueries.values().next().value;
    if (oldest === undefined) break;
    cancelledQueries.delete(oldest);
  }
}

port.on("message", (message: WorkerRequest) => {
  switch (message.type) {
    case "batch-ack":
      ack?.();
      ack = null;
      return;
    case "cancel":
      cancelled = true;
      ack?.();
      ack = null;
      return;
    case "close":
      stopRetry();
      void (embedder?.dispose() ?? Promise.resolve()).finally(() => process.exit(0));
      return;
    case "run":
      runs = runs.then(() => handleRun(message)).catch((error: unknown) => {
        console.error(`[indexing worker] run queue failed (${safeErrorType(error)})`);
      });
      return;
    case "query-cancel":
      rememberCancelledQuery(message.id);
      return;
    case "query":
      if (cancelledQueries.delete(message.id)) return;
      queries = queries.then(() => handleQuery(message)).catch((error: unknown) => {
        console.error(`[indexing worker] query queue failed (${safeErrorType(error)})`);
      });
  }
});
