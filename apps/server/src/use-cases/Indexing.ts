import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import {
  failure,
  isDegradedVersion,
  isLexicalVersion,
  isVectorVersion,
  ready,
  toLexicalVersion,
  unchanged,
  RETRY_DELAYS_MS,
  type BookIndex,
  type IndexErrorCode,
  type IndexState,
} from "../domain/knowledge/BookIndex.js";
import type { BookRepository, Clock, Logger } from "../ports/index.js";
import type {
  BookIndexRepository,
  EmbeddingsStatus,
  IndexScheduler,
  IngestBatch,
  IngestOutcome,
  IngestionRunner,
  KeyValueStore,
  PassageRepository,
  PendingIndexUpsert,
} from "../ports/knowledge.js";

export class IndexingDisabledError extends Error {}

export interface IndexingBackpressureOptions {
  enabled?: boolean;
  /** Event-loop p99 above which new claims are held; default 100 ms. */
  maxP99Ms?: number;
  /** How long a worker waits before checking the loop again; default 250 ms. */
  holdMs?: number;
  /** Test seam; production samples `monitorEventLoopDelay` every second. */
  p99?: () => number;
}

export interface IndexingOptions {
  enabled: boolean;
  maxBytes: number;
  /** Parallel jobs the runner accepts (one per worker). */
  concurrency: number;
  backfill: "auto" | "on" | "off";
  /** Reported in the status; defaults to concurrency. */
  workers?: number;
  /** Books that may hold automatic vectors; 0 means demand-only (ADR-C1). */
  vectorsMaxBooks?: number;
  /** Persists pause/resume across restarts (`settings` table). */
  settings?: KeyValueStore;
  backpressure?: IndexingBackpressureOptions;
}

export interface IndexingStatus {
  enabled: boolean;
  search: {
    semantic: boolean;
    embeddings: EmbeddingsStatus["mode"];
    model: string | null;
    state: EmbeddingsStatus["state"];
  };
  counts: { pending: number; indexing: number; ready: number; error: number };
  current: { bookId: string; progress: number | null } | null;
  revision: number;
  paused: boolean;
  rate: number | null;
  etaSec: number | null;
  workers: number;
  vectors: { mode: "auto" | "demand"; maxBooks: number };
}

export interface EnqueueResult {
  queued: number;
  skipped: number;
}

const ERROR_CODES: readonly IndexErrorCode[] = ["no_text", "too_large", "unreadable", "embedder_failed", "unknown"];
const PAUSE_KEY = "index.paused";
/** Boot reconciliation inserts in blocks so one transaction never spans the whole library. */
const RECONCILE_BLOCK = 500;
/** ADR-C2: passive checkpoint every this many completed books. */
const WAL_CHECKPOINT_BOOKS = 50;
const RATE_WINDOW_MS = 60_000;
const RATE_SAMPLE_MS = 1_000;
const DEFAULT_VECTORS_MAX_BOOKS = 1_000;

class JobAbandonedError extends Error {}

/**
 * Owns the search-index queue. Jobs live in book_index; this class pumps them, feeds the
 * runner and persists each batch. Library and Scanner only enqueue, so uploads never wait
 * for ingestion.
 */
export class Indexing implements IndexScheduler {
  private running = false;
  private pumping = false;
  private paused = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly active = new Map<string, number | null>();
  /**
   * Books whose stored content is lexical-only while an embedder is configured. Membership follows
   * the effective version persisted by the job, not the one captured before it ran: a book ingested
   * while the provider was already unavailable is degraded even though both versions match.
   */
  private readonly degraded = new Set<string>();
  /** Explicit `vectors: false` requests; the only queue bit that cannot live in book_index. */
  private readonly forcedLexical = new Set<string>();
  /** Recovery arrived mid-job; drain it once the running job records its effective version. */
  private reconcilePending = false;
  private rateEma: number | null = null;
  private ratePassages = 0;
  private rateStartedAt: number | null = null;
  private completedSinceCheckpoint = 0;
  private loopMonitor: IntervalHistogram | null = null;
  private loopSampler: NodeJS.Timeout | null = null;
  private loopP99 = 0;

