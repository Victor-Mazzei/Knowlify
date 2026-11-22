/**
 * Metadata editing and external lookup (ADR-2/ADR-4). These are types only: the domain
 * rules live in `domain/library/BookMetadata.ts`, the orchestration in
 * `use-cases/BookMetadata.ts` and `use-cases/MetadataLookup.ts`, and the I/O in adapters.
 */

/** Where an override came from; `manual` is a typed edit, the others are external providers. */
export type MetadataSource = "manual" | "googlebooks" | "openlibrary";
export type ExternalMetadataSource = Exclude<MetadataSource, "manual">;

/**
 * A partial user edit (PATCH /api/books/:id/metadata). An absent key is unchanged and
 * `null` clears the override for that field; text is NFC, trimmed and free of control
 * characters after domain validation.
 */
export interface MetadataPatch {
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
  source?: MetadataSource;
}

/** One stored override row. A `null` field falls back to the value extracted from the file. */
export interface MetadataOverride {
  bookId: string;
  title: string | null;
  author: string | null;
  description: string | null;
  isbn10: string | null;
  isbn13: string | null;
  year: number | null;
  publisher: string | null;
  language: string | null;
  series: string | null;
  seriesIndex: number | null;
  /** Custom cover inside the app-managed `covers/` directory, or null for the file cover. */
  coverPath: string | null;
  source: MetadataSource;
  updatedAt: number;
}

/** Keys of the `overridden` flags in the detail response. */
export type MetadataField =
  | "title"
  | "author"
  | "description"
  | "isbn10"
  | "isbn13"
  | "year"
  | "publisher"
  | "language"
  | "series"
  | "cover";

/**
 * `metadata` object returned by `GET /api/books/:id`. The top-level values are the
 * effective ones; `file` keeps what the extractor last wrote and `overridden` tells the
 * UI which fields the user changed.
 */
export interface BookMetadataDetail {
  title: string;
  author: string;
  description: string | null;
  isbn10: string | null;
  isbn13: string | null;
  year: number | null;
  publisher: string | null;
  language: string | null;
  series: string | null;
  seriesIndex: number | null;
  file: { title: string; author: string };
  overridden: Record<MetadataField, boolean>;
  source: MetadataSource | null;
  updatedAt: number | null;
}

/** Canonical query built by the HTTP layer; exactly one of the two modes is present. */
export type MetadataLookupQuery = { isbn: string } | { title: string; author?: string };

/** One sanitized candidate returned by an external provider (never HTML). */
export interface MetadataCandidate {
  source: ExternalMetadataSource;
  id: string;
  title: string;
  authors: string[];
  description: string | null;
  isbn10: string | null;
  isbn13: string | null;
  publisher: string | null;
  year: number | null;
  language: string | null;
  /** Allowlisted HTTPS cover URL, or null when the provider has no usable cover. */
  coverUrl: string | null;
  /** Allowlisted HTTPS link to the provider page, or null. */
  link: string | null;
}

export type MetadataLookupErrorCode = "rate_limited" | "timeout" | "unavailable";

/**
 * Stable classification of a provider failure. It refines `code` for diagnostics and is
 * safe to log or return: it never carries provider text, a URL, the query or the key.
 */
export type MetadataLookupReason =
  | "key_unreadable"
  | "key_rejected"
  | "service_disabled"
  | "referrer_or_ip_blocked"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "http_error"
  | "network"
  | "blocked_destination"
  | "bad_response"
  | "timeout";

/** Diagnostic fields of a provider failure; optional so lightweight test doubles stay valid. */
export interface MetadataFailureDetails {
  readonly reason?: MetadataLookupReason;
  /** HTTP status of the provider response, when one arrived. */
  readonly status?: number;
  /** Transport/DNS/TLS code (ENOTFOUND, ECONNREFUSED, CERT_*, blocked...). */
  readonly networkCode?: string;
  /** Google's `error.status` (for example PERMISSION_DENIED). Never its message. */
  readonly errorStatus?: string;
  /**
   * Stable Google error identifier: the first `errors[].reason`, or a specific
   * `details[].reason` when the former is only `badRequest`/`forbidden`. Never its message.
   */
  readonly errorReason?: string;
}

