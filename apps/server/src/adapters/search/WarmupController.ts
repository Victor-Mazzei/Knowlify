import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger } from "../../ports/index.js";
import type { KeyValueStore } from "../../ports/knowledge.js";
import { safeErrorType } from "../logging/safeError.js";
import type { MemoryProfile } from "../runtime/memoryProfile.js";
import type { WarmupRequest, WarmupResponse } from "./warmup.worker.js";

const MB = 1024 * 1024;

/** A small index is cheap to read cold; warming it buys nothing (ADR-2). */
export const WARMUP_MIN_FILE_BYTES = 128 * MB;
/** Below this estimated working set the cold cost is irrelevant. */
export const WARMUP_MIN_HOT_BYTES = 48 * MB;
/** With less usable memory than this the safe answer is not to read at all. */
export const WARMUP_MIN_CACHEABLE_BYTES = 128 * MB;
/** At or below this effective memory limit the small-machine criterion is zero reads. */
export const WARMUP_SMALL_MACHINE_LIMIT_BYTES = 1024 * MB;
/** A shared machine (no cgroup limit) only warms with memory to spare. */
export const WARMUP_DESKTOP_MIN_CACHEABLE_BYTES = 512 * MB;
/** A partial pass competes with queries, so it is only worth it on a roomy machine. */
export const WARMUP_PARTIAL_MIN_CACHEABLE_BYTES = 1024 * MB;
export const WARMUP_PARTIAL_MIN_BYTES = 8 * MB;
/** The full working set must leave a third of the budget free. */
export const WARMUP_FULL_FRACTION = 0.7;
/** Conservative working-set estimate until a full pass measures it (0.35 × file). */
export const WARMUP_HOT_FRACTION = 0.35;
/** `idx` + `docsize` are about 15 MB per million chunks ≈ 0.0075 × file. */
export const WARMUP_PARTIAL_FRACTION = 0.0075;
export const WARMUP_TABLES_FULL = ["chunks_fts_idx", "chunks_fts_docsize", "chunks_fts_data"] as const;
export const WARMUP_TABLES_PARTIAL = ["chunks_fts_idx", "chunks_fts_docsize"] as const;
/** Calibration persisted after a full pass; derived and disposable. */
export const WARMUP_HOT_BYTES_KEY = "search.warm.hotBytes";

const TICK_MS = 1_000;
const QUIET_MS = 5_000;
const AUTO_DELAY_MS = 2_000;
const ON_DELAY_MS = 60_000;
const SEARCH_COOLDOWN_MS = 5 * 60_000;
const MEMORY_RETRY_MS = 10 * 60_000;
const RESTART_COOLDOWN_MS = 10 * 60_000;
const MAX_RESTARTS = 3;
const DEFAULT_SLICE_BYTES = MB;
/** Re-warm only after the index grew this much and the system has been quiet. */
const GROWTH_FRACTION = 1.1;
const GROWTH_QUIET_MS = 10 * 60_000;

export type WarmupMode = "auto" | "on" | "off";
export type WarmupState = "off" | "idle" | "waiting" | "warming" | "warm" | "paused";
export type WarmupReason =
  | "disabled"
  | "small-index"
  | "low-memory"
  | "over-budget"
  | "memory-pressure"
  | "activity"
  | "cooldown";
export type WarmupScope = "full" | "partial";

export interface WarmupStatus {
  mode: WarmupMode;
  state: WarmupState;
  reason?: WarmupReason;
  scope?: WarmupScope;
  warmedMB: number;
  targetMB: number;
  finishedAt?: number;
}

/** The additive `retrieval` field of `GET /api/index/status` (frozen contract). */
export interface RetrievalStatus {
  memory: { limitMB: number; budgetMB: number };
  warmup: WarmupStatus;
  cache: {
    enabled: boolean;
    entries: number;
    maxEntries: number;
    usedKB: number;
    maxKB: number;
    hits: number;
    misses: number;
  };
}

export interface WarmupPlanInput {
  mode: WarmupMode;
  enabled: boolean;
  /** No cgroup limit: a desktop or a bare-metal server shares the machine. */
  desktop: boolean;
  fileBytes: number;
  /** Measured working set from a previous full pass; 0 estimates it. */
  hotBytes: number;
  /** Effective process limit (`MemoryProfile.limitBytes()`), before the operator cap. */
  limitBytes: number;
  /** Already capped by `KNOWLIFY_SEARCH_WARMUP_MAX_MB`. */
  cacheableBytes: number;
}

export interface WarmupPlan {
  start: boolean;
  reason?: WarmupReason;
  scope?: WarmupScope;
  targetBytes: number;
}

