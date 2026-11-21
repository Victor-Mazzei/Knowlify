import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Book, Extracted, MetadataExtractor } from "../../ports/index.js";
import { extractEpub, extractPdf } from "./metadata.js";

/** Cover bytes travel as a transferable ArrayBuffer, not as a cloned Buffer. */
export interface WorkerCover { data: Uint8Array; ext: string }
export interface WorkerMetadata { title?: string; author?: string; cover?: WorkerCover }

export type MetadataWorkerRequest = {
  type: "extract";
  id: number;
  path: string;
  format: Book["format"];
};

export type MetadataWorkerResponse =
  | { type: "result"; id: number; metadata: WorkerMetadata }
  | { type: "failed"; id: number; message: string };

export interface MetadataWorkerPoolOptions {
  /** Number of worker threads. At least one is used when the pool is enabled. */
  workers: number;
  /** Per-task deadline; a timed-out worker is terminated and replaced (default 60 s). */
  timeoutMs?: number;
  /** Recycle a worker after this many PDF tasks to bound pdf.js/canvas native memory (0 disables it). EPUB extraction is pure JavaScript, so counting EPUB tasks would only churn workers. */
  maxTasksPerWorker?: number;
  /** Test seam: run an alternative worker entry point. */
  workerPath?: string;
  /** Run in the caller thread. Tests and hosts without worker support use it. */
  inline?: boolean;
  /** If the worker runtime cannot load the entry point, keep working in-process. */
  fallbackInline?: boolean;
  log?: (message: string, error?: unknown) => void;
}

interface Task {
  id: number;
  path: string;
  format: Book["format"];
  resolve: (metadata: Extracted) => void;
  reject: (error: unknown) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  /** PDF tasks completed by this thread; only native (pdf.js/canvas) work counts. */
  pdfTasks: number;
  timer: NodeJS.Timeout | null;
}

export class MetadataExtractionTimeoutError extends Error {
  readonly code = "timeout";

  constructor(path: string, timeoutMs: number) {
    super(`Metadata extraction timed out after ${timeoutMs} ms: ${path}`);
    this.name = "MetadataExtractionTimeoutError";
  }
}

/** Resolves the sibling worker entry point, preferring the format of this module. */
export function resolveMetadataWorkerPath(override?: string): string {
  if (override) return override;
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const preferred = import.meta.url.endsWith(".ts")
    ? ["metadata.worker.ts", "metadata.worker.js"]
    : ["metadata.worker.js", "metadata.worker.ts"];
  for (const name of preferred) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The metadata worker bundle is missing from the installation");
}

const formatFor = (path: string): Book["format"] => {
  const extension = path.toLowerCase().split(".").at(-1);
  if (extension === "pdf" || extension === "epub") return extension;
  throw new Error(`Unsupported metadata format: ${path}`);
};

const formatOf = (format: Book["format"]): ((path: string) => Promise<Extracted>) =>
  format === "epub" ? extractEpub : extractPdf;

const moduleLoadError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_FILE_EXTENSION";
};

/**
 * Runs metadata extraction in worker threads so pdf.js parsing and canvas
 * rendering never block the API (ADR-B2). A failed or timed-out task recycles
 * its worker; the next task gets a fresh thread. Recycling is counted per PDF
 * task (the only path that retains native pdf.js/canvas memory) so an EPUB
 * backfill does not pay for repeated worker startups (ADR-B2, plan R3).
 */
export class WorkerPoolMetadataExtractor implements MetadataExtractor {
  private readonly workerCount: number;
  private readonly timeoutMs: number;
  private readonly maxTasksPerWorker: number;
  private readonly workerPath: string | null;
  private readonly fallbackInline: boolean;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly queue: Task[] = [];
  private readonly slots: Slot[] = [];
  private inline: boolean;
  private closed = false;
  private draining = false;
  private nextId = 0;

  constructor(options: MetadataWorkerPoolOptions) {
    this.workerCount = Math.max(1, Math.floor(options.workers));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxTasksPerWorker = options.maxTasksPerWorker ?? 1000;
    this.workerPath = options.workerPath ?? null;
    this.inline = options.inline === true;
    this.fallbackInline = options.fallbackInline !== false;
    this.log = options.log ?? (() => {});
  }

  /** Facade for the Scanner/Library map, which is keyed by book format. */
  forFormat(format: Book["format"]): MetadataExtractor {
    return { extract: (path) => this.extract(path, format) };
  }

