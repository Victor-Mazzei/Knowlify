import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { IndexEpoch } from "../../ports/index-epoch.js";
import type {
  LexicalHit,
  LexicalQueryResult,
  PassageQueryStore,
  PassageView,
  ScoredPassage,
  VectorFilter,
} from "../../ports/knowledge.js";
import { safeErrorType } from "../logging/safeError.js";
import type { SearchWorkerRequest, SearchWorkerResponse } from "./protocol.js";

/** One query waits at most this long before the worker is discarded and the search degrades. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;

export interface SearchWorkerStoreOptions {
  /** SQLite file opened read-only by the worker; in-memory databases cannot be shared. */
  file: string;
  /** Per-request ceiling; a slower worker is terminated so the turn cannot hang. */
  timeoutMs?: number;
  /** Test seam: run an alternative worker entry point. */
  workerPath?: string;
  /**
   * Rotating sample offset sent with every vector query. Production passes the process
   * `IndexEpoch`; the worker must not derive it from SQLite `data_version`, which changes
   * on unrelated commits and would rotate the sample behind an unchanged cache key.
   */
  epoch?: IndexEpoch;
  /** Fixed messages and error types only; never query text or passages. */
  log?: (message: string, error?: unknown) => void;
  /**
   * The worker was discarded. A timeout may be disk thrash, so the warm-up controller
   * backs off when it sees one.
   */
  onDiscard?: (reason: "timeout" | "crash" | "exit") => void;
}

export class SearchWorkerError extends Error {}

export class SearchTimeoutError extends SearchWorkerError {}

interface Pending {
  kind: keyof WorkerResult;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
  stopping: boolean;
}

interface WorkerResult {
  lexical: LexicalQueryResult;
  hydrate: PassageView[];
  nearest: ScoredPassage[];
  "vector-count": number;
}

/** Resolves the sibling worker entry point, preferring the format of this module. */
function resolveWorkerPath(override?: string): string {
  if (override) return override;
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const preferred = import.meta.url.endsWith(".ts")
    ? ["search.worker.ts", "search.worker.js"]
    : ["search.worker.js", "search.worker.ts"];
  for (const name of preferred) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new SearchWorkerError("The search worker bundle is missing from the installation");
}

/**
 * Runs passage retrieval in a dedicated worker thread. FTS5 ranking scales with the size
 * of the index and the exact vector scan reads every stored vector, so both must stay off
 * the API event loop: a chat turn on a multi-million-chunk library used to freeze every
 * route (including `/health`) for seconds to minutes. Each request has a hard timeout;
 * a timed-out worker is terminated and the caller degrades instead of waiting forever.
 */
export class SearchWorkerStore implements PassageQueryStore {
  private slot: Slot | null = null;
  private nextId = 0;
  private closing = false;
  private readonly timeoutMs: number;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: SearchWorkerStoreOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    this.log = options.log ?? (() => {});
  }

  async searchLexical(q: string, limit: number, bookId?: string): Promise<LexicalHit[]> {
    return (await this.searchLexicalResult(q, limit, bookId)).hits;
  }

  searchLexicalResult(q: string, limit: number, bookId?: string): Promise<LexicalQueryResult> {
    return this.call("lexical", (id) => ({ type: "lexical", id, q, limit, ...(bookId ? { bookId } : {}) }));
  }

  hydrate(ids: number[]): Promise<PassageView[]> {
    return this.call("hydrate", (id) => ({ type: "hydrate", id, ids }));
  }

  nearest(query: Float32Array, limit: number, filter?: VectorFilter): Promise<ScoredPassage[]> {
    return this.call("nearest", (id) => ({
      type: "nearest",
      id,
      vector: query,
      limit,
      ...(filter ? { filter } : {}),
      epoch: this.options.epoch?.current() ?? 0,
    }));
  }

  vectorCount(): Promise<number> {
    return this.call("vector-count", (id) => ({ type: "vector-count", id }));
  }

  /** Terminates the worker; pending calls reject instead of holding a turn open. */
  async close(): Promise<void> {
    this.closing = true;
    const slot = this.slot;
    this.slot = null;
    if (!slot) return;
    slot.stopping = true;
    this.rejectAll(slot, new SearchWorkerError("The search worker was closed"));
    await new Promise<void>((resolve) => {
      slot.worker.once("exit", () => resolve());
      void slot.worker.terminate().then(() => resolve(), () => resolve());
    });
  }

  private call<K extends keyof WorkerResult>(
    kind: K,
    build: (id: number) => SearchWorkerRequest,
  ): Promise<WorkerResult[K]> {
    if (this.closing) return Promise.reject(new SearchWorkerError("The search worker was closed"));
    let slot: Slot;
    try {
      slot = this.ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.nextId;
    return new Promise<WorkerResult[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // One line, fixed shape: the operation and the ceiling, never the query text.
        this.log(`search worker timed out after ${this.timeoutMs} ms (${kind}); discarding the worker`);
        this.options.onDiscard?.("timeout");
        this.discard(slot, new SearchTimeoutError("The library search took too long"));
      }, this.timeoutMs);
      timer.unref();
      slot.pending.set(id, { kind, resolve: (value) => resolve(value as WorkerResult[K]), reject, timer });
      try {
        slot.worker.postMessage(build(id));
      } catch (error) {
        clearTimeout(timer);
        slot.pending.delete(id);
        reject(error instanceof Error ? error : new SearchWorkerError("The search worker is unavailable"));
      }
    });
  }

  private ensureWorker(): Slot {
    if (this.slot) return this.slot;
    const path = resolveWorkerPath(this.options.workerPath);
    const worker = new Worker(path, {
      workerData: { file: this.options.file, timeoutMs: this.timeoutMs },
      ...(path.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    const slot: Slot = { worker, pending: new Map(), stopping: false };
    this.slot = slot;
    worker.on("message", (message: SearchWorkerResponse) => {
      const pending = slot.pending.get(message.id);
      if (!pending) return;
      slot.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "error") {
        pending.reject(new SearchWorkerError(`The search worker failed (${message.errorType})`));
        return;
      }
      if (message.type !== pending.kind) {
        pending.reject(new SearchWorkerError("The search worker sent an unexpected reply"));
        return;
      }
      const result = message.type === "lexical"
        ? { hits: message.hits, complete: message.complete ?? false }
        : message.type === "hydrate"
          ? message.views
          : message.type === "nearest"
            ? message.hits
            : message.count;
      pending.resolve(result);
    });
    worker.on("error", (error) => {
      this.log("search worker crashed", error);
      this.options.onDiscard?.("crash");
      this.discard(slot, new SearchWorkerError(`The search worker crashed (${safeErrorType(error)})`));
    });
    worker.on("exit", (code) => {
      if (slot.stopping || this.closing) return;
      this.log(`search worker exited with code ${code}`);
      this.options.onDiscard?.("exit");
      this.discard(slot, new SearchWorkerError("The search worker stopped"));
    });
    return slot;
  }

  private discard(slot: Slot, error: unknown): void {
    if (this.slot !== slot) return;
    this.slot = null;
    slot.stopping = true;
    this.rejectAll(slot, error);
    void slot.worker.terminate().catch(() => {});
  }

  private rejectAll(slot: Slot, error: unknown): void {
    const pending = [...slot.pending.values()];
    slot.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }
}
