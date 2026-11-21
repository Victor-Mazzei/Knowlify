import type { Format, ScanStatus } from "../../types";
import type {
  DuplicateBook,
  DuplicateGroup,
  DuplicatesPage,
  DuplicatesScanState,
  DuplicatesSummary,
  MergeAccepted,
  MergeDryRun,
  MergePlan,
  MergeResult,
  MergeSkipped,
} from "./types";

const unexpected = () => new Error("The server sent an unexpected response.");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const isFormat = (value: unknown): value is Format => value === "pdf" || value === "epub";

function listOf<T>(value: unknown, guard: (item: unknown) => item is T): T[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(guard) ? value : null;
}

const isDuplicateBook = (value: unknown): value is DuplicateBook =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.title) &&
  isString(value.author) &&
  isFormat(value.format) &&
  isString(value.path) &&
  (value.sourceId === null || isString(value.sourceId)) &&
  (value.sourceLabel === null || isString(value.sourceLabel)) &&
  (isNumber(value.addedAt) || isString(value.addedAt)) &&
  isBoolean(value.canonical) &&
  isBoolean(value.hasNotes) &&
  isBoolean(value.hasProgress) &&
  isBoolean(value.indexed);

const isDuplicateGroup = (value: unknown): value is DuplicateGroup => {
  if (!isRecord(value)) return false;
  const books = listOf(value.books, isDuplicateBook);
  const aliases = listOf(value.aliases, isString);
  return (
    isString(value.key) &&
    isNumber(value.size) &&
    isString(value.contentHash) &&
    isString(value.canonicalId) &&
    books !== null &&
    books.some((book) => book.id === value.canonicalId) &&
    aliases !== null
  );
};

const isSummary = (value: unknown): value is DuplicatesSummary =>
  isRecord(value) &&
  isNumber(value.groups) &&
  isNumber(value.redundantBooks) &&
  isNumber(value.reclaimableBytes);

export function parsePage(value: unknown): DuplicatesPage {
  if (!isRecord(value)) throw unexpected();
  const groups = listOf(value.groups, isDuplicateGroup);
  const { nextCursor, summary } = value;
  if (groups === null || (nextCursor !== null && !isString(nextCursor)) || !isSummary(summary)) {
    throw unexpected();
  }
  return { groups, nextCursor, summary };
}

/** `duplicates` is additive; older servers return nothing and the card simply has no progress. */
export function parseScanState(value: unknown): DuplicatesScanState | null {
  if (!isRecord(value) || (value.state !== "idle" && value.state !== "hashing" && value.state !== "ready")) {
    return null;
  }
  const state = value.state;
  return {
    state,
    progress: isNumber(value.progress) ? value.progress : null,
    groups: isNumber(value.groups) ? Math.max(0, Math.trunc(value.groups)) : 0,
    redundantBooks: isNumber(value.redundantBooks) ? Math.max(0, Math.trunc(value.redundantBooks)) : 0,
  };
}

const isMergePlan = (value: unknown): value is MergePlan =>
  isRecord(value) &&
  isNumber(value.groups) &&
  isNumber(value.booksRemoved) &&
  isNumber(value.notesMoved) &&
  isNumber(value.conversationsMoved) &&
  isNumber(value.progressKept) &&
  isNumber(value.indexesDropped) &&
  isNumber(value.managedFilesRemoved) &&
  isNumber(value.reclaimableBytes);

const isMergeSkipped = (value: unknown): value is MergeSkipped =>
  isRecord(value) && isString(value.key) && isString(value.reason);

const isMergeAccepted = (value: unknown): value is MergeAccepted =>
  isRecord(value) && isString(value.key) && isString(value.fingerprint);

export function parseDryRun(value: unknown): MergeDryRun {
  if (!isRecord(value) || !isMergePlan(value.plan)) throw unexpected();
  const warnings = listOf(value.warnings, isString);
  if (warnings === null) throw unexpected();
  // Servers from before the confirm contract omit `accepted`; `null` tells the
  // UI to show the report without offering a merge.
  const accepted =
    value.accepted === undefined || value.accepted === null ? null : listOf(value.accepted, isMergeAccepted);
  if (value.accepted !== undefined && value.accepted !== null && accepted === null) throw unexpected();
  const omitted = value.omitted === undefined ? [] : listOf(value.omitted, isString);
  if (omitted === null) throw unexpected();
  return {
    merged: isNumber(value.merged) ? value.merged : 0,
    plan: value.plan,
    warnings,
    accepted,
    omitted,
  };
}

export function parseMergeResult(value: unknown): MergeResult {
  if (!isRecord(value) || !isNumber(value.merged)) throw unexpected();
  const skipped = listOf(value.skipped, isMergeSkipped);
  if (skipped === null) throw unexpected();
  return {
    merged: value.merged,
    booksRemoved: isNumber(value.booksRemoved) ? value.booksRemoved : 0,
    skipped,
  };
}

type ScanStatusExtras = { skippedDuplicates?: unknown; duplicates?: unknown };

/**
 * The counter is additive: servers older than the dedup work omit the field
 * and the header stays exactly as it was.
 */
export function readSkippedDuplicates(status: ScanStatus): number {
  const value = (status as ScanStatus & ScanStatusExtras).skippedDuplicates;
  return isNumber(value) && value > 0 ? Math.trunc(value) : 0;
}

export function readDuplicateState(status: ScanStatus): DuplicatesScanState | null {
  return parseScanState((status as ScanStatus & ScanStatusExtras).duplicates);
}