  async extract(path: string, format: Book["format"] = formatFor(path)): Promise<Extracted> {
    if (this.inline) return formatOf(format)(path);
    if (this.closed) throw new Error("Metadata extractor is closed");
    return new Promise<Extracted>((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, path, format, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("Metadata extractor is closed");
    for (const task of this.queue.splice(0)) task.reject(error);
    const slots = this.slots.splice(0);
    await Promise.all(slots.map(async (slot) => {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.task?.reject(error);
      slot.task = null;
      await slot.worker.terminate().catch(() => undefined);
    }));
  }

  private pump(): void {
    if (this.closed) return;
    if (this.inline) { this.drainInline(); return; }
    while (this.queue.length > 0 && this.slots.length < this.workerCount) {
      let slot: Slot;
      try {
        slot = this.spawn();
      } catch (error) {
        if (!this.fallbackInline) {
          const task = this.queue.shift();
          task?.reject(error);
          continue;
        }
        this.log("metadata workers are unavailable; extracting in the main thread", error);
        this.inline = true;
        this.drainInline();
        return;
      }
      this.slots.push(slot);
    }
    for (const slot of this.slots) {
      if (slot.task || this.queue.length === 0) continue;
      const task = this.queue.shift();
      if (task) this.assign(slot, task);
    }
  }

  private drainInline(): void {
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      try {
        while (this.queue.length > 0) {
          const task = this.queue.shift();
          if (!task) break;
          try {
            task.resolve(await formatOf(task.format)(task.path));
          } catch (error) {
            task.reject(error);
          }
        }
      } finally {
        this.draining = false;
      }
    })();
  }

  private spawn(): Slot {
    const path = this.workerPath ?? resolveMetadataWorkerPath();
    const worker = new Worker(path, {
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
      ...(path.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    const slot: Slot = { worker, task: null, pdfTasks: 0, timer: null };
    worker.on("message", (message: MetadataWorkerResponse) => this.onMessage(slot, message));
    worker.on("error", (error) => this.fail(slot, error));
    worker.on("exit", (code) => {
      if (!this.slots.includes(slot)) return;
      this.fail(slot, new Error(`Metadata worker exited with code ${code}`));
    });
    return slot;
  }

  private assign(slot: Slot, task: Task): void {
    slot.task = task;
    slot.timer = setTimeout(() => this.timeout(slot), this.timeoutMs);
    slot.timer.unref();
    try {
      slot.worker.postMessage({ type: "extract", id: task.id, path: task.path, format: task.format } satisfies MetadataWorkerRequest);
    } catch (error) {
      const failed = slot.task;
      slot.task = null;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      this.retire(slot);
      failed?.reject(error);
      this.pump();
    }
  }

  private onMessage(slot: Slot, message: MetadataWorkerResponse): void {
    const task = slot.task;
    if (!task || message.id !== task.id) return;
    slot.task = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (task.format === "pdf") slot.pdfTasks += 1;
    if (message.type === "failed") task.reject(new Error(message.message));
    else task.resolve(this.decode(message.metadata));
    if (this.maxTasksPerWorker > 0 && slot.pdfTasks >= this.maxTasksPerWorker) {
      this.retire(slot);
    }
    this.pump();
  }

  private timeout(slot: Slot): void {
    const task = slot.task;
    if (!task) return;
    slot.task = null;
    const error = new MetadataExtractionTimeoutError(task.path, this.timeoutMs);
    this.retire(slot);
    task.reject(error);
    this.pump();
  }

  private fail(slot: Slot, error: unknown): void {
    if (!this.slots.includes(slot)) return;
    const task = slot.task;
    slot.task = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    this.retire(slot);
    if (task && this.fallbackInline && moduleLoadError(error)) {
      this.log("metadata worker could not load its runtime; extracting in the main thread", error);
      this.inline = true;
      void formatOf(task.format)(task.path).then(task.resolve, task.reject);
      this.drainInline();
    } else {
      task?.reject(error);
    }
    this.pump();
  }

  /** Removes the slot and terminates its thread without touching the active task. */
  private retire(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    void slot.worker.terminate().catch(() => undefined);
  }

  private decode(metadata: WorkerMetadata): Extracted {
    const out: Extracted = {};
    if (metadata.title) out.title = metadata.title;
    if (metadata.author) out.author = metadata.author;
    if (metadata.cover) out.cover = { data: Buffer.from(metadata.cover.data), ext: metadata.cover.ext };
    return out;
  }
}