  constructor(
    private indexes: BookIndexRepository,
    private passages: PassageRepository,
    private books: BookRepository,
    private runner: IngestionRunner,
    private clock: Clock,
    private options: IndexingOptions,
    private log: Logger = { info: () => {}, error: () => {} },
  ) {
    // HTTP status must report a persisted pause before the queue starts (restart, rebuilt app).
    this.paused = this.options.settings?.get(PAUSE_KEY) === "1";
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get pausedState(): boolean {
    return this.paused;
  }

  schedule(book: { id: string; size: number; mtime: number | null }, priority: 0 | 1): void {
    if (!this.options.enabled) return;
    try {
      const fingerprint = fingerprintOf(book.size, book.mtime);
      const current = this.indexes.get(book.id);
      if (
        current?.state === "ready" &&
        current.fingerprint === fingerprint &&
        this.acceptsVersion(current.indexVersion)
      ) {
        return;
      }
      if (
        (current?.state === "pending" || current?.state === "indexing") &&
        current.fingerprint === fingerprint && current.priority >= priority
      ) {
        return;
      }
      this.indexes.upsertPending({
        bookId: book.id,
        priority,
        fingerprint,
        now: this.clock.now(),
        resetAttempts: false,
      });
      this.kick();
    } catch (error) {
      // Bookkeeping must never break an upload or a scan; the next scan reschedules.
      this.log.error(error, `cannot schedule book ${book.id} for indexing`);
    }
  }

  reindex(bookId: string): IndexState {
    if (!this.options.enabled) throw new IndexingDisabledError("Indexing is disabled");
    const book = this.books.get(bookId);
    if (!book) throw new NotFoundError("Book not found");
    if (book.status !== "ready") throw new ConflictError("Book metadata is not ready");
    const current = this.indexes.get(bookId);
    if (current && (current.state === "pending" || current.state === "indexing")) return current.state;
    this.forcedLexical.delete(bookId);
    this.indexes.upsertPending({
      bookId,
      priority: 1,
      fingerprint: fingerprintOf(book.size, book.mtime),
      now: this.clock.now(),
      resetAttempts: true,
    });
    this.kick();
    return "pending";
  }

  reindexAll(scope: "failed" | "all"): number {
    if (!this.options.enabled) throw new IndexingDisabledError("Indexing is disabled");
    const now = this.clock.now();
    let queued = 0;
    if (scope === "all") {
      this.forcedLexical.clear();
      const unindexed = this.indexes.unindexedReadyBookIds();
      const books = new Map(this.books.list().map((book) => [book.id, book]));
      const items: PendingIndexUpsert[] = [];
      for (const bookId of unindexed) {
        const book = books.get(bookId);
        if (!book) continue;
        items.push({
          bookId,
          priority: 1,
          fingerprint: fingerprintOf(book.size, book.mtime),
          now,
          resetAttempts: true,
        });
      }
      this.upsertBlocks(items);
      queued += items.length;
    }
    queued += this.indexes.requeue(scope, now);
    this.kick();
    return queued;
  }

  /** Enqueues a selection at priority 1 (demand), independently of the automatic-vector cap. */
  enqueue(bookIds: string[], vectors = true): EnqueueResult {
    if (!this.options.enabled) throw new IndexingDisabledError("Indexing is disabled");
    const now = this.clock.now();
    const items: PendingIndexUpsert[] = [];
    let skipped = 0;
    for (const bookId of new Set(bookIds)) {
      const book = this.books.get(bookId);
      if (!book || book.status !== "ready") {
        skipped++;
        continue;
      }
      if (vectors) this.forcedLexical.delete(bookId);
      else this.forcedLexical.add(bookId);
      items.push({
        bookId,
        priority: 1,
        fingerprint: fingerprintOf(book.size, book.mtime),
        now,
        resetAttempts: true,
      });
    }
    this.upsertBlocks(items);
    this.kick();
    return { queued: items.length, skipped };
  }

  pause(): boolean {
    this.paused = true;
    this.options.settings?.set({ [PAUSE_KEY]: "1" });
    return true;
  }

  resume(): boolean {
    this.paused = false;
    this.options.settings?.delete([PAUSE_KEY]);
    this.kick();
    return false;
  }

  statesFor(bookIds: string[]): Map<string, BookIndex> {
    return this.indexes.statesFor(bookIds);
  }

  status(): IndexingStatus {
    const embeddings = this.runner.embeddings();
    const counts = this.indexes.counts();
    const rate = this.rateEma === null ? null : Math.round(this.rateEma * 10) / 10;
    const remaining = counts.pending + counts.indexing;
    const average = this.indexes.averageChunkCount();
    const etaSec = rate !== null && rate > 0 && average !== null && remaining > 0
      ? Math.ceil((remaining * average) / rate)
      : null;
    const maxBooks = this.options.vectorsMaxBooks ?? DEFAULT_VECTORS_MAX_BOOKS;
    return {
      enabled: this.options.enabled,
      search: {
        semantic: this.options.enabled && embeddings.mode !== "none" && embeddings.state === "ready",
        embeddings: embeddings.mode,
        model: embeddings.model,
        state: embeddings.state,
      },
      counts,
      current: this.currentJob(),
      revision: this.indexes.revision(),
      paused: this.paused,
      rate,
      etaSec,
      workers: this.workerCount(),
      vectors: { mode: maxBooks > 0 ? "auto" : "demand", maxBooks },
    };
  }

  /** Enqueues existing books that were never indexed or were indexed by another version. */
  reconcile(): number {
    const items = this.reconcileItems();
    this.upsertBlocks(items);
    if (items.length) this.kick();
    return items.length;
  }

  /**
   * Production path used by start()/recovery: the same blocks, but yields between them so a
   * boot over 11k books never blocks the event loop for the whole reconciliation.
   */
  private async reconcileInBackground(): Promise<number> {
    const items = this.reconcileItems();
    await this.upsertBlocksAsync(items);
    if (items.length) this.kick();
    return items.length;
  }

  private reconcileItems(): PendingIndexUpsert[] {
    if (!this.options.enabled) return [];
    if (this.options.backfill === "off") return [];
    // Sending a whole library to an external provider must be an explicit operator choice.
    // A degraded book was ingested without vectors while the provider was down, so retrying it
    // after recovery is implicit consent.
    const httpAuto = this.options.backfill === "auto" && this.runner.embeddings().mode === "http";
    const now = this.clock.now();
    const version = this.runner.indexVersion();
    const unindexed = httpAuto ? [] : this.indexes.unindexedReadyBookIds();
    const stale = this.indexes.staleIds(version);
    const items: PendingIndexUpsert[] = [];
    if (unindexed.length === 0 && stale.length === 0) return items;
    const books = new Map(this.books.list().map((book) => [book.id, book]));
    for (const bookId of unindexed) {
      const book = books.get(bookId);
      if (!book) continue;
      items.push({ bookId, priority: 0, fingerprint: fingerprintOf(book.size, book.mtime), now, resetAttempts: false });
    }
    for (const bookId of stale) {
      if (httpAuto && !this.degraded.has(bookId)) continue;
      const book = books.get(bookId);
      if (!book || book.status !== "ready") continue;
      items.push({ bookId, priority: 0, fingerprint: fingerprintOf(book.size, book.mtime), now, resetAttempts: false });
    }
    return items;
  }

  start(): void {
    if (!this.options.enabled || this.running) return;
    this.running = true;
    if (this.options.settings) this.paused = this.options.settings.get(PAUSE_KEY) === "1";
    const resumed = this.indexes.resetInterrupted();
    if (resumed) this.log.info(`resumed ${resumed} interrupted index job(s)`);
    this.startLoopMonitor();
    this.runner.onEmbeddingsReady(() => {
      if (!this.running) return;
      this.requestReconcile();
    });
    void this.reconcileInBackground().catch((error: unknown) => this.log.error(error, "index reconciliation failed"));
    this.kick();
  }

  stop(): void {
    this.running = false;
    this.reconcilePending = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopLoopMonitor();
  }

  /** Wakes the queue after external changes (new upload, manual reindex). */
  kick(): void {
    if (!this.running || !this.options.enabled || this.paused) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pumping) return;
    this.pumping = true;
    void this.pump()
      .catch((error: unknown) => this.log.error(error, "indexing queue failed"))
      .finally(() => {
        this.pumping = false;
        this.armTimer();
      });
  }

