export type IndexState = "pending" | "indexing" | "ready" | "error";

export type IndexErrorCode = "no_text" | "too_large" | "unreadable" | "embedder_failed" | "unknown";

export interface BookIndex {
  bookId: string;
  state: IndexState;
  priority: 0 | 1;
  contentHash: string | null;
  indexVersion: string | null;
  fingerprint: string | null;
  chunkCount: number;
  attempts: number;
  nextAttemptAt: number;
  error: { code: IndexErrorCode; message: string } | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Passage {
  ordinal: number;
  text: string;
  page: number | null;
  section: string | null;
}

export interface TextSection {
  text: string;
  page: number | null;
  section: string | null;
}

export const MAX_ATTEMPTS = 3;

/** Version suffix for content indexed lexically by choice (`KNOWLIFY_EMBEDDINGS=none`). */
export const LEXICAL_INDEX_SUFFIX = "lexical";

/** Version suffix the pipeline writes when a configured embedder could not produce vectors. */
export const DEGRADED_INDEX_SUFFIX = "none";

export function isLexicalVersion(version: string | null): boolean {
  return version !== null && version.endsWith(`|${LEXICAL_INDEX_SUFFIX}`);
}

export function isDegradedVersion(version: string | null): boolean {
  return version !== null && version.endsWith(`|${DEGRADED_INDEX_SUFFIX}`);
}

/** Stored a real embedder version (not lexical-by-choice and not degraded). */
export function isVectorVersion(version: string | null): boolean {
  return version !== null && !isLexicalVersion(version) && !isDegradedVersion(version);
}

/** Same pipeline version, lexical tier: used when vectors are not requested for a job. */
export function toLexicalVersion(version: string): string {
  const separator = version.indexOf("|");
  return separator >= 0
    ? `${version.slice(0, separator)}|${LEXICAL_INDEX_SUFFIX}`
    : `${version}|${LEXICAL_INDEX_SUFFIX}`;
}

/** Delay before the next attempt, indexed by the number of the failed attempt. */
export const RETRY_DELAYS_MS = [60_000, 300_000] as const;

const DEFAULT_CHUNK_SIZE = 1_000;
const DEFAULT_CHUNK_OVERLAP = 150;
/** A cut point is only accepted after at least half of the window, so chunks do not degenerate. */
const MIN_FILL_RATIO = 0.5;
const BREAK_SEPARATORS = ["\n\n", ". ", "! ", "? ", "\n", "; ", ", ", " "] as const;

export function chunkSections(
  sections: Iterable<TextSection>,
  opts?: { size?: number; overlap?: number },
): Iterable<Passage> {
  const size = Math.max(1, Math.floor(opts?.size ?? DEFAULT_CHUNK_SIZE));
  const overlap = Math.min(Math.max(0, Math.floor(opts?.overlap ?? DEFAULT_CHUNK_OVERLAP)), Math.floor(size / 2));
  return {
    *[Symbol.iterator]() {
      let ordinal = 0;
      for (const section of sections) {
        const text = section.text.trim();
        if (!text) continue;
        for (const chunk of splitSection(text, size, overlap)) {
          yield { ordinal: ordinal++, text: chunk, page: section.page, section: section.section };
        }
      }
    },
  };
}

function splitSection(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) end = findCut(text, start, end);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const next = Math.max(end - overlap, start + 1);
    // Whitespace between chunks is not content; resuming on a non-space keeps windows compact.
    start = next;
    while (start < text.length && /\s/.test(text[start]!)) start++;
  }
  return chunks;
}

function findCut(text: string, start: number, end: number): number {
  const floor = start + Math.max(1, Math.floor((end - start) * MIN_FILL_RATIO));
  const window = text.slice(floor, end);
  for (const separator of BREAK_SEPARATORS) {
    const index = window.lastIndexOf(separator);
    if (index >= 0) return floor + index + separator.length;
  }
  return end;
}

/**
 * Records a failed attempt. Missing text and oversized files are terminal; transient failures
 * (unreadable mounts, embedder hiccups) return to the queue with backoff. After MAX_ATTEMPTS
 * the error is terminal, so a poison book cannot loop forever.
 */
export function failure(index: BookIndex, code: IndexErrorCode, message: string, now: number): BookIndex {
  const attempts = index.attempts + 1;
  const terminal = code === "no_text" || code === "too_large" || attempts >= MAX_ATTEMPTS;
  if (terminal) {
    return { ...index, attempts, state: "error", nextAttemptAt: 0, error: { code, message }, finishedAt: now };
  }
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  return { ...index, attempts, state: "pending", nextAttemptAt: now + delay, startedAt: null, finishedAt: null };
}

export function indexing(index: BookIndex, now: number): BookIndex {
  return { ...index, state: "indexing", startedAt: now, finishedAt: null, nextAttemptAt: 0 };
}

export function ready(
  index: BookIndex,
  result: { contentHash: string; indexVersion: string; chunkCount: number },
  now: number,
): BookIndex {
  return {
    ...index,
    state: "ready",
    contentHash: result.contentHash,
    indexVersion: result.indexVersion,
    chunkCount: result.chunkCount,
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    startedAt: index.startedAt,
    finishedAt: now,
  };
}

/** Same content and pipeline version: keep the stored chunks, only refresh bookkeeping. */
export function unchanged(index: BookIndex, result: { contentHash: string; indexVersion: string }, now: number): BookIndex {
  return ready(index, { ...result, chunkCount: index.chunkCount }, now);
}