/** Shape adapters throw (Error & this) so the use case can report partial failures. */
export interface MetadataLookupFailure extends MetadataFailureDetails {
  readonly code: MetadataLookupErrorCode;
}

/** One failed provider in the search response; `reason` is additive next to `code`. */
export interface MetadataLookupError {
  source: ExternalMetadataSource;
  code: MetadataLookupErrorCode;
  reason?: MetadataLookupReason;
}

/** Request-scoped failure log; the route passes the Fastify `req.log`. */
export interface MetadataFailureLogger {
  warn?(message: string): void;
}

/**
 * A fixed boolean or a resolver. The resolver form is read on every operation so a
 * change saved in Settings applies without restarting the server.
 */
export type LookupSwitch = boolean | (() => boolean);

/**
 * Per-request Google Books credential. `unreadable` means a stored envelope exists but
 * cannot be decrypted (the server secret changed): the adapter fails closed without
 * calling the provider instead of sending an unauthenticated request.
 */
export type GoogleBooksKeyResolution =
  | { state: "none" }
  | { state: "ok"; key: string }
  | { state: "unreadable" };

/**
 * Strategy per external service. Implementations return at most 8 already sanitized
 * candidates; a failure is thrown as `Error & MetadataLookupFailure` so one provider
 * never hides the results of the other.
 */
export interface MetadataProvider {
  readonly id: ExternalMetadataSource;
  /** Whether a provider credential is configured. The key itself is never exposed. */
  readonly keyConfigured: boolean;
  search(query: MetadataLookupQuery, signal: AbortSignal): Promise<MetadataCandidate[]>;
}

/** Downloads a cover from an allowlisted URL after the adapter applies the SSRF policy. */
export interface CoverFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<Buffer>;
}

/**
 * App-managed cover file (`covers/custom/<bookId>.jpg`). The adapter validates magic
 * bytes and dimensions, re-encodes to JPEG and writes atomically; it never touches a
 * library folder.
 */
export interface CustomCoverStore {
  /** Validates, re-encodes and stores the image; throws a typed image error on rejection. */
  save(bookId: string, data: Buffer): Promise<string>;
  /** Removes the custom cover of a book, if any. */
  remove(bookId: string): Promise<void>;
  /** Moves the custom cover to another book id (duplicate merge); null when absent. */
  move(fromBookId: string, toBookId: string): Promise<string | null>;
}

/**
 * Persistence of the override and of the effective values materialized in `books`
 * (ADR-2). Every write recomputes `books.title`, `books.author` and `books.cover_path`
 * from `COALESCE(override, file_*)` in the same transaction; callers never update those
 * columns directly.
 */
export interface BookMetadataRepository {
  /** Raw override row, or null when the book has none (or does not exist). */
  get(bookId: string): MetadataOverride | null;
  /** Upserts the override row; returns false when the book no longer exists. */
  save(override: MetadataOverride): boolean;
  /** Drops the override and restores the file values, including a custom cover. */
  reset(bookId: string): boolean;
  /**
   * Stores a custom cover path (null clears it) and the new `cover_rev`; a null revision
   * is stored as NULL. Returns false when the book no longer exists.
   */
  setCover(bookId: string, coverPath: string | null, coverRev: number | null, now: number): boolean;
  /**
   * Moves the override to another book when the target has none (duplicate merge, ADR-2).
   * The custom cover file is the caller's responsibility; `coverPath` in the moved row is
   * kept as-is. Returns false when there is nothing to move or the target already has one.
   */
  move(fromBookId: string, toBookId: string): boolean;
}