  private async pump(): Promise<void> {
    const workers = Array.from({ length: Math.max(1, this.options.concurrency) }, () => this.worker());
    await Promise.all(workers);
  }

  private async worker(): Promise<void> {
    for (;;) {
      if (!this.running || !this.options.enabled || this.paused) return;
      await this.waitForCapacity();
      if (!this.running || this.paused) return;
      const job = this.indexes.claimNext(this.clock.now());
      if (!job) return;
      await this.execute(job);
    }
  }

  private async execute(job: BookIndex): Promise<void> {
    const book = this.books.get(job.bookId);
    if (!book) return;
    if (book.status === "error") {
      // A book whose metadata cannot be read is not indexable; record a terminal row so the
      // queue stops claiming it, and drop any text from a previous version of the file.
      this.log.debug?.(`index job skipped book=${job.bookId} reason=unreadable`);
      if (this.owns(job)) {
        this.indexes.save({
          ...withoutIndex(job),
          state: "error",
          nextAttemptAt: 0,
          startedAt: null,
          finishedAt: this.clock.now(),
          error: { code: "unreadable", message: "Book metadata could not be extracted" },
        });
        this.passages.clear(job.bookId);
      }
      return;
    }
    if (book.status !== "ready") {
      this.log.debug?.(`index job deferred book=${job.bookId} reason=metadata_not_ready`);
      this.defer(job);
      return;
    }
    if (book.size > this.options.maxBytes) {
      this.log.debug?.(`index job skipped book=${job.bookId} reason=too_large`);
      if (this.owns(job)) {
        this.indexes.save(failure(withoutIndex(job), "too_large", `Book is larger than ${Math.floor(this.options.maxBytes / (1024 * 1024))} MB`, this.clock.now()));
        this.passages.clear(job.bookId);
      }
      return;
    }
    this.active.set(job.bookId, null);
    const capturedVersion = this.runner.indexVersion();
    const allowVectors = this.vectorsAllowed(job);
    const version = allowVectors ? capturedVersion : toLexicalVersion(capturedVersion);
    const started = Date.now();
    // Book id, format and shape only: never the book text or a path.
    this.log.debug?.(`index job start book=${job.bookId} format=${book.format} vectors=${allowVectors}`);
    let current = job;
    let discarded = false;
    const sink = {
      onStart: (): void => {
        if (!this.owns(job)) return;
        // onStart means the runner is about to replace the stored chunks. Persist the invalidation
        // before touching them: from here on the book has no complete index, so a crash, a failure
        // or a retry can never reuse this run's hash as if the ingestion had finished.
        current = withoutIndex(current);
        this.indexes.save(current);
        this.passages.clear(job.bookId);
        discarded = true;
      },
      onBatch: async (batch: IngestBatch): Promise<void> => {
        if (!this.owns(job)) throw new JobAbandonedError("Book was removed or requeued during ingestion");
        this.passages.append(
          job.bookId,
          batch.passages.map((passage, index) => ({ passage, vector: batch.vectors?.[index] ?? null })),
        );
        this.notePassages(batch.passages.length);
      },
      onProgress: (fraction: number): void => {
        if (this.active.has(job.bookId)) this.active.set(job.bookId, Math.max(0, Math.min(1, fraction)));
      },
    };
    try {
      const outcome: IngestOutcome = await this.runner.run(
        {
          bookId: job.bookId,
          path: book.path,
          format: book.format,
          // A manual reindex clears contentHash, which disables the unchanged fast path.
          knownHash: job.indexVersion === version ? job.contentHash : null,
          indexVersion: version,
          vectors: allowVectors,
        },
        sink,
      );
      // Shutdown discards the outcome; the row stays indexing and resetInterrupted() resumes it.
      if (!this.running || !this.owns(job)) return;
      // The runner discarded the old chunks before reporting unchanged; its hash cannot describe
      // a complete index. Fail this attempt and retry from scratch instead of promoting partial data.
      if (discarded && outcome.kind === "unchanged") {
        throw Object.assign(new Error("Runner reported unchanged after discarding the stored index"), { code: "unknown" });
      }
      const now = this.clock.now();
      // The runner reports the version the stored content actually satisfies; the one captured
      // before run() may describe vectors that were never produced (provider down mid-job).
      current = outcome.kind === "unchanged"
        ? unchanged(current, { contentHash: outcome.contentHash, indexVersion: outcome.indexVersion }, now)
        : ready(current, { contentHash: outcome.contentHash, indexVersion: outcome.indexVersion, chunkCount: outcome.chunkCount }, now);
      this.indexes.save(current);
      this.trackVersion(job.bookId, outcome.indexVersion);
      const chunks = outcome.kind === "done" ? outcome.chunkCount : null;
      this.log.debug?.(
        `index job done book=${job.bookId} state=${outcome.kind} chunks=${chunks ?? 0} `
        + `durationMs=${Date.now() - started}`,
      );
    } catch (error) {
      if (!this.running || !this.owns(job)) return;
      const { code, message } = describeFailure(error);
      this.log.debug?.(`index job failed book=${job.bookId} code=${code} durationMs=${Date.now() - started}`);
      // Terminal content errors must not leave stale text searchable. Once onStart discarded the
      // previous chunks there is no complete index to fall back to, so a mid-run failure also
      // clears the partial batches. Failures before onStart keep the previous index intact so a
      // temporarily offline SMB share does not wipe search.
      const clearsChunks = code === "no_text" || code === "too_large" || discarded;
      // Dropping the chunks also drops the only proof that the stored hash is complete. Persist
      // the invalidation first so a crash between both writes cannot leave a complete-looking hash.
      this.indexes.save(failure(clearsChunks ? withoutIndex(current) : current, code, message, this.clock.now()));
      if (clearsChunks) this.passages.clear(job.bookId);
    } finally {
      this.active.delete(job.bookId);
      this.forcedLexical.delete(job.bookId);
      this.flushRate();
      this.checkpointAfterBook();
      this.flushPendingReconcile();
    }
  }

