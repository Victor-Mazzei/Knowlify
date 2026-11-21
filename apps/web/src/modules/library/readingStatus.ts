import type { ReadFilter } from "../../types";

/**
 * The server applies the same boundaries to `web_progress.percentage`
 * (domain/reading/ReadingStatus.ts). Camadas isoladas: keep the values in
 * sync with the reader display rule in `readingProgress.ts`.
 */
export const UNSTARTED_BELOW = 0.005;
export const FINISHED_AT = 0.99;

/** `unread` also covers missing or invalid progress. */
export function readingStatusOf(percentage: number | null | undefined): ReadFilter {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return "unread";
  if (percentage < UNSTARTED_BELOW) return "unread";
  return percentage >= FINISHED_AT ? "finished" : "reading";
}
