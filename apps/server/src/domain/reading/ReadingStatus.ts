/**
 * Reading status derived from the stored progress fraction. The thresholds mirror the
 * visible rule in `apps/web/src/modules/library/readingProgress.ts` (a book under 1% read
 * shows no progress, and the last percent is "Finished"); both layers are isolated, so each
 * keeps its own constant and its own test pinning the same values.
 */
export const UNSTARTED_BELOW = 0.005;
export const FINISHED_AT = 0.99;

export const READING_STATUSES = ["unread", "reading", "finished"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export function readingStatusOf(percentage: number | null | undefined): ReadingStatus {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return "unread";
  if (percentage >= FINISHED_AT) return "finished";
  if (percentage < UNSTARTED_BELOW) return "unread";
  return "reading";
}