  private defer(job: BookIndex): void {
    if (!this.owns(job)) return;
    this.indexes.save({ ...job, state: "pending", startedAt: null, nextAttemptAt: this.clock.now() + RETRY_DELAYS_MS[0] });
  }

  /**
   * Automatic vectors are limited to books whose stored index already has them; jobs the user
   * requested (uploads, manual reindex, enqueue) always run with vectors. A lexical book stays
   * lexical even when an embedder appears later (ADR-C1); "Reindex all" upgrades it on demand.
   */
  private vectorsAllowed(job: BookIndex): boolean {
    if (this.runner.embeddings().mode === "none") return false;
    if (this.forcedLexical.has(job.bookId)) return false;
    if (job.priority === 1) return true;
    // Never drop a book out of the vector tier just because it is being reindexed at the cap:
    // the stored version is the proof that it already occupies one of the budgeted slots.
    if (isVectorVersion(job.indexVersion)) return true;
    const maxBooks = this.options.vectorsMaxBooks ?? DEFAULT_VECTORS_MAX_BOOKS;
    return maxBooks > 0 && this.indexes.vectorBookCount() < maxBooks;
  }

  private acceptsVersion(stored: string | null): boolean {
    const current = this.runner.indexVersion();
    if (stored === current) return true;
    // Lexical-by-choice content is not upgraded just because an embedder becomes available.
    if (isLexicalVersion(stored) && !isLexicalVersion(current)) return true;
    // A provider outage (`|none`) must not erase a complete vector index; recovery reconciles
    // degraded content, and a real model change still makes vector versions stale.
    return isDegradedVersion(current) && isVectorVersion(stored);
  }

