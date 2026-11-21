import type { Book } from "./Book.js";

/**
 * A book the user deleted that must not be imported again. The row is written in the same
 * transaction as the deletion (ADR-3), so a scan can never observe one without the other.
 * `path` is the canonical library-folder path (absent for managed uploads) and
 * `contentHash` is the full-file SHA-256 when one was known (it covers aliases and copies
 * that were not seen yet).
 */
export interface IgnoredBook {
  id: string;
  path: string | null;
  sourceId: string | null;
  contentHash: string | null;
  size: number;
  title: string;
  author: string;
  format: Book["format"];
  /** True when the deleted book was an app-managed upload (its file was removed). */
  managed: boolean;
  ignoredAt: number;
}

export type IgnoredReason = "path" | "content" | "both";

export const ignoredReason = (book: IgnoredBook): IgnoredReason => {
  if (book.path !== null && book.contentHash !== null) return "both";
  return book.contentHash !== null ? "content" : "path";
};
