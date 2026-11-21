import type { Book, BookOrder, BookPage, BookSort } from "../../types";
import { filtersQuery, type LibraryFilters } from "./libraryFilters";
import { readingStatusOf } from "./readingStatus";

export const BOOKS_PAGE_SIZE = 60;
export const LEGACY_CURSOR = "legacy:";

export type ListQuery = {
  query: string;
  sort: BookSort;
  order: BookOrder;
  filters: LibraryFilters;
};

export function booksPath({ query, sort, order, filters }: ListQuery, cursor?: string) {
  const params = filtersQuery(filters);
  params.set("limit", String(BOOKS_PAGE_SIZE));
  params.set("sort", sort);
  params.set("order", order);
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  return `/api/books?${params.toString()}`;
}

export function facetsPath({ query, filters }: { query: string; filters: LibraryFilters }) {
  const params = filtersQuery(filters);
  if (query) params.set("q", query);
  const suffix = params.toString();
  return suffix ? `/api/books/facets?${suffix}` : "/api/books/facets";
}

export function idsPath(ids: string[]) {
  return `/api/books?ids=${ids.map(encodeURIComponent).join(",")}`;
}

export function isBookPage(value: unknown): value is BookPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Partial<BookPage>;
  return Array.isArray(page.items) && typeof page.total === "number" && (page.nextCursor === null || typeof page.nextCursor === "string");
}

/** Older servers return the whole array: keep it in memory but expose one page at a time. */
export function legacyWindow(all: Book[], offset: number) {
  const items = all.slice(offset, offset + BOOKS_PAGE_SIZE);
  const next = offset + items.length;
  return { items, nextCursor: next < all.length ? `${LEGACY_CURSOR}${next}` : null };
}

/** Legacy arrays only need a local sort; the server never received the new parameters. */
export function sortLegacy(all: Book[], sort: BookSort) {
  if (sort === "title") return [...all].sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "author") return [...all].sort((a, b) => a.author.localeCompare(b.author));
  if (sort === "lastRead") {
    return all
      .filter((book) => book.progress != null)
      .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0));
  }
  if (sort === "reading") {
    // Mirror the server's two segments: in-reading by last read, then the rest by added.
    const inReading = all
      .filter((book) => readingStatusOf(book.progress?.percentage) === "reading")
      .sort(
        (a, b) =>
          (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0) || b.id.localeCompare(a.id),
      );
    const rest = all
      .filter((book) => readingStatusOf(book.progress?.percentage) !== "reading")
      .sort((a, b) => timestampOf(b.addedAt) - timestampOf(a.addedAt) || b.id.localeCompare(a.id));
    return [...inReading, ...rest];
  }
  return all;
}

const timestampOf = (value: number | string) => (typeof value === "number" ? value : Date.parse(value));

export function mergeById(current: Book[], incoming: Book[]) {
  const seen = new Set(current.map((book) => book.id));
  return [...current, ...incoming.filter((book) => !seen.has(book.id))];
}

/** A book can change while the list is on screen: metadata import or search indexing. */
export function needsHydration(book: Book) {
  return book.status === "pending" || book.index?.state === "pending" || book.index?.state === "indexing";
}
