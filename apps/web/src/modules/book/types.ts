import type { Book } from "../../types";

/** Where a metadata override came from; `manual` is a typed edit. */
export type MetadataSource = "manual" | "googlebooks" | "openlibrary";
export type ExternalMetadataSource = Exclude<MetadataSource, "manual">;

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
 * Partial `PATCH /api/books/:id/metadata` body. An absent key is unchanged; `null`
 * clears the override for that field (the effective value falls back to the file).
 * Text is NFC, trimmed and free of control characters after server validation.
 */
export type MetadataPatch = {
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
};

/**
 * `metadata` object of `GET /api/books/:id`. Top-level values are effective; `file`
 * keeps what the extractor last wrote and `overridden` says what the user changed.
 */
export type BookMetadata = {
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
  updatedAt: number | string | null;
};

/** Detail response: the list DTO plus the fields the detail route always includes. */
export type BookDetail = Book & {
  favorite: boolean;
  coverRev: number | null;
  tagIds: string[];
  metadata: BookMetadata;
};

/** Exactly one lookup mode: ISBN, or title with an optional author. */
export type MetadataLookupQuery = { isbn: string } | { title: string; author?: string };

/** One sanitized provider candidate; `description` and links are plain text/HTTPS. */
export type MetadataCandidate = {
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
  coverUrl: string | null;
  link: string | null;
};

export type MetadataLookupErrorCode = "rate_limited" | "timeout" | "unavailable";

/** A provider that failed; the other provider may still have returned candidates. */
export type MetadataLookupError = { source: ExternalMetadataSource; code: MetadataLookupErrorCode };

export type MetadataSearchResult = {
  candidates: MetadataCandidate[];
  errors: MetadataLookupError[];
};

export type MetadataProviderStatus = { id: ExternalMetadataSource; keyConfigured: boolean };

/** Keys are never exposed: only whether the operator configured one. */
export type MetadataLookupStatus = { enabled: boolean; providers: MetadataProviderStatus[] };

/** Props shared by the metadata dialogs (scaffold stubs use the final shape). */
export type MetadataDialogProps = {
  book: BookDetail;
  onClose: () => void;
  onSaved: (book: BookDetail) => void;
};
