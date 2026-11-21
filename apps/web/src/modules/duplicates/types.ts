import type { Format } from "../../types";

export type DuplicateBook = {
  id: string;
  title: string;
  author: string;
  format: Format;
  path: string;
  sourceId: string | null;
  sourceLabel: string | null;
  addedAt: number | string;
  /** Server's recommended copy to keep. */
  canonical: boolean;
  hasNotes: boolean;
  hasProgress: boolean;
  indexed: boolean;
};

export type DuplicateGroup = {
  key: string;
  size: number;
  contentHash: string;
  canonicalId: string;
  books: DuplicateBook[];
  /** Extra paths that already point at this book; they never appear as books. */
  aliases: string[];
};

export type DuplicatesSummary = {
  groups: number;
  redundantBooks: number;
  reclaimableBytes: number;
};

export type DuplicatesPage = {
  groups: DuplicateGroup[];
  nextCursor: string | null;
  summary: DuplicatesSummary;
};

export type DuplicatesScanState = {
  state: "idle" | "hashing" | "ready";
  progress: number | null;
  groups: number;
  redundantBooks: number;
};

export type MergePlan = {
  groups: number;
  booksRemoved: number;
  notesMoved: number;
  conversationsMoved: number;
  progressKept: number;
  indexesDropped: number;
  managedFilesRemoved: number;
  reclaimableBytes: number;
};

export type MergeSkipped = { key: string; reason: string };

/** A group the dry-run accepted. The fingerprint proves the reviewed state at merge time. */
export type MergeAccepted = { key: string; fingerprint: string };

/**
 * The exact scope confirmed by the user. `groups` tells the server which canonical was
 * reviewed; `confirm` pins each accepted plan by fingerprint.
 */
export type MergeBatch = { groups: MergeTarget[]; confirm: MergeAccepted[] };

export type MergeDryRun = {
  merged: number;
  plan: MergePlan;
  warnings: string[];
  /** `null` when the server predates the reviewed-confirm contract. */
  accepted: MergeAccepted[] | null;
  /** Groups the server left out because they changed before the review completed. */
  omitted: string[];
};

/**
 * Client-side dry-run: the server caps each request at 500 groups, so the hook
 * checks every batch and reports how many groups the plan actually covers.
 */
export type MergeReview = MergeDryRun & {
  requested: number;
};

export type MergeResult = {
  merged: number;
  booksRemoved: number;
  skipped: MergeSkipped[];
  /** Groups still listed after the merge; the hook fills this while it reloads. */
  remaining?: number;
};

export type MergeTarget = { key: string; canonicalId?: string };
