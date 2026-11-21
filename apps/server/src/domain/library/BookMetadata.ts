import { ValidationError } from "../errors.js";

/**
 * Book metadata editing rules (ADR-2/ADR-5). Pure validation and normalization: the
 * use case merges a normalized patch into the stored override, and adapters persist it.
 * No I/O, no port imports.
 */

export const METADATA_LIMITS = {
  title: 300,
  author: 200,
  description: 5_000,
  publisher: 200,
  series: 200,
  lookupTitle: 200,
  lookupAuthor: 200,
  maxSeriesIndex: 9_999,
  patchBytes: 16 * 1024,
  coverUploadBytes: 5 * 1024 * 1024,
  coverDownloadBytes: 2 * 1024 * 1024,
  coverMaxSide: 8_000,
  coverMaxPixels: 40_000_000,
  coverTargetWidth: 1_200,
  coverJpegQuality: 85,
} as const;

export type MetadataSourceValue = "manual" | "googlebooks" | "openlibrary";

export interface NormalizedMetadataPatch {
  title?: string | null;
  author?: string | null;
  description?: string | null;
  isbn10?: string | null;
  isbn13?: string | null;
  year?: number | null;
  publisher?: string | null;
  language?: string | null;
  series?: string | null;
  seriesIndex?: number | null;
  source?: MetadataSourceValue;
}

export type NormalizedLookupQuery = { isbn: string } | { title: string; author?: string };

/** A disabled feature is a policy answer, not an invalid request (403 `lookup_disabled`). */
export class MetadataDisabledError extends Error {
  readonly code = "lookup_disabled";
  readonly status = 403;
  constructor() {
    super("Online metadata lookup is disabled");
    this.name = "MetadataDisabledError";
  }
}

const FIELD = (field: string) => ({ field });

const fail = (message: string, field: string): never => {
  throw new ValidationError(message, undefined, FIELD(field));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** C0/C1 control characters; descriptions may keep line breaks but no tabs. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_WITH_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function text(value: unknown, field: string, max: number, allowEmpty: boolean, multiline = false): string {
  if (typeof value !== "string") return fail(`${field} must be a string`, field);
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (multiline ? CONTROL_WITH_NEWLINES.test(normalized) : CONTROL.test(normalized)) {
    return fail(`${field} contains control characters`, field);
  }
  if (!allowEmpty && normalized.length === 0) return fail(`${field} cannot be empty`, field);
  if (normalized.length > max) return fail(`${field} must have at most ${max} characters`, field);
  return normalized;
}

/** Text fields other than `author` reject an empty string: clearing is done with `null`. */
function optionalText(value: unknown, field: string, max: number, multiline = false): string | null {
  if (value === null) return null;
  return text(value, field, max, false, multiline);
}

export function stripIsbn(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += (10 - index) * Number(value[index]);
  const check = value[9] === "X" ? 10 : Number(value[9]);
  return (sum + check) % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 13; index += 1) sum += Number(value[index]) * (index % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

/** Normalizes an ISBN from a patch or a lookup; rejects malformed or checksum-invalid values. */
export function normalizeIsbn(value: unknown, field: "isbn" | "isbn10" | "isbn13"): string {
  if (typeof value !== "string") return fail(`${field} must be a string`, field);
  const normalized = stripIsbn(value);
  if (field === "isbn10" && !isValidIsbn10(normalized)) {
    return fail("isbn10 must be a valid ISBN-10", field);
  }
  if (field === "isbn13" && !isValidIsbn13(normalized)) {
    return fail("isbn13 must be a valid ISBN-13", field);
  }
  if (field === "isbn" && !(isValidIsbn10(normalized) || isValidIsbn13(normalized))) {
    return fail("isbn must be a valid ISBN-10 or ISBN-13", field);
  }
  return normalized;
}

const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/;

function language(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return fail("language must be a string", "language");
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (!LANGUAGE.test(normalized)) {
    return fail("language must be a simple BCP-47 tag", "language");
  }
  return normalized;
}

function year(value: unknown, maxYear: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail("year must be an integer", "year");
  }
  if (value < 1 || value > maxYear) return fail(`year must be between 1 and ${maxYear}`, "year");
  return value;
}

function seriesIndex(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("seriesIndex must be a number", "seriesIndex");
  }
  if (value < 0 || value > METADATA_LIMITS.maxSeriesIndex) {
    return fail(`seriesIndex must be between 0 and ${METADATA_LIMITS.maxSeriesIndex}`, "seriesIndex");
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    return fail("seriesIndex accepts at most two decimals", "seriesIndex");
  }
  return value;
}

