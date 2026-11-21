import type { BookMetadata, MetadataField, MetadataPatch } from "../types";
import { normalizeIsbn, isValidIsbn10, isValidIsbn13 } from "./isbn";

/** Editable fields with a text input in the manual form. */
export type MetadataDraft = {
  title: string;
  author: string;
  description: string;
  isbn10: string;
  isbn13: string;
  year: string;
  publisher: string;
  language: string;
  series: string;
  seriesIndex: string;
};

export type DraftField = keyof MetadataDraft;
export type FieldErrors = Partial<Record<DraftField | "form", string>>;

export const METADATA_LIMITS = {
  title: 300,
  author: 200,
  description: 5000,
  publisher: 200,
  language: 20,
  series: 200,
  year: 9999,
  seriesIndex: 9999,
} as const;

export const FIELD_LABELS: Record<DraftField, string> = {
  title: "Title",
  author: "Author",
  description: "Description",
  isbn10: "ISBN-10",
  isbn13: "ISBN-13",
  year: "Year",
  publisher: "Publisher",
  language: "Language",
  series: "Series",
  seriesIndex: "Series index",
};

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function draftFromMetadata(metadata: BookMetadata): MetadataDraft {
  return {
    title: metadata.title,
    author: metadata.author,
    description: metadata.description ?? "",
    isbn10: metadata.isbn10 ?? "",
    isbn13: metadata.isbn13 ?? "",
    year: metadata.year?.toString() ?? "",
    publisher: metadata.publisher ?? "",
    language: metadata.language ?? "",
    series: metadata.series ?? "",
    seriesIndex: metadata.seriesIndex?.toString() ?? "",
  };
}

const tooLong = (value: string, max: number, label: string) =>
  value.length > max ? `${label} must be at most ${max} characters.` : undefined;

/**
 * Mirrors the server's domain validation so most mistakes stay in the dialog.
 * Fields staged for reset are not sent, so their draft values are not validated.
 */
export function validateDraft(
  draft: MetadataDraft,
  now = new Date(),
  cleared: ReadonlySet<MetadataField> = new Set(),
): FieldErrors {
  const errors: FieldErrors = {};
  const title = draft.title.trim();
  if (!cleared.has("title")) {
    if (!title) errors.title = "Title is required.";
    else if (title.length > METADATA_LIMITS.title) errors.title = tooLong(title, METADATA_LIMITS.title, "Title");
  }

  for (const field of ["author", "description", "publisher", "series"] as const) {
    if (cleared.has(field)) continue;
    const value = draft[field].trim();
    const error = tooLong(value, METADATA_LIMITS[field], FIELD_LABELS[field]);
    if (error) errors[field] = error;
    else if (field !== "description" && CONTROL.test(value)) {
      errors[field] = `${FIELD_LABELS[field]} contains control characters.`;
    }
  }

  const isbn10 = normalizeIsbn(draft.isbn10);
  if (!cleared.has("isbn10") && isbn10 && !isValidIsbn10(isbn10)) {
    errors.isbn10 = "ISBN-10 must have 10 characters and a valid check digit.";
  }
  const isbn13 = normalizeIsbn(draft.isbn13);
  if (!cleared.has("isbn13") && isbn13 && !isValidIsbn13(isbn13)) {
    errors.isbn13 = "ISBN-13 must have 13 digits and a valid check digit.";
  }

  const year = draft.year.trim();
  if (!cleared.has("year") && year) {
    const parsed = Number(year);
    const max = Math.min(METADATA_LIMITS.year, now.getFullYear() + 1);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      errors.year = `Year must be a whole number from 1 to ${max}.`;
    }
  }

  const language = draft.language.trim().toLowerCase();
  if (!cleared.has("language") && language && (!LANGUAGE.test(language) || language.length > METADATA_LIMITS.language)) {
    errors.language = "Use a language tag like en or pt-BR.";
  }

  const seriesIndex = draft.seriesIndex.trim();
  if (seriesIndex && !cleared.has("series")) {
    const parsed = Number(seriesIndex);
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(seriesIndex) || parsed > METADATA_LIMITS.seriesIndex) {
      errors.seriesIndex = "Series index must be up to 4 digits with at most 2 decimals.";
    } else if (!draft.series.trim()) {
      errors.seriesIndex = "Add the series name before its index.";
    }
  }
  return errors;
}

const optionalText = (
  patch: MetadataPatch,
  field: "description" | "publisher" | "language" | "series" | "isbn10" | "isbn13",
  value: string,
  before: string,
  overridden: boolean,
) => {
  const normalized = field === "language" ? value.toLowerCase() : field.startsWith("isbn") ? value.replace(/[\s-]/g, "").toUpperCase() : value;
  if (normalized === before) return;
  if (!normalized) {
    if (overridden) patch[field] = null;
    return;
  }
  patch[field] = normalized;
};

const asNumber = (value: string): number | null => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
};

/**
 * Turns the draft into the partial PATCH body. Fields left untouched are omitted so the
 * server keeps their override; reset fields that already had an override become `null`.
 */
export function patchFromDraft(
  draft: MetadataDraft,
  metadata: BookMetadata,
  cleared: ReadonlySet<MetadataField>,
): MetadataPatch {
  const patch: MetadataPatch = {};
  const overridden = metadata.overridden;

  if (cleared.has("title")) {
    if (overridden.title) patch.title = null;
  } else {
    const title = draft.title.trim();
    if (title !== metadata.title) patch.title = title;
  }

  if (cleared.has("author")) {
    if (overridden.author) patch.author = null;
  } else {
    const author = draft.author.trim();
    if (author !== metadata.author) patch.author = author;
  }

  for (const field of ["description", "publisher", "language", "isbn10", "isbn13", "series"] as const) {
    if (cleared.has(field)) {
      if (overridden[field]) patch[field] = null;
      continue;
    }
    optionalText(patch, field, draft[field].trim(), metadata[field] ?? "", overridden[field]);
  }

  if (cleared.has("year")) {
    if (overridden.year) patch.year = null;
  } else {
    const year = asNumber(draft.year);
    if (year !== metadata.year) patch.year = year;
  }

  if (cleared.has("series")) {
    if (overridden.series) patch.series = null;
    if (metadata.seriesIndex !== null) patch.seriesIndex = null;
  } else {
    const seriesIndex = asNumber(draft.seriesIndex);
    if (seriesIndex !== metadata.seriesIndex) patch.seriesIndex = seriesIndex;
  }

  const assignsValue = Object.entries(patch).some(([key, value]) => key !== "source" && value !== null);
  if (assignsValue) patch.source = "manual";
  return patch;
}

export type FieldOrigin = "edited" | "file" | "unset";

/** Whether a field shows the user's value, the file value, or no value at all. */
export function fieldOrigin(
  field: DraftField,
  draft: MetadataDraft,
  metadata: BookMetadata,
  cleared: ReadonlySet<MetadataField>,
): FieldOrigin {
  if (field === "seriesIndex") return draft.seriesIndex.trim() ? "edited" : "unset";
  if (cleared.has(field)) return field === "title" || field === "author" ? "file" : "unset";
  if (metadata.overridden[field]) return "edited";
  if (field === "title" || field === "author") {
    return draft[field].trim() === metadata.file[field] ? "file" : "edited";
  }
  return draft[field].trim() ? "edited" : "unset";
}

export function originLabel(origin: FieldOrigin): string {
  return origin === "edited" ? "Edited" : origin === "file" ? "From file" : "Not set";
}