/**
 * The whole memory/index policy, pure so it can be tested as a table. `auto` follows the
 * conservative rows of ADR-2; `on` only relaxes the trigger and the small-working-set
 * floor, never the memory guards. A partial pass is skipped below a 1 GiB budget: reading
 * a few megabytes of metadata there competes with the first queries and the plan's
 * small-machine criterion is zero warm reads. The effective limit guard enforces that
 * criterion on 512 MB and 1 GiB machines, where the budget formula alone can leave room
 * for a full pass even in `on`.
 */
export function planWarmup(input: WarmupPlanInput): WarmupPlan {
  if (input.mode === "off") return { start: false, targetBytes: 0 };
  if (!input.enabled) return { start: false, reason: "disabled", targetBytes: 0 };
  if (input.fileBytes < WARMUP_MIN_FILE_BYTES) return { start: false, reason: "small-index", targetBytes: 0 };
  const hot = input.hotBytes > 0
    ? Math.min(input.hotBytes, input.fileBytes)
    : input.fileBytes * WARMUP_HOT_FRACTION;
  if (input.mode !== "on" && hot < WARMUP_MIN_HOT_BYTES) return { start: false, reason: "small-index", targetBytes: 0 };
  if (input.limitBytes <= WARMUP_SMALL_MACHINE_LIMIT_BYTES) {
    return { start: false, reason: "low-memory", targetBytes: 0 };
  }
  if (input.cacheableBytes < WARMUP_MIN_CACHEABLE_BYTES) return { start: false, reason: "low-memory", targetBytes: 0 };
  if (input.mode === "auto" && input.desktop && input.cacheableBytes < WARMUP_DESKTOP_MIN_CACHEABLE_BYTES) {
    return { start: false, reason: "low-memory", targetBytes: 0 };
  }
  if (hot <= input.cacheableBytes * WARMUP_FULL_FRACTION) {
    return { start: true, scope: "full", targetBytes: Math.floor(hot) };
  }
  const partial = Math.floor(Math.min(hot, input.fileBytes * WARMUP_PARTIAL_FRACTION));
  if (input.cacheableBytes < WARMUP_PARTIAL_MIN_CACHEABLE_BYTES || partial < WARMUP_PARTIAL_MIN_BYTES) {
    return { start: false, reason: "over-budget", targetBytes: 0 };
  }
  return { start: true, scope: "partial", reason: "over-budget", targetBytes: partial };
}

/**
 * Slice rate by effective memory (ADR-2). A shared machine is capped at the 4 GiB band:
 * on a laptop the warm-up must stay a background trickle that does not drain the battery.
 */
export function warmupRateBytesPerSec(limitBytes: number, desktop: boolean): number {
  const band = limitBytes <= 1024 * MB ? 16 * MB : limitBytes <= 4 * 1024 * MB ? 48 * MB : 128 * MB;
  return desktop ? Math.min(band, 48 * MB) : band;
}

export interface WarmupControllerOptions {
  mode: WarmupMode;
  /** Database file; `null` for an in-memory database, which no worker can share. */
  file: string | null;
  /** Indexing and search are both available. */
  enabled: boolean;
  profile: MemoryProfile;
  /** `KNOWLIFY_SEARCH_WARMUP_MAX_MB`; `null` derives the budget from memory. */
  maxMb?: number | null;
  /** Chat streams, ingestion jobs and folder scans in flight. */
  isBusy?: () => boolean;
  settings?: KeyValueStore;
  log?: Logger;
  now?: () => number;
  /** Test seams: worker entry point, file size, slice size and rate. */
  workerPath?: string;
  fileBytes?: () => number;
  sliceBytes?: number;
  rateBytesPerSec?: (limitBytes: number) => number;
  plan?: (input: WarmupPlanInput) => WarmupPlan;
}

/**
 * Owns the warm-up state in the main process: trigger, policy, pause/resume, memory guard
 * and status. The worker only reads slices; every decision and every counter lives here,
 * so `GET /api/index/status` never touches the disk or the query worker.
 *
 * Triggers: `auto` waits two seconds after the first completed search and only starts
 * when everything has been quiet for five seconds; `on` waits sixty seconds after the
 * server starts listening. Warming is idempotent, pausable within one slice and fully
 * cancelled by `close()`.
 */
