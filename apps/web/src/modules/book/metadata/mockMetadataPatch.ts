import type { BookMetadata, MetadataSource } from "../types";
import { isValidIsbn10, isValidIsbn13, normalizeIsbn } from "./isbn";

/** Values stored in the override row; a missing key means "use the file value". */
export type MockOverride = Partial<Record<Exclude<keyof BookMetadata, "file" | "overridden" | "source" | "updatedAt" | "cover">, string | number>>;

export type MockMetadataState = {
  file: { title: string; author: string };
  override: MockOverride;
  source: MetadataSource | null;
  updatedAt: number | null;
  hasFileCover: boolean;
  customCover: boolean;
  coverRev: number | null;
};

export type MockPatchError = { message: string; field?: string };

const TEXT_FIELDS = ["title", "author", "description", "isbn10", "isbn13", "publisher", "language", "series"] as const;
const NUMBER_FIELDS = ["year", "seriesIndex"] as const;
const ALLOWED = new Set<string>([...TEXT_FIELDS, ...NUMBER_FIELDS, "source"]);
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_WITH_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const error = (field: string, message: string): MockPatchError => ({ field, message });

function textValue(field: string, value: unknown, max: number): string | MockPatchError {
  if (typeof value !== "string") return error(field, `${field} must be a string or null.`);
  const text = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if ((field === "description" ? CONTROL_WITH_NEWLINES : CONTROL).test(text)) {
    return error(field, `${field} contains control characters.`);
  }
  if (!text && field !== "author") {
    return error(field, `Use null to clear ${field}; only author accepts an empty string.`);
  }
  if (text.length > max) return error(field, `${field} must be at most ${max} characters.`);
  return text;
}

const effectiveSeries = (next: MockOverride) => (typeof next.series === "string" ? next.series : "");

/**
 * Applies one PATCH body over a copy of the state. Returns the error the server would
 * answer (`400 { message, field }`) without mutating anything.
 */
export function applyMetadataPatch(
  state: MockMetadataState,
  body: unknown,
  now = Date.now(),
): { state: MockMetadataState } | { error: MockPatchError } {
  if (!isRecord(body)) return { error: error("body", "The body must be a JSON object.") };
  if (Object.keys(body).every((key) => key === "source")) {
    return { error: error("body", "Send at least one metadata field; source alone changes nothing.") };
  }
  const next: MockOverride = { ...state.override };
  let nextSource = state.source;
  let changed = false;

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return { error: error(key, `Unknown field: ${key}.`) };
    const value = body[key];
    if (key === "source") {
      if (value !== "manual" && value !== "googlebooks" && value !== "openlibrary") {
        return { error: error("source", "Unknown metadata source.") };
      }
      nextSource = value;
      continue;
    }
    if (value === null) {
      if (key in next) {
        delete next[key as keyof MockOverride];
        changed = true;
      }
      continue;
    }
    if (key === "year" || key === "seriesIndex") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { error: error(key, `${key} must be a number or null.`) };
      }
      if (key === "year" && (!Number.isInteger(value) || value < 1 || value > new Date(now).getFullYear() + 1)) {
        return { error: error("year", "Year is out of range.") };
      }
      if (key === "seriesIndex" && (value < 0 || value > 9999 || Math.round(value * 100) !== value * 100)) {
        return { error: error("seriesIndex", "Series index is out of range.") };
      }
      next[key] = value;
      changed = true;
      continue;
    }
    const max = key === "title" ? 300 : key === "description" ? 5000 : key === "author" ? 200 : key === "language" ? 20 : 200;
    const text = textValue(key, value, max);
    if (typeof text !== "string") return { error: text };
    if (key === "isbn10" && !isValidIsbn10(normalizeIsbn(text))) {
      return { error: error("isbn10", "ISBN-10 checksum is invalid.") };
    }
    if (key === "isbn13" && !isValidIsbn13(normalizeIsbn(text))) {
      return { error: error("isbn13", "ISBN-13 checksum is invalid.") };
    }
    if (key === "language" && !LANGUAGE.test(text.toLowerCase())) {
      return { error: error("language", "Language must be a tag like en or pt-BR.") };
    }
    next[key as keyof MockOverride] = key === "isbn10" || key === "isbn13" ? normalizeIsbn(text) : key === "language" ? text.toLowerCase() : text;
    changed = true;
  }

  // Clearing the series clears its index; an explicit index without a series still fails.
  if (next.seriesIndex !== undefined && !effectiveSeries(next).trim()) {
    if (typeof body.seriesIndex === "number") {
      return { error: error("seriesIndex", "Add the series name before its index.") };
    }
    delete next.seriesIndex;
    changed = true;
  }
  const hasOverride = Object.keys(next).length > 0 || state.customCover;
  return {
    state: {
      ...state,
      override: next,
      source: hasOverride ? (nextSource ?? "manual") : null,
      updatedAt: changed || nextSource !== state.source ? now : state.updatedAt,
    },
  };
}

/** The `metadata` object of the detail response, built from the file values plus overrides. */
export function metadataOf(state: MockMetadataState): BookMetadata {
  const override = state.override;
  const hasAny = Object.keys(override).length > 0 || state.customCover;
  return {
    title: typeof override.title === "string" ? override.title : state.file.title,
    author: typeof override.author === "string" ? override.author : state.file.author,
    description: typeof override.description === "string" ? override.description : null,
    isbn10: typeof override.isbn10 === "string" ? override.isbn10 : null,
    isbn13: typeof override.isbn13 === "string" ? override.isbn13 : null,
    year: typeof override.year === "number" ? override.year : null,
    publisher: typeof override.publisher === "string" ? override.publisher : null,
    language: typeof override.language === "string" ? override.language : null,
    series: typeof override.series === "string" ? override.series : null,
    seriesIndex: typeof override.seriesIndex === "number" ? override.seriesIndex : null,
    file: state.file,
    overridden: {
      title: typeof override.title === "string",
      author: typeof override.author === "string",
      description: typeof override.description === "string",
      isbn10: typeof override.isbn10 === "string",
      isbn13: typeof override.isbn13 === "string",
      year: typeof override.year === "number",
      publisher: typeof override.publisher === "string",
      language: typeof override.language === "string",
      series: typeof override.series === "string",
      cover: state.customCover,
    },
    source: hasAny ? (state.source ?? "manual") : null,
    updatedAt: hasAny ? state.updatedAt : null,
  };
}