  /**
   * Keeps the fallback set consumed by reconcile() in http+auto mode. The set only gates
   * reindexing already-tried books; it never drives a retry on its own. The suffix `|none` is
   * what the pipeline writes when it could not attach vectors, so it describes the stored
   * content regardless of which version the job expected to produce.
   */
  private trackVersion(bookId: string, produced: string): void {
    if (this.runner.embeddings().mode !== "none" && isDegradedVersion(produced)) this.degraded.add(bookId);
    else this.degraded.delete(bookId);
  }

  /**
   * A recovered embedder may only be reconciled between jobs: the running job has not persisted
   * the version it actually produced (or its degraded transition) yet. Wait for it to finish.
   */
  private requestReconcile(): void {
    if (this.active.size > 0) {
      this.reconcilePending = true;
      return;
    }
    void this.reconcileInBackground().catch((error: unknown) => this.log.error(error, "index reconciliation failed"));
    this.kick();
  }

  private flushPendingReconcile(): void {
    if (!this.reconcilePending || !this.running || this.active.size > 0) return;
    this.reconcilePending = false;
    void this.reconcileInBackground().catch((error: unknown) => this.log.error(error, "index reconciliation failed"));
    this.kick();
  }

  private owns(job: BookIndex): boolean {
    const current = this.indexes.get(job.bookId);
    return current?.state === "indexing" && current.startedAt === job.startedAt && current.requestedAt === job.requestedAt;
  }

  private currentJob(): { bookId: string; progress: number | null } | null {
    const entry = this.active.entries().next();
    if (entry.done) return null;
    const [bookId, progress] = entry.value;
    return { bookId, progress };
  }