export class WarmupController {
  private readonly mode: WarmupMode;
  private readonly file: string | null;
  private readonly enabled: boolean;
  private readonly profile: MemoryProfile;
  private readonly capBytes: number;
  private readonly isBusy: () => boolean;
  private readonly settings?: KeyValueStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly workerPath?: string;
  private readonly fileBytesOf: () => number;
  private readonly sliceBytes: number;
  private readonly rateOf: (limitBytes: number) => number;
  private readonly planOf: (input: WarmupPlanInput) => WarmupPlan;

  private state: WarmupState;
  private reason?: WarmupReason;
  private scope?: WarmupScope;
  private targetBytes = 0;
  private warmedBytes = 0;
  private finishedAt?: number;
  private hotBytes = 0;
  private lastFileBytes = 0;
  private memory: { limitBytes: number; budgetBytes: number };
  private worker: Worker | null = null;
  private sliceTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private sliceId = 0;
  private sliceStartedAt = 0;
  private backoff = 1;
  private activeSearches = 0;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private lastBusyAt = Number.NEGATIVE_INFINITY;
  private firstQueryAt: number | null = null;
  private listenAt: number | null = null;
  private retryAt = 0;
  private cooldownUntil = 0;
  private restarts = 0;
  private started = false;
  private closed = false;

  constructor(options: WarmupControllerOptions) {
    this.mode = options.maxMb === 0 ? "off" : options.mode;
    this.file = options.file;
    this.enabled = options.enabled;
    this.profile = options.profile;
    this.capBytes = options.maxMb === null || options.maxMb === undefined ? Number.POSITIVE_INFINITY : options.maxMb * MB;
    this.isBusy = options.isBusy ?? (() => false);
    this.settings = options.settings;
    this.log = options.log ?? { info: () => {}, error: () => {}, warn: () => {} };
    this.now = options.now ?? Date.now;
    this.workerPath = options.workerPath;
    this.fileBytesOf = options.fileBytes ?? (() => this.statFileBytes());
    this.sliceBytes = Math.max(4096, options.sliceBytes ?? DEFAULT_SLICE_BYTES);
    this.rateOf = options.rateBytesPerSec ?? ((limit) => warmupRateBytesPerSec(limit, this.desktop()));
    this.planOf = options.plan ?? planWarmup;
    this.hotBytes = this.readHotBytes();
    this.memory = this.snapshotMemory();
    this.state = this.file === null || !this.enabled || this.mode === "off" ? "off" : "idle";
    if (this.state === "off" && (this.file === null || !this.enabled)) this.reason = "disabled";
  }

