import type { IndexVectorsStatus } from "./types";

const number = new Intl.NumberFormat("en-US");

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
