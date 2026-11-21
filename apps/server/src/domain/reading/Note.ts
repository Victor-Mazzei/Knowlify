import { ValidationError } from "../errors.js";
export interface Note {
  id: string;
  book_id: string;
  location: string;
  label: string;
  quote: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface NoteInput { body?: string; quote?: string; location?: string; label?: string }

/** Raw group row returned by the notes repository: one per book with its matching notes. */
export interface NoteGroupRow {
  bookId: string;
  noteCount: number;
  lastNoteAt: number;
}

/** Book header shown with a group. Deliberately narrow: no path, source or file fields. */
export interface NoteGroupBook {
  id: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  hasCover: boolean;
}

/** Keyset position of the last group of a page, ordered by `(lastNoteAt, bookId)` desc. */
export interface NoteGroupAnchor {
  lastNoteAt: number;
  bookId: string;
}

export interface NoteGroupQuery {
  q?: string;
  limit: number;
  perGroup: number;
  anchor?: NoteGroupAnchor;
}

export const NOTE_GROUP_LIMITS = {
  defaultLimit: 20,
  maxLimit: 50,
  defaultPerGroup: 5,
  maxPerGroup: 20,
  maxQueryChars: 200,
} as const;

const MAX_CURSOR_CHARS = 1024;
const MAX_BOOK_ID_CHARS = 256;

const boundedInteger = (value: unknown, fallback: number, max: number, name: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ValidationError(`${name} must be an integer between 1 and ${max}`);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) {
    throw new ValidationError(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
};

/**
 * `q` is a user-facing search string: trimmed, capped and empty means "no filter". The
 * existing `GET /api/notes` keeps its own unvalidated search for compatibility.
 */
export function noteQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError("q must be a single value");
  const q = value.trim();
  if (q.length > NOTE_GROUP_LIMITS.maxQueryChars) {
    throw new ValidationError(`q accepts at most ${NOTE_GROUP_LIMITS.maxQueryChars} characters`);
  }
  return q || undefined;
}

export interface NoteGroupQueryInput {
  q?: unknown;
  limit?: unknown;
  perGroup?: unknown;
  cursor?: unknown;
}

export function noteGroupQuery(input: NoteGroupQueryInput = {}): NoteGroupQuery {
  const q = noteQuery(input.q);
  const limit = boundedInteger(input.limit, NOTE_GROUP_LIMITS.defaultLimit, NOTE_GROUP_LIMITS.maxLimit, "limit");
  const perGroup = boundedInteger(input.perGroup, NOTE_GROUP_LIMITS.defaultPerGroup, NOTE_GROUP_LIMITS.maxPerGroup, "perGroup");
  const anchor = input.cursor === undefined ? undefined : decodeNoteGroupCursor(input.cursor);
  return { ...(q === undefined ? {} : { q }), limit, perGroup, ...(anchor === undefined ? {} : { anchor }) };
}

export function encodeNoteGroupCursor(anchor: NoteGroupAnchor): string {
  return Buffer.from(JSON.stringify({ lastNoteAt: anchor.lastNoteAt, bookId: anchor.bookId }), "utf8")
    .toString("base64url");
}

/**
 * The cursor is opaque but carries only the keyset position, so strict shape validation is
 * enough: the endpoint is authenticated and a forged cursor can only skip the caller's own
 * groups. Any malformed value is a 400, never a SQL or runtime error.
 */
export function decodeNoteGroupCursor(value: unknown): NoteGroupAnchor {
  if (typeof value !== "string" || value.length > MAX_CURSOR_CHARS) {
    throw new ValidationError("cursor is invalid");
  }
  const raw = Buffer.from(value, "base64url");
  if (raw.length === 0 || raw.toString("base64url") !== value) throw new ValidationError("cursor is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ValidationError("cursor is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("cursor is invalid");
  }
  const { lastNoteAt, bookId } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).length !== 2
    || typeof lastNoteAt !== "number" || !Number.isSafeInteger(lastNoteAt) || lastNoteAt < 0
    || typeof bookId !== "string" || bookId.length === 0 || bookId.length > MAX_BOOK_ID_CHARS) {
    throw new ValidationError("cursor is invalid");
  }
  return { lastNoteAt, bookId };
}

export const clean = (value: unknown, max: number): string => typeof value === "string" ? value.trim().slice(0, max) : "";
export function noteBody(value: unknown): string {
  const body = clean(value, 20_000);
  if (!body) throw new ValidationError("The note cannot be empty");
  return body;
}
