import type { Book } from "../domain/library/Book.js";
import type { ReadingStatus } from "../domain/reading/ReadingStatus.js";

export type BookSort = "added" | "title" | "lastRead" | "author" | "reading";
export type BookOrder = "asc" | "desc";
export type BookIndexStatus = "ready" | "pending" | "error";

/**
 * Filters shared by the page, its `total` and the facets endpoint. Lists combine with OR
 * inside a parameter and AND across parameters; the HTTP layer validates and dedupes them.
 */
export interface BookFilters {
  /** Title/author search, limited to 200 chars by the HTTP layer. */
  q?: string;
  format?: Book["format"];
  /** Reading status; all three together are equivalent to no filter. */
  read?: ReadingStatus[];
  index?: BookIndexStatus[];
  /** Source ids; `upload` matches books without a source. */
  source?: string[];
  notes?: boolean;
  /**
   * Exact author match (NOCASE) used by the list and facets; the HTTP layer caps it at 200
   * characters and trims surrounding whitespace.
   */
  author?: string;
  /** Tag ids; OR inside the list and AND across parameters (ADR-6). */
  tag?: string[];
  /** Only books flagged as favorites (ADR-1); there is no "not favorite" filter. */
  favorite?: boolean;
}

/**
 * One page of the library list (ADR-A1). The HTTP layer validates ranges and
 * decodes the opaque keyset cursor before calling the read model.
 */
export interface BookListQuery extends BookFilters {
  /** Page size, 1..200 (validated at the boundary). */
  limit: number;
  /** Cursor produced by a previous page with the same filters/sort/order. */
  cursor?: string;
  sort?: BookSort;
  order?: BookOrder;
}

/** Filters that must match between `page()`, `count()` and `facets()` so totals are consistent. */
export type BookListFilter = BookFilters;

/**
 * A book plus the key of its sort column. The adapter needs the raw key to
 * build the next keyset cursor without another query.
 */
export interface BookPageRow {
  book: Book;
  sortValue: number | string;
  /** `sort=reading` pages two segments: 0 = in progress, 1 = everything else. */
  segment?: 0 | 1;
}

export interface BookPage {
  rows: BookPageRow[];
  nextCursor: string | null;
}

/** Disjunctive counts for the filter panel: each dimension ignores its own filter. */
export interface BookFacets {
  total: number;
  format: Record<Book["format"], number>;
  read: Record<ReadingStatus, number>;
  /** `null` when indexing is disabled; the UI hides the whole group. */
  index: Record<BookIndexStatus, number> | null;
  /** Every known source (with `count: 0` when empty) plus `upload` for books without one. */
  source: Array<{ id: string; count: number }>;
  /** Every known tag (with `count: 0` when empty); disjunctive like `source`. */
  tag: Array<{ id: string; count: number }>;
  notes: { with: number };
  /** Disjunctive like `notes`: other filters apply, the favorite filter itself does not. */
  favorite: { with: number };
}

/** Read model behind `GET /api/books` (ADR-A1/A2), implemented by server-list. */
export interface BookListReader {
  page(query: BookListQuery): BookPage;
  count(filter?: BookListFilter, options?: { requireProgress?: boolean }): number;
  byIds(ids: string[]): Book[];
  /** Ids matched by a filter, up to `limit`; used by bulk selections (ADR-7). */
  matchingIds(filter: BookListFilter, limit: number): string[];
  /** Offset page used by OPDS feeds (`?page=N`); the JSON API stays cursor-only. */
  catalogPage(filter: BookListFilter, limit: number, offset: number): Book[];
  facets(filter?: BookListFilter, options?: { indexingEnabled?: boolean }): BookFacets;
}
