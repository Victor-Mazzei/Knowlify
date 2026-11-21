import type { BookIndexStatus } from "./modules/indexing/types";

export type Format = "pdf" | "epub";
export type ReadFilter = "unread" | "reading" | "finished";
export type IndexFilter = "ready" | "pending" | "error";
export type Book = {
  id: string;
  title: string;
  author: string;
  format: Format;
  size: number;
  addedAt: number | string;
  hasCover: boolean;
  status: "pending" | "ready" | "error";
  source: boolean;
  /** Additive search-index state; absent on older servers. */
  index?: BookIndexStatus;
  /** Additive reading progress (0–1); absent or null when never read. */
  progress?: { percentage: number; updatedAt: number } | null;
  /** Additive tag ids; absent on older servers and from the legacy array response. */
  tagIds?: string[];
  /** Additive favorite flag; absent on older servers (treat as false). */
  favorite?: boolean;
  /** Additive custom-cover revision; append it as `?v=` to bypass the cover cache. */
  coverRev?: number | null;
};
export type BookSort = "added" | "title" | "lastRead" | "author" | "reading";
export type BookOrder = "asc" | "desc";

/**
 * Query for `GET /api/books`. Sending `limit` or `ids` selects the paged
 * envelope response; omitting both keeps the legacy array response.
 */
export type BookListQuery = {
  /** 1–200. */
  limit?: number;
  /** Opaque keyset cursor returned as `nextCursor` by the previous page. */
  cursor?: string;
  /** Up to 200 chars; matches title or author. */
  q?: string;
  /** Defaults to `added`. */
  sort?: BookSort;
  /** Defaults to `desc` for `added`/`lastRead` and `asc` for `title`/`author`. */
  order?: BookOrder;
  format?: Format;
  /** Statuses to include; the three together mean no filter. */
  read?: ReadFilter[];
  /** Index states to include; requires indexing to be enabled. */
  index?: IndexFilter[];
  /** Source ids and/or `upload`, up to 10. */
  source?: string[];
  /** True keeps only books with at least one note. */
  notes?: boolean;
  /** Tag ids (OR, at most 10) added by the tags contract. */
  tag?: string[];
  /** Keep only favorite books; the server accepts only `favorite=1`. */
  favorite?: boolean;
  /** Up to 100 book ids; ignores every other list parameter. */
  ids?: string[];
};

/** `GET /api/books` envelope returned when `limit` or `ids` is present. */
export type BookPage = {
  items: Book[];
  /** Cursor for the next page; null on the last page. */
  nextCursor: string | null;
  /** Total matching the current filters; with `ids`, the number of found items. */
  total: number;
};

/** Disjunctive counts from `GET /api/books/facets`. */
export type BookFacets = {
  total: number;
  format: Record<Format, number>;
  read: Record<ReadFilter, number>;
  /** Null when indexing is disabled on the server. */
  index: Record<IndexFilter, number> | null;
  source: { id: string; count: number }[];
  notes: { with: number };
  /** Disjunctive tag counts; absent when the server predates the tags contract. */
  tag?: { id: string; count: number }[];
  /** Disjunctive favorite count; absent when the server predates the favorites contract. */
  favorite?: { with: number };
};

/** Fixed palette key; the CSS tokens own the actual colors. */
export type TagColor = "gray" | "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "pink";
export type Tag = { id: string; name: string; color: TagColor; createdAt: number | string };
export type TagWithCount = Tag & { count: number };

/** Same CSV strings as the list query, plus the filter count the client reviewed. */
export type BookSelectionFilter = {
  q?: string;
  format?: Format;
  read?: string;
  index?: string;
  source?: string;
  notes?: string;
  author?: string;
  tag?: string;
  /** CSV flag (`1`) after the favorites contract; absent means every book. */
  favorite?: string;
};
export type BookSelection =
  | { ids: string[] }
  | { filter: BookSelectionFilter; expectedTotal: number };

export type DeleteDryRun = {
  books: number;
  notes: number;
  conversations: number;
  withProgress: number;
  indexed: number;
  managedFiles: number;
  externalBooks: number;
  wouldIgnore: number;
};
export type DeleteResult = {
  removed: number;
  missing: number;
  notesRemoved: number;
  ignored: number;
  filesRemoved: number;
  fileErrors: number;
  remaining: number;
};
/**
 * 409 `selection_changed` after a bulk deletion. `removed > 0` means earlier
 * blocks committed; the rest is reported so the client can review it again.
 */
export type DeletePartial = {
  removed: number;
  /** Present when the request selected explicit ids. */
  remainingIds?: string[];
  /** Present when the request selected a filter. */
  remainingTotal?: number;
};

export type IgnoredBook = {
  id: string;
  title: string;
  author: string;
  format: Format;
  size: number;
  path: string | null;
  sourceId: string | null;
  reason: "path" | "content" | "both";
  managed: boolean;
  ignoredAt: number | string;
};

export type Source = { id: string; path: string; accessible: boolean; books: number };
export type ScanStatus = { scanning: boolean; pending: number; lastScanAt?: number | string | null };
export type Credentials = { user: string; pass: string };
export type Progress = { position: string; percentage: number };

declare global { interface Window { __KNOWLIFY__?: { apiBaseUrl?: string; credentials?: Credentials | null } } }
