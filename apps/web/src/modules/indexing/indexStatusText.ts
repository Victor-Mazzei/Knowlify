import type { IndexRetrievalStatus, IndexVectorsStatus, IndexWarmupReason, IndexWarmupStatus } from "./types";

const number = new Intl.NumberFormat("en-US");
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/**
 * Plain-language backfill time. Null means "unknown", so callers can hide the
 * value instead of showing a placeholder in an already dense status line.
 */
export function formatTimeLeft(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return "less than a minute left";
  if (seconds < 3600) return `about ${Math.max(1, Math.round(seconds / 60))} min left`;
  if (seconds < 86_400) return `about ${Math.max(1, Math.round(seconds / 3600))} h left`;
  return `about ${Math.max(1, Math.round(seconds / 86_400))} d left`;
}

/** The server reports passages per second; people read a rate per minute. */
export function formatRate(ratePerSecond: number | null | undefined): string | null {
  if (ratePerSecond === null || ratePerSecond === undefined || !Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    return null;
  }
  const perMinute = ratePerSecond * 60;
  const value = Number(perMinute.toFixed(perMinute < 10 ? 1 : 0));
  return `${number.format(value)} ${value === 1 ? "passage" : "passages"}/min`;
}

export function formatWorkers(workers: number | undefined): string | null {
  if (workers === undefined || !Number.isInteger(workers) || workers < 1) return null;
  return `${workers} ${workers === 1 ? "worker" : "workers"}`;
}

export function describeVectorPolicy(policy: IndexVectorsStatus): string {
  if (policy.mode === "demand" || policy.maxBooks <= 0) return "On demand only.";
  return `First ${number.format(policy.maxBooks)} books; others on demand.`;
}

/** Plain-language labels for the server's warm-up reasons. */
const warmupReasonText: Record<IndexWarmupReason, string> = {
  disabled: "turned off",
  "small-index": "small index",
  "low-memory": "limited memory",
  "over-budget": "index too large",
  "memory-pressure": "limited memory",
  activity: "busy",
  cooldown: "cooling down",
};

function describeReason(reason: string | undefined): string | null {
  if (!reason) return null;
  return warmupReasonText[reason as IndexWarmupReason] ?? "unknown reason";
}

function stateWithReason(label: string, reason: string | undefined): string {
  const text = describeReason(reason);
  return text ? `${label} (${text})` : label;
}

/** 0–100 while a warm-up pass has a target; null when there is no percentage to show. */
export function warmupPercent(warmup: IndexWarmupStatus): number | null {
  if (warmup.state !== "warming") return null;
  const { warmedMB, targetMB } = warmup;
  if (!Number.isFinite(warmedMB) || !Number.isFinite(targetMB) || targetMB <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((warmedMB / targetMB) * 100)));
}

/** Compact cache size: whole kilobytes below 1 MB, one decimal above. */
export function formatCacheSize(kb: number): string | null {
  if (!Number.isFinite(kb) || kb < 0) return null;
  if (kb >= 1024) return `${decimal.format(kb / 1024)} MB`;
  return `${number.format(kb)} KB`;
}

export type RetrievalSummary = {
  /** Changes with the state or reason, never with the percentage. */
  stateText: string;
  percent: number | null;
  cacheText: string | null;
  cacheHint: string | null;
};

/**
 * One line of warm-up and cache status. The percentage is intentionally kept
 * out of `stateText` so a polite live region does not announce every poll.
 */
export function describeRetrieval(retrieval: IndexRetrievalStatus): RetrievalSummary | null {
  const warmup = retrieval.warmup;
  if (!warmup) return null;
  const stateText = describeWarmupState(warmup);
  const percent = warmupPercent(warmup);
  const cache = retrieval.cache;
  const cacheEnabled = cache?.enabled === true;
  const used = cacheEnabled ? formatCacheSize(cache.usedKB) : null;
  const max = cacheEnabled && cache.maxKB > 0 ? formatCacheSize(cache.maxKB) : null;
  const cacheText = cacheEnabled
    ? used
      ? `Cache: ${used}${max ? ` of ${max}` : ""}`
      : "Cache: on"
    : cache
      ? "Cache: off"
      : null;
  return {
    stateText,
    percent,
    cacheText,
    cacheHint: cacheEnabled ? "Faster repeated searches" : null,
  };
}

function describeWarmupState(warmup: IndexWarmupStatus): string {
  switch (warmup.state) {
    case "off":
      return stateWithReason("Off", warmup.reason);
    case "idle":
      return "Idle";
    case "waiting":
      return "Waiting for a quiet moment";
    case "warming":
      return "Warming the search index…";
    case "warm":
      return "Warm";
    case "paused":
      return stateWithReason("Paused", warmup.reason);
    default:
      return "Unknown";
  }
}
