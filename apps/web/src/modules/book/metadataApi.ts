import type { ApiFn } from "../../components/dialogs";
import { ApiError, parseApiError } from "../../services/api";
import type {
  BookDetail,
  BookMetadata,
  MetadataCandidate,
  MetadataField,
  MetadataLookupError,
  MetadataLookupQuery,
  MetadataLookupReason,
  MetadataLookupStatus,
  MetadataPatch,
  MetadataSearchResult,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isNumberOrNull = (value: unknown): value is number | null => value === null || isNumber(value);
const isHttpsOrNull = (value: unknown): boolean => {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const METADATA_FIELDS: MetadataField[] = [
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

const LOOKUP_REASONS: readonly MetadataLookupReason[] = [
  "key_unreadable",
  "key_rejected",
  "service_disabled",
  "referrer_or_ip_blocked",
  "forbidden",
  "not_found",
  "rate_limited",
  "upstream_error",
  "http_error",
  "network",
  "blocked_destination",
  "bad_response",
  "timeout",
];
const isLookupReason = (value: unknown): value is MetadataLookupReason =>
  typeof value === "string" && (LOOKUP_REASONS as readonly string[]).includes(value);

/** A server that predates the metadata contract answers 200 with a list DTO (no `metadata`). */
export class MetadataUnsupportedError extends Error {
  constructor() {
    super("This server does not support editable book metadata.");
    this.name = "MetadataUnsupportedError";
  }
}

const isMetadata = (value: unknown): value is BookMetadata => {
  if (!isRecord(value)) return false;
  const file = value.file;
  const overridden = value.overridden;
  return (
    isText(value.title) &&
    isText(value.author) &&
    isTextOrNull(value.description) &&
    isTextOrNull(value.isbn10) &&
    isTextOrNull(value.isbn13) &&
    isNumberOrNull(value.year) &&
    isTextOrNull(value.publisher) &&
    isTextOrNull(value.language) &&
    isTextOrNull(value.series) &&
    isNumberOrNull(value.seriesIndex) &&
    isRecord(file) &&
    isText(file.title) &&
    isText(file.author) &&
    isRecord(overridden) &&
    METADATA_FIELDS.every((field) => typeof overridden[field] === "boolean") &&
    (value.source === null || value.source === "manual" || value.source === "googlebooks" || value.source === "openlibrary") &&
    (value.updatedAt === null || isText(value.updatedAt) || isNumber(value.updatedAt))
  );
};

const isCandidate = (value: unknown): value is MetadataCandidate =>
  isRecord(value) &&
  (value.source === "googlebooks" || value.source === "openlibrary") &&
  isText(value.id) &&
  isText(value.title) &&
  Array.isArray(value.authors) &&
  value.authors.every(isText) &&
  isTextOrNull(value.description) &&
  isTextOrNull(value.isbn10) &&
  isTextOrNull(value.isbn13) &&
  isTextOrNull(value.publisher) &&
  isNumberOrNull(value.year) &&
  isTextOrNull(value.language) &&
  isHttpsOrNull(value.coverUrl) &&
  isHttpsOrNull(value.link);

const isLookupError = (value: unknown): value is MetadataLookupError =>
  isRecord(value) &&
  (value.source === "googlebooks" || value.source === "openlibrary") &&
  (value.code === "rate_limited" || value.code === "timeout" || value.code === "unavailable");

/** Drops an unknown/future reason instead of rejecting the whole response. */
const readLookupError = (value: unknown): MetadataLookupError | null => {
  if (!isLookupError(value)) return null;
  return isLookupReason(value.reason)
    ? { source: value.source, code: value.code, reason: value.reason }
    : { source: value.source, code: value.code };
};

const isLookupStatus = (value: unknown): value is MetadataLookupStatus =>
  isRecord(value) &&
  typeof value.enabled === "boolean" &&
  Array.isArray(value.providers) &&
  value.providers.every(
    (provider) =>
      isRecord(provider) &&
      (provider.id === "googlebooks" || provider.id === "openlibrary") &&
      typeof provider.keyConfigured === "boolean",
  );

function readDetail(value: unknown): BookDetail {
  if (!isRecord(value)) throw new Error("The server sent an unexpected book detail.");
  if (!isMetadata(value.metadata)) throw new MetadataUnsupportedError();
  if (!isText(value.id)) throw new Error("The server sent an unexpected book detail.");
  return value as BookDetail;
}

async function detailRequest(api: ApiFn, path: string, init: RequestInit): Promise<BookDetail> {
  const response = await api(path, init);
  if (!response.ok) throw await parseApiError(response);
  return readDetail(await response.json());
}

const bookPath = (bookId: string, suffix = "") => `/api/books/${encodeURIComponent(bookId)}${suffix}`;
const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** `GET /api/books/:id` — the detail with effective metadata and override flags. */
export async function loadBookDetail(api: ApiFn, bookId: string): Promise<BookDetail> {
  return detailRequest(api, bookPath(bookId), {});
}

/** `PATCH /api/books/:id/metadata` — partial edit; returns the full detail. */
export async function updateBookMetadata(
  api: ApiFn,
  bookId: string,
  patch: MetadataPatch,
): Promise<BookDetail> {
  return detailRequest(api, bookPath(bookId, "/metadata"), jsonInit("PATCH", patch));
}

/** `DELETE /api/books/:id/metadata` — clears every override, including the custom cover. */
export async function resetBookMetadata(api: ApiFn, bookId: string): Promise<BookDetail> {
  return detailRequest(api, bookPath(bookId, "/metadata"), { method: "DELETE" });
}

/** `PUT /api/books/:id/cover` — multipart upload in the `file` field. */
export async function uploadBookCover(api: ApiFn, bookId: string, file: File): Promise<BookDetail> {
  const body = new FormData();
  body.set("file", file);
  return detailRequest(api, bookPath(bookId, "/cover"), { method: "PUT", body });
}

/** `POST /api/books/:id/cover/from-url` — allowlisted HTTPS cover URL. */
export async function setBookCoverFromUrl(api: ApiFn, bookId: string, url: string): Promise<BookDetail> {
  return detailRequest(api, bookPath(bookId, "/cover/from-url"), jsonInit("POST", { url }));
}

/** `DELETE /api/books/:id/cover` — restores the cover extracted from the file. */
export async function resetBookCover(api: ApiFn, bookId: string): Promise<BookDetail> {
  return detailRequest(api, bookPath(bookId, "/cover"), { method: "DELETE" });
}

/** `GET /api/metadata/status` — lookup availability; never includes API keys. */
export async function getMetadataStatus(api: ApiFn): Promise<MetadataLookupStatus> {
  const response = await api("/api/metadata/status");
  if (!response.ok) throw await parseApiError(response);
  const body: unknown = await response.json();
  if (!isLookupStatus(body)) throw new Error("The server sent an unexpected metadata status.");
  return body;
}

/** `GET /api/metadata/search` — ISBN xor title (+ optional author). */
export async function searchBookMetadata(
  api: ApiFn,
  query: MetadataLookupQuery,
): Promise<MetadataSearchResult> {
  const params = new URLSearchParams();
  if ("isbn" in query) params.set("isbn", query.isbn);
  else {
    params.set("title", query.title);
    if (query.author) params.set("author", query.author);
  }
  const response = await api(`/api/metadata/search?${params.toString()}`);
  if (!response.ok) throw await parseApiError(response);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.candidates) || !Array.isArray(body.errors)) {
    throw new Error("The server sent an unexpected metadata search.");
  }
  const candidates = body.candidates.filter(isCandidate);
  const errors = body.errors.map(readLookupError).filter((error): error is MetadataLookupError => error !== null);
  if (candidates.length !== body.candidates.length || errors.length !== body.errors.length) {
    throw new Error("The server sent an unexpected metadata search.");
  }
  return { candidates, errors };
}

/** A 404 on `/api/metadata/*` means a server without the lookup contract. */
export const isMetadataLookupUnsupported = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export const isMetadataLookupDisabled = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403 && error.code === "lookup_disabled";

/** Field name reported by a 400 from the metadata routes, when present. */
export function metadataErrorField(error: unknown): MetadataField | "seriesIndex" | null {
  if (!(error instanceof ApiError) || !error.details) return null;
  const field = error.details.field;
  if (field === "seriesIndex") return field;
  return typeof field === "string" && (METADATA_FIELDS as string[]).includes(field)
    ? (field as MetadataField)
    : null;
}