const SOURCES: readonly MetadataSourceValue[] = ["manual", "googlebooks", "openlibrary"];

const ALLOWED_KEYS = new Set([
  "title", "author", "description", "isbn10", "isbn13", "year", "publisher",
  "language", "series", "seriesIndex", "source",
]);

/**
 * Validates a partial PATCH body. An absent key stays unchanged; `null` clears the
 * override of that field. Unknown keys fail instead of being silently ignored.
 */
export function normalizeMetadataPatch(raw: unknown, maxYear: number): NormalizedMetadataPatch {
  if (!isRecord(raw)) throw new ValidationError("Invalid metadata patch", undefined, FIELD("body"));
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ValidationError(`Unknown metadata field: ${key}`, undefined, FIELD(key));
    }
  }
  const patch: NormalizedMetadataPatch = {};
  if ("title" in raw) {
    patch.title = raw.title === null ? null : text(raw.title, "title", METADATA_LIMITS.title, false);
  }
  if ("author" in raw) {
    patch.author = raw.author === null ? null : text(raw.author, "author", METADATA_LIMITS.author, true);
  }
  if ("description" in raw) {
    patch.description = optionalText(raw.description, "description", METADATA_LIMITS.description, true);
  }
  if ("isbn10" in raw) patch.isbn10 = raw.isbn10 === null ? null : normalizeIsbn(raw.isbn10, "isbn10");
  if ("isbn13" in raw) patch.isbn13 = raw.isbn13 === null ? null : normalizeIsbn(raw.isbn13, "isbn13");
  if ("year" in raw) patch.year = year(raw.year, maxYear);
  if ("publisher" in raw) patch.publisher = optionalText(raw.publisher, "publisher", METADATA_LIMITS.publisher);
  if ("language" in raw) patch.language = language(raw.language);
  if ("series" in raw) patch.series = optionalText(raw.series, "series", METADATA_LIMITS.series);
  if ("seriesIndex" in raw) patch.seriesIndex = seriesIndex(raw.seriesIndex);
  if ("source" in raw) {
    if (typeof raw.source !== "string" || !SOURCES.includes(raw.source as MetadataSourceValue)) {
      fail("source must be manual, googlebooks or openlibrary", "source");
    }
    patch.source = raw.source as MetadataSourceValue;
  }
  if (Object.keys(patch).filter((key) => key !== "source").length === 0) {
    throw new ValidationError("At least one metadata field is required", undefined, FIELD("body"));
  }
  return patch;
}

/** `GET /api/metadata/search`: ISBN xor title, never both. */
export function normalizeLookupQuery(raw: unknown): NormalizedLookupQuery {
  if (!isRecord(raw)) throw new ValidationError("Invalid metadata query", undefined, FIELD("query"));
  const isbn = raw.isbn;
  const title = raw.title;
  const author = raw.author;
  if (isbn !== undefined && (title !== undefined || author !== undefined)) {
    throw new ValidationError("Use either isbn or title/author, not both", undefined, FIELD("query"));
  }
  if (isbn !== undefined) {
    if (typeof isbn !== "string") return fail("isbn must be a string", "isbn");
    const normalized = stripIsbn(isbn);
    if (!isValidIsbn10(normalized) && !isValidIsbn13(normalized)) {
      return fail("isbn must be a valid ISBN-10 or ISBN-13", "isbn");
    }
    return { isbn: normalized };
  }
  if (title === undefined) {
    throw new ValidationError("isbn or title is required", undefined, FIELD("query"));
  }
  const normalizedTitle = text(title, "title", METADATA_LIMITS.lookupTitle, false);
  if (author === undefined) return { title: normalizedTitle };
  const normalizedAuthor = text(author, "author", METADATA_LIMITS.lookupAuthor, true);
  return normalizedAuthor ? { title: normalizedTitle, author: normalizedAuthor } : { title: normalizedTitle };
}

/** Latest year a user may record: next year, so pre-orders and upcoming editions fit. */
export const maxMetadataYear = (now: number): number => new Date(now).getUTCFullYear() + 1;
