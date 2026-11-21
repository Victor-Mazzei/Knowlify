import { useCallback, useEffect, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError, parseApiError } from "../../services/api";
import type { Book } from "../../types";
import type { BookIndexState, BookIndexStatus, IndexErrorCode } from "../indexing/types";
import type { BookDetail, BookMetadata, MetadataField, MetadataSource } from "./types";

const METADATA_FIELDS: readonly MetadataField[] = [
  "title",
  "author",
  "description",
  "isbn10",
  "isbn13",
  "year",
  "publisher",
  "language",
  "series",
  "cover",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOr = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
const optionalText = (value: unknown) => (typeof value === "string" ? value : null);
const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const timestampOr = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const INDEX_STATES: readonly BookIndexState[] = ["none", "pending", "indexing", "ready", "error"];
const INDEX_ERROR_CODES: readonly IndexErrorCode[] = [
  "no_text",
  "too_large",
  "unreadable",
  "embedder_failed",
  "unknown",
];

function normalizeIndex(value: unknown): BookIndexStatus | undefined {
  if (!isRecord(value)) return undefined;
  const state = value.state;
  if (typeof state !== "string" || !INDEX_STATES.includes(state as BookIndexState)) return undefined;
  const error = isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string" &&
    INDEX_ERROR_CODES.includes(value.error.code as IndexErrorCode)
    ? { code: value.error.code as IndexErrorCode, message: value.error.message }
    : null;
  return { state: state as BookIndexState, error };
}

function normalizeOverrides(value: unknown): Record<MetadataField, boolean> {
  const record = isRecord(value) ? value : {};
  const flags = {} as Record<MetadataField, boolean>;
  for (const field of METADATA_FIELDS) flags[field] = record[field] === true;
  return flags;
}

function normalizeSource(value: unknown): MetadataSource | null {
  return value === "manual" || value === "googlebooks" || value === "openlibrary" ? value : null;
}

/** Effective metadata plus the file fallback; an older server sends no `metadata` at all. */
function normalizeMetadata(value: unknown, book: Book): BookMetadata {
  const record = isRecord(value) ? value : {};
  const file = isRecord(record.file) ? record.file : {};
  return {
    title: textOr(record.title, book.title),
    author: textOr(record.author, book.author),
    description: optionalText(record.description),
    isbn10: optionalText(record.isbn10),
    isbn13: optionalText(record.isbn13),
    year: optionalNumber(record.year),
    publisher: optionalText(record.publisher),
    language: optionalText(record.language),
    series: optionalText(record.series),
    seriesIndex: optionalNumber(record.seriesIndex),
    file: { title: textOr(file.title, book.title), author: textOr(file.author, "") },
    overridden: normalizeOverrides(record.overridden),
    source: normalizeSource(record.source),
    updatedAt: typeof record.updatedAt === "number" || typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

/**
 * `GET /api/books/:id` is additive: a server that predates the details contract
 * still answers with the list DTO, so every new field falls back to a safe default.
 */
export function normalizeBookDetail(value: unknown): BookDetail | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const status = value.status === "pending" || value.status === "error" ? value.status : "ready";
  const book: Book = {
    id: value.id,
    title: value.title,
    author: textOr(value.author, ""),
    format: value.format === "pdf" ? "pdf" : "epub",
    size: optionalNumber(value.size) ?? 0,
    addedAt:
      typeof value.addedAt === "number" || typeof value.addedAt === "string" ? value.addedAt : 0,
    hasCover: value.hasCover === true,
    status,
    source: value.source === true,
    index: normalizeIndex(value.index),
    progress: isRecord(value.progress) && typeof value.progress.percentage === "number"
      ? {
          percentage: Math.max(0, Math.min(1, value.progress.percentage)),
          updatedAt: timestampOr(value.progress.updatedAt, 0),
        }
      : null,
    tagIds: Array.isArray(value.tagIds)
      ? value.tagIds.filter((id): id is string => typeof id === "string")
      : [],
    favorite: value.favorite === true,
    coverRev: optionalNumber(value.coverRev),
  };
  return {
    ...book,
    favorite: book.favorite === true,
    coverRev: book.coverRev ?? null,
    tagIds: book.tagIds ?? [],
    metadata: normalizeMetadata(value.metadata, book),
  };
}

export type BookDetailState = {
  book: BookDetail | null;
  loading: boolean;
  notFound: boolean;
  error: string;
  reload: () => void;
  /** Replaces the loaded detail after an edit, favorite or tag change. */
  update: (next: BookDetail) => void;
};

/** Loads one book's detail; a failed request keeps the previous book out of the way. */
export function useBook(api: ApiFn, bookId: string): BookDetailState {
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [request, setRequest] = useState(0);
  const reload = useCallback(() => setRequest((value) => value + 1), []);
  const update = useCallback((next: BookDetail) => setBook(next), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    setNotFound(false);
    setBook(null);
    void (async () => {
      try {
        const response = await api(`/api/books/${encodeURIComponent(bookId)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw await parseApiError(response);
        const detail = normalizeBookDetail(await response.json());
        if (!detail) throw new Error("The server returned an unexpected book.");
        if (active) setBook(detail);
      } catch (caught) {
        if (!active || controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(formatError(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, bookId, request]);

  return { book, loading, notFound, error, reload, update };
}
