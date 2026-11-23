import { readFileSync } from "node:fs";
import * as os from "node:os";

const MB = 1024 * 1024;
/** Keep at least this much (or 25% of the limit, when larger) out of the cache budget. */
const MIN_RESERVE_BYTES = 256 * MB;
/** Without a cgroup the desktop may share memory with other apps: only half of free RAM. */
const DESKTOP_FREE_FRACTION = 0.5;
/** LRU ceilings by effective memory (ADR-3). */
const CACHE_TIERS = [
  { belowBytes: 768 * MB, entries: 32 },
  { belowBytes: 3 * 1024 * MB, entries: 128 },
] as const;
const CACHE_MAX_ENTRIES = 512;
const CACHE_MAX_BYTES = 8 * MB;
const CACHE_FRACTION = 0.005;

export interface CgroupLimit {
  version: 1 | 2;
  /** `null` for cgroup v2 `max`. */
  limitBytes: number | null;
}

export interface CgroupPaths {
  v2: string;
  v1: string;
}

export const DEFAULT_CGROUP_PATHS: CgroupPaths = {
  v2: "/sys/fs/cgroup/memory.max",
  v1: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
};

const readNumericFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

/**
 * Reads the cgroup memory limit without a dependency. cgroup v2 writes `max` when the
 * controller has no limit; cgroup v1 writes a near-`2^63` sentinel instead. The caller
 * compares the value with physical RAM, so a sentinel simply means "unlimited".
 */
export function readCgroupMemoryLimit(paths: CgroupPaths = DEFAULT_CGROUP_PATHS): CgroupLimit | null {
  const v2 = readNumericFile(paths.v2);
  if (v2 !== null) {
    if (v2 === "max" || v2 === "") return { version: 2, limitBytes: null };
    const parsed = Number(v2);
    return Number.isFinite(parsed) && parsed > 0 ? { version: 2, limitBytes: parsed } : { version: 2, limitBytes: null };
  }
  const v1 = readNumericFile(paths.v1);
  if (v1 !== null && v1 !== "") {
    const parsed = Number(v1);
    if (Number.isFinite(parsed) && parsed > 0) {
      // The v1 "unlimited" sentinel is huge; comparing with RAM happens in limitBytes().
      return { version: 1, limitBytes: parsed };
    }
  }
  return null;
}

export interface MemoryProfileDeps {
  /** `process.constrainedMemory`; 0 when libuv reports no limit. */
  constrainedMemory?: () => number;
  totalMemory?: () => number;
  freeMemory?: () => number;
  rss?: () => number;
  cgroupLimit?: () => CgroupLimit | null;
}

/**
 * One place that answers "how much memory may the search cache use?". It reads the
 * effective limit (libuv's cgroup resolution first, the cgroup files as a Linux
 * fallback) and physical RAM, so a 512 MB container never sizes a cache for the host.
 */
export class MemoryProfile {
  private readonly constrainedMemory: () => number;
  private readonly totalMemory: () => number;
  private readonly freeMemory: () => number;
  private readonly rss: () => number;
  private readonly cgroupLimit: () => CgroupLimit | null;

  constructor(deps: MemoryProfileDeps = {}) {
    this.constrainedMemory = deps.constrainedMemory ?? (() => process.constrainedMemory());
    this.totalMemory = deps.totalMemory ?? (() => os.totalmem());
    this.freeMemory = deps.freeMemory ?? (() => os.freemem());
    this.rss = deps.rss ?? (() => process.memoryUsage.rss());
    this.cgroupLimit = deps.cgroupLimit ?? (() => readCgroupMemoryLimit());
  }

  totalBytes(): number {
    return this.totalMemory();
  }

  /** Effective process limit: the smallest of cgroup limit, constrained memory and RAM. */
  limitBytes(): number {
    const total = this.totalMemory();
    const cgroup = this.effectiveCgroupLimitBytes();
    const constrained = this.constrainedMemory();
    return Math.max(
      1,
      Math.min(
        total,
        cgroup ?? Number.POSITIVE_INFINITY,
        Number.isFinite(constrained) && constrained > 0 ? constrained : Number.POSITIVE_INFINITY,
      ),
    );
  }

  /** The cgroup limit only counts when it is below physical RAM (v1's sentinel does not). */
  effectiveCgroupLimitBytes(): number | null {
    const cgroup = this.cgroupLimit();
    if (!cgroup || cgroup.limitBytes === null) return null;
    return cgroup.limitBytes < this.totalMemory() ? cgroup.limitBytes : null;
  }

  cgroupVersion(): 1 | 2 | null {
    return this.cgroupLimit()?.version ?? null;
  }

  ownRssBytes(): number {
    return this.rss();
  }

  freeBytes(): number {
    return this.freeMemory();
  }

  /**
   * Memory the process may fill with derived data. In a cgroup the reserve is the only
   * guard (the page cache is reclaimable); on the desktop half of free RAM is a second
   * cap because other applications share the machine.
   */
  cacheableBytes(): number {
    const limit = this.limitBytes();
    const reserve = Math.max(MIN_RESERVE_BYTES, limit * 0.25);
    const available = Math.max(0, limit - this.ownRssBytes() - reserve);
    const desktopCap = this.effectiveCgroupLimitBytes() === null
      ? Math.max(0, this.freeBytes() * DESKTOP_FREE_FRACTION)
      : limit;
    return Math.floor(Math.max(0, Math.min(available, desktopCap)));
  }

  snapshot(): {
    limitBytes: number;
    totalBytes: number;
    ownRssBytes: number;
    freeBytes: number;
    cacheableBytes: number;
    cgroup: { version: 1 | 2 | null; limitBytes: number | null };
  } {
    const limit = this.limitBytes();
    return {
      limitBytes: limit,
      totalBytes: this.totalBytes(),
      ownRssBytes: this.ownRssBytes(),
      freeBytes: this.freeBytes(),
      cacheableBytes: this.cacheableBytes(),
      cgroup: { version: this.cgroupVersion(), limitBytes: this.effectiveCgroupLimitBytes() },
    };
  }
}

/** Entry and byte ceilings for the LRU, from the same effective limit (ADR-3). */
export function cacheLimits(limitBytes: number): { maxEntries: number; maxBytes: number } {
  let maxEntries = CACHE_MAX_ENTRIES;
  for (const tier of CACHE_TIERS) {
    if (limitBytes < tier.belowBytes) {
      maxEntries = tier.entries;
      break;
    }
  }
  return {
    maxEntries,
    maxBytes: Math.max(1, Math.min(CACHE_MAX_BYTES, Math.floor(limitBytes * CACHE_FRACTION))),
  };
}