  private armTimer(): void {
    if (!this.running || !this.options.enabled || this.paused || this.timer) return;
    const due = this.indexes.nextDueAt();
    if (due === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, due - this.clock.now()));
    this.timer.unref();
  }

  private upsertBlocks(items: PendingIndexUpsert[]): void {
    for (let offset = 0; offset < items.length; offset += RECONCILE_BLOCK) {
      this.indexes.upsertPendingMany(items.slice(offset, offset + RECONCILE_BLOCK));
    }
  }

  private async upsertBlocksAsync(items: PendingIndexUpsert[]): Promise<void> {
    for (let offset = 0; offset < items.length; offset += RECONCILE_BLOCK) {
      if (!this.running) return;
      this.indexes.upsertPendingMany(items.slice(offset, offset + RECONCILE_BLOCK));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private workerCount(): number {
    return Math.max(1, this.options.workers ?? this.options.concurrency);
  }

  private notePassages(count: number): void {
    const now = this.clock.now();
    if (this.rateStartedAt === null) this.rateStartedAt = now;
    this.ratePassages += count;
    const elapsed = now - this.rateStartedAt;
    if (elapsed < RATE_SAMPLE_MS) return;
    this.applyRate(elapsed);
  }

  private flushRate(): void {
    if (this.ratePassages === 0 || this.rateStartedAt === null) return;
    this.applyRate(Math.max(1, this.clock.now() - this.rateStartedAt));
  }

  private applyRate(elapsedMs: number): void {
    const instant = (this.ratePassages * 1_000) / elapsedMs;
    const alpha = 1 - Math.exp(-elapsedMs / RATE_WINDOW_MS);
    this.rateEma = this.rateEma === null ? instant : this.rateEma + alpha * (instant - this.rateEma);
    this.ratePassages = 0;
    this.rateStartedAt = this.clock.now();
  }

  private checkpointAfterBook(): void {
    this.completedSinceCheckpoint += 1;
    if (this.completedSinceCheckpoint < WAL_CHECKPOINT_BOOKS) return;
    this.completedSinceCheckpoint = 0;
    try {
      this.indexes.walCheckpoint();
    } catch (error) {
      this.log.error(error, "WAL checkpoint after indexing failed");
    }
  }

  private startLoopMonitor(): void {
    const backpressure = this.options.backpressure;
    if (!backpressure?.enabled || backpressure.p99) return;
    this.loopMonitor = monitorEventLoopDelay({ resolution: 10 });
    this.loopMonitor.enable();
    this.loopSampler = setInterval(() => {
      this.loopP99 = (this.loopMonitor?.percentile(99) ?? 0) / 1e6;
    }, 1_000);
    this.loopSampler.unref();
  }

  private stopLoopMonitor(): void {
    if (this.loopSampler) {
      clearInterval(this.loopSampler);
      this.loopSampler = null;
    }
    if (this.loopMonitor) {
      this.loopMonitor.disable();
      this.loopMonitor = null;
    }
    this.loopP99 = 0;
  }

  private eventLoopP99(): number {
    return this.options.backpressure?.p99?.() ?? this.loopP99;
  }

  /**
   * ADR-C2 backpressure: hold new claims while the event loop p99 is above the threshold so
   * ingestion cannot starve HTTP handlers during a backfill.
   */
  private async waitForCapacity(): Promise<void> {
    const backpressure = this.options.backpressure;
    if (!backpressure?.enabled) return;
    const maxP99 = backpressure.maxP99Ms ?? 100;
    const holdMs = backpressure.holdMs ?? 250;
    while (this.running && !this.paused && this.eventLoopP99() > maxP99) {
      await new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, holdMs);
        handle.unref();
      });
    }
  }
}

export function fingerprintOf(size: number, mtime: number | null): string {
  return `${size}:${mtime ?? ""}`;
}

/**
 * Drops the bookkeeping that proves a complete index exists. Call it before or when the stored
 * chunks are discarded: a content hash left behind without its chunks would let a retry mistake
 * a partial ingestion for a finished one.
 */
function withoutIndex(index: BookIndex): BookIndex {
  return { ...index, contentHash: null, indexVersion: null, chunkCount: 0 };
}

function describeFailure(error: unknown): { code: IndexErrorCode; message: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === "string" && ERROR_CODES.includes(candidate.code as IndexErrorCode)
      ? candidate.code as IndexErrorCode
      : "unknown";
    return { code, message: typeof candidate.message === "string" ? candidate.message : "Ingestion failed" };
  }
  return { code: "unknown", message: typeof error === "string" ? error : "Ingestion failed" };
}