  /** Starts the one-second scheduler; also marks the listening moment for `on`. */
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    if (this.listenAt === null) this.listenAt = this.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref();
    this.tick();
  }

  /** A search begins: abort warming before the query reaches the worker. */
  noteSearchStart(): void {
    this.activeSearches += 1;
    this.lastActivityAt = this.now();
    if (this.state === "warming") this.pause("activity");
  }

  /** A search finished: this is the `auto` trigger, and quiet time starts now. */
  noteSearchEnd(): void {
    const now = this.now();
    this.activeSearches = Math.max(0, this.activeSearches - 1);
    this.lastActivityAt = now;
    if (this.firstQueryAt === null) this.firstQueryAt = now;
  }

  /** The query worker was discarded: a timeout may be thrash, so back off five minutes. */
  noteDiscard(): void {
    const now = this.now();
    this.cooldownUntil = now + SEARCH_COOLDOWN_MS;
    if (this.state === "warming") {
      this.pause("cooldown");
      this.retryAt = this.cooldownUntil;
    }
  }

  /** Scheduler step, also the test seam for time-based transitions. */
  tick(): void {
    if (this.closed) return;
    this.refreshMemory();
    const now = this.now();
    if (this.isBusy() || this.activeSearches > 0) this.lastBusyAt = now;
    if (this.state === "warming") {
      if (this.memoryPressure()) this.pause("memory-pressure");
      return;
    }
    this.evaluate(now);
  }

  /** In-memory only: the status route polls this, so it must not read anything. */
  status(): WarmupStatus {
    return {
      mode: this.mode,
      state: this.state,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.scope === undefined ? {} : { scope: this.scope }),
      warmedMB: Math.round(this.warmedBytes / MB),
      targetMB: Math.round(this.targetBytes / MB),
      ...(this.finishedAt === undefined ? {} : { finishedAt: this.finishedAt }),
    };
  }

  /** Cached memory snapshot, refreshed by the tick and each pass; no I/O on polling. */
  memoryStatus(): { limitMB: number; budgetMB: number } {
    return {
      limitMB: Math.round(this.memory.limitBytes / MB),
      budgetMB: Math.round(this.memory.budgetBytes / MB),
    };
  }

  /** Stops the scheduler and the worker; safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearSliceTimer();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.state = "off";
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1_000);
      timer.unref();
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      void worker.terminate().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  private evaluate(now: number): void {
    if (this.mode === "off") {
      this.applyOff();
      return;
    }
    if (!this.enabled) {
      this.applyOff("disabled");
      return;
    }
    const plan = this.planOf({
      mode: this.mode,
      enabled: this.enabled,
      desktop: this.desktop(),
      fileBytes: this.fileBytesOf(),
      hotBytes: this.hotBytes,
      limitBytes: this.memory.limitBytes,
      cacheableBytes: this.memory.budgetBytes,
    });
    if (!plan.start) {
      // A completed pass stays visible; only an idle/paused controller adopts the new verdict.
      if (this.state === "warm") return;
      this.applyOff(plan.reason);
      return;
    }
    if (!this.triggered(now)) {
      if (this.state !== "paused") this.setState("idle");
      return;
    }
    if (!this.quiet(now)) {
      // A running or completed pass is not downgraded just because a query is active.
      if (this.state === "idle" || this.state === "waiting") this.setState("waiting", "activity");
      return;
    }
    if (now < this.cooldownUntil || now < this.retryAt) {
      this.setState("paused", now < this.cooldownUntil ? "cooldown" : this.reason ?? "activity");
      return;
    }
    if (this.state === "warm" && !this.shouldRewarm(now)) return;
    this.beginPass(plan);
  }

  private triggered(now: number): boolean {
    if (this.mode === "on") return this.listenAt !== null && now - this.listenAt >= ON_DELAY_MS;
    if (this.mode === "off") return false;
    return this.firstQueryAt !== null && now - this.firstQueryAt >= AUTO_DELAY_MS;
  }

  private quiet(now: number): boolean {
    if (this.activeSearches > 0 || this.isBusy()) return false;
    return now - this.lastActivityAt >= QUIET_MS && now - this.lastBusyAt >= QUIET_MS;
  }

  private shouldRewarm(now: number): boolean {
    if (this.lastFileBytes <= 0) return false;
    if (this.fileBytesOf() <= this.lastFileBytes * GROWTH_FRACTION) return false;
    return now - Math.max(this.lastActivityAt, this.lastBusyAt) >= GROWTH_QUIET_MS;
  }

  private beginPass(plan: WarmupPlan): void {
    if (this.file === null || !plan.start) return;
    this.state = "warming";
    this.scope = plan.scope;
    this.reason = plan.scope === "partial" ? "over-budget" : undefined;
    this.targetBytes = plan.targetBytes;
    this.warmedBytes = 0;
    this.backoff = 1;
    this.retryAt = 0;
    try {
      const worker = this.ensureWorker();
      worker.postMessage({
        type: "open",
        file: this.file,
        tables: [...(plan.scope === "partial" ? WARMUP_TABLES_PARTIAL : WARMUP_TABLES_FULL)],
      } satisfies WarmupRequest);
    } catch (error) {
      this.log.warn?.(`search warm-up could not start (${safeErrorType(error)})`);
      this.stopWorker();
      this.state = "off";
      this.reason = "disabled";
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const path = this.resolveWorkerPath();
    const worker = new Worker(path, {
      ...(path.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    });
    worker.on("message", (message: WarmupResponse) => this.onMessage(message));
    worker.on("error", (error) => {
      if (this.closed) return;
      this.log.warn?.(`search warm-up worker failed (${safeErrorType(error)})`);
      this.failPass();
    });
    worker.on("exit", (code) => {
      if (this.closed || this.worker !== worker) return;
      this.log.warn?.(`search warm-up worker exited with code ${code}`);
      this.failPass();
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(message: WarmupResponse): void {
    if (this.closed || this.state !== "warming") return;
    switch (message.type) {
      case "opened":
        this.sendSlice();
        return;
      case "slice":
        this.warmedBytes += message.bytes;
        if (message.done) this.completePass();
        else this.scheduleSlice();
        return;
      case "error":
        this.log.warn?.(`search warm-up read failed (${message.errorType})`);
        this.failPass();
        return;
      case "aborted":
        return;
    }
  }

  private sendSlice(): void {
    if (this.closed || this.state !== "warming" || !this.worker) return;
    if (this.mustPause()) {
      this.pause("activity");
      return;
    }
    if (this.memoryPressure()) {
      this.pause("memory-pressure");
      return;
    }
    this.sliceId += 1;
    this.sliceStartedAt = this.now();
    try {
      this.worker.postMessage({ type: "slice", id: this.sliceId, budgetBytes: this.sliceBytes } satisfies WarmupRequest);
    } catch (error) {
      this.log.warn?.(`search warm-up slice failed (${safeErrorType(error)})`);
      this.failPass();
    }
  }

  private scheduleSlice(): void {
    if (this.closed || this.state !== "warming") return;
    const busy = Math.max(0, this.now() - this.sliceStartedAt);
    const rate = Math.max(1, this.rateOf(this.memory.limitBytes));
    const period = (this.sliceBytes / rate) * 1_000;
    this.backoff = busy > period * 4 ? Math.min(this.backoff * 2, 8) : 1;
    const delay = Math.max(period - busy, busy * 3) * this.backoff;
    this.sliceTimer = setTimeout(() => {
      this.sliceTimer = null;
      this.sendSlice();
    }, Math.max(0, Math.round(delay)));
    this.sliceTimer.unref();
  }

  private mustPause(): boolean {
    if (this.activeSearches > 0 || this.isBusy()) return true;
    return this.now() - this.lastActivityAt < QUIET_MS;
  }

  private memoryPressure(): boolean {
    const limit = this.memory.limitBytes;
    if (this.profile.ownRssBytes() > limit * 0.8) return true;
    return this.profile.cacheableBytes() < this.targetBytes;
  }

  private completePass(): void {
    const total = this.warmedBytes;
    this.state = "warm";
    this.finishedAt = this.now();
    this.reason = this.scope === "partial" ? "over-budget" : undefined;
    this.targetBytes = Math.max(this.targetBytes, total);
    this.warmedBytes = total;
    this.restarts = 0;
    this.retryAt = 0;
    if (this.scope === "full") {
      this.lastFileBytes = this.fileBytesOf();
      if (total > 0) {
        this.hotBytes = total;
        try {
          this.settings?.set({ [WARMUP_HOT_BYTES_KEY]: String(total) });
        } catch (error) {
          this.log.warn?.(`search warm-up size could not be saved (${safeErrorType(error)})`);
        }
      }
    }
    this.stopWorker();
  }

  private failPass(): void {
    this.stopWorker();
    this.state = "paused";
    this.reason = "cooldown";
    this.warmedBytes = 0;
    this.retryAt = this.now() + MEMORY_RETRY_MS;
  }

  private pause(reason: WarmupReason): void {
    if (this.state !== "warming") return;
    this.clearSliceTimer();
    this.stopWorker();
    this.warmedBytes = 0;
    this.restarts += 1;
    this.state = "paused";
    this.reason = reason;
    if (reason === "memory-pressure") this.retryAt = this.now() + MEMORY_RETRY_MS;
    else if (reason === "cooldown") this.retryAt = this.cooldownUntil;
    else if (this.restarts >= MAX_RESTARTS) this.retryAt = this.now() + RESTART_COOLDOWN_MS;
    else this.retryAt = 0;
  }

  private stopWorker(): void {
    this.clearSliceTimer();
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      worker.postMessage({ type: "abort" } satisfies WarmupRequest);
    } catch {
      // The thread may already be gone; terminating is what actually releases the snapshot.
    }
    void worker.terminate().catch(() => {});
  }

  private clearSliceTimer(): void {
    if (!this.sliceTimer) return;
    clearTimeout(this.sliceTimer);
    this.sliceTimer = null;
  }

  private applyOff(reason?: WarmupReason): void {
    this.state = "off";
    this.reason = reason;
    this.scope = undefined;
    this.targetBytes = 0;
    this.warmedBytes = 0;
    this.stopWorker();
  }

  private setState(state: WarmupState, reason?: WarmupReason): void {
    this.state = state;
    this.reason = reason;
  }

  private snapshotMemory(): { limitBytes: number; budgetBytes: number } {
    return {
      limitBytes: this.profile.limitBytes(),
      budgetBytes: Math.min(this.profile.cacheableBytes(), this.capBytes),
    };
  }

  private refreshMemory(): void {
    this.memory = this.snapshotMemory();
  }

  private desktop(): boolean {
    return this.profile.effectiveCgroupLimitBytes() === null;
  }

  private readHotBytes(): number {
    const raw = this.settings?.get(WARMUP_HOT_BYTES_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private statFileBytes(): number {
    if (this.file === null) return 0;
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private resolveWorkerPath(): string {
    if (this.workerPath) return this.workerPath;
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const preferred = import.meta.url.endsWith(".ts")
      ? ["warmup.worker.ts", "warmup.worker.js"]
      : ["warmup.worker.js", "warmup.worker.ts"];
    for (const name of preferred) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error("The warm-up worker bundle is missing from the installation");
  }
}
