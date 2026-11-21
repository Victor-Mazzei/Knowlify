import type { Book, BookFacets, BookOrder, BookSort, Format, IndexFilter, ReadFilter, Tag } from "../../types";
import {
  INDEX_FILTERS,
  MAX_QUERY_LENGTH,
  MAX_SOURCES,
  MAX_TAGS,
  READ_FILTERS,
  SOURCE_ID_PATTERN,
  TAG_ID_PATTERN,
} from "./libraryFilters";
import { readingStatusOf } from "./readingStatus";

export type MockListQuery = {
  q: string;
  sort: BookSort;
  order: BookOrder;
  format: Format | null;
  read: ReadFilter[];
  index: IndexFilter[];
  source: string[];
  notes: boolean;
  favorite: boolean;
  tag: string[];
};

export type MockOptions = { facets: boolean; indexing: boolean; favorites: boolean };

type ParseResult = { ok: true; query: MockListQuery } | { ok: false; message: string };

type Dimension = "format" | "read" | "index" | "source" | "notes" | "favorite" | "tag";

type Cursor = {
  v: 2;
  sort: BookSort;
  order: BookOrder;
  signature: string;
  value: string | number;
  id: string;
};

const SORTS: readonly BookSort[] = ["added", "title", "lastRead", "author", "reading"];
/** The mock library always knows two folders, even when every book lives elsewhere. */
export const KNOWN_SOURCE_IDS = ["source-1", "source-2"] as const;

const bad = (message: string): ParseResult => ({ ok: false, message });

function hash(value: string) {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) % 1_000_003;
  return result;
}

const numericId = (book: Book) => numericIdOf(book.id);
export function numericIdOf(id: string): number {
  const digits = id.replace(/\D/g, "");
  return digits ? Number(digits) : hash(id);
}

/** Deterministic stand-in for `books.source_id`: two folders plus uploads. */
export function sourceIdOf(book: Book): string {
  return book.source ? `source-${(numericId(book) % 2) + 1}` : "upload";
}

/** Deterministic stand-in for `notes.book_id`; one in twenty books. */
export function hasNotes(book: Book): boolean {
  return numericId(book) % 20 === 0;
}

export function indexStateOf(book: Book): IndexFilter | "none" {
  const state = book.index?.state;
  if (state === "ready" || state === "error") return state;
  if (book.status === "error") return "none";
  return "pending";
}

const parsedCsv = <T extends string>(raw: string | null, allowed: readonly T[]): T[] | null => {
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => !(allowed as readonly string[]).includes(value))) return null;
  return [...new Set(values)] as T[];
};

export function parseMockQuery(params: URLSearchParams, options: MockOptions): ParseResult {
  const rawQ = params.get("q") ?? "";
  if (rawQ.length > MAX_QUERY_LENGTH) return bad(`q accepts at most ${MAX_QUERY_LENGTH} characters`);
  const q = rawQ.trim();
  const rawFormat = params.get("format");
  if (rawFormat !== null && rawFormat !== "pdf" && rawFormat !== "epub") return bad("Invalid format");
  const format = rawFormat as Format | null;
  const rawSort = params.get("sort");
  const sort = (rawSort ?? "added") as BookSort;
  const extendedSort = sort === "lastRead" || sort === "author" || sort === "reading";
  if (!SORTS.includes(sort) || (!options.facets && extendedSort)) return bad("Invalid sort");
  const rawOrder = params.get("order");
  if (rawOrder !== null && rawOrder !== "asc" && rawOrder !== "desc") return bad("Invalid order");
  if (sort === "reading" && rawOrder === "asc") return bad("order must be desc for sort=reading");
  const order: BookOrder = rawOrder ?? (sort === "title" || sort === "author" ? "asc" : "desc");
  if (!options.facets) {
    // An older server ignores unknown parameters: only the original query shape applies.
    return {
      ok: true,
      query: { q, sort, order, format, read: [], index: [], source: [], notes: false, favorite: false, tag: [] },
    };
  }
  const read = parsedCsv(params.get("read"), READ_FILTERS);
  if (!read) return bad("Invalid read filter");
  const index = parsedCsv(params.get("index"), INDEX_FILTERS);
  if (!index) return bad("Invalid index filter");
  if (!options.indexing && params.has("index")) return bad("indexing is disabled");
  const rawSource = params.get("source");
  const sources = rawSource
    ? [...new Set(rawSource.split(",").map((value) => value.trim()).filter(Boolean))]
    : [];
  if (sources.length > MAX_SOURCES) return bad(`source accepts at most ${MAX_SOURCES} ids`);
  if (sources.some((value) => !SOURCE_ID_PATTERN.test(value))) return bad("Invalid source filter");
  const rawTag = params.get("tag");
  const tags = rawTag ? [...new Set(rawTag.split(",").map((value) => value.trim()).filter(Boolean))] : [];
  if (tags.length > MAX_TAGS) return bad(`tag accepts at most ${MAX_TAGS} ids`);
  if (tags.some((value) => !TAG_ID_PATTERN.test(value))) return bad("Invalid tag filter");
  const rawNotes = params.get("notes");
  if (rawNotes !== null && rawNotes !== "0" && rawNotes !== "1") return bad("Invalid notes filter");
  const rawFavorite = params.get("favorite");
  if (options.favorites && rawFavorite !== null && rawFavorite !== "1") return bad("Invalid favorite filter");
  return {
    ok: true,
    query: {
      q,
      sort,
      order,
      format,
      read,
      index,
      source: sources,
      notes: rawNotes === "1",
      favorite: options.favorites && rawFavorite === "1",
      tag: tags,
    },
  };
}

const matches = (book: Book, query: MockListQuery, ignore?: Dimension) => {
  if (ignore !== "format" && query.format && book.format !== query.format) return false;
  if (ignore !== "read" && query.read.length && !query.read.includes(readingStatusOf(book.progress?.percentage))) return false;
  if (ignore !== "index" && query.index.length) {
    const state = indexStateOf(book);
    if (state === "none" || !query.index.includes(state)) return false;
  }
  if (ignore !== "source" && query.source.length && !query.source.includes(sourceIdOf(book))) return false;
  if (ignore !== "notes" && query.notes && !hasNotes(book)) return false;
  if (ignore !== "favorite" && query.favorite && !book.favorite) return false;
  if (ignore !== "tag" && query.tag.length && !(book.tagIds ?? []).some((id) => query.tag.includes(id))) return false;
  const needle = query.q.toLocaleLowerCase();
  return !needle || book.title.toLocaleLowerCase().includes(needle) || book.author.toLocaleLowerCase().includes(needle);
};

export function matchesListQuery(book: Book, query: MockListQuery): boolean {
  return matches(book, query);
}

const timestamp = (value: number | string) => (typeof value === "number" ? value : Date.parse(value));

const sortValue = (book: Book, sort: BookSort): string | number => {
  if (sort === "title") return book.title.toLocaleLowerCase();
  if (sort === "author") return book.author.toLocaleLowerCase();
  if (sort === "lastRead") return book.progress?.updatedAt ?? 0;
  if (sort === "reading") {
    // One numeric key holds both server segments: rank first, then the segment's own time.
    const inReading = readingStatusOf(book.progress?.percentage) === "reading";
    const time = inReading ? (book.progress?.updatedAt ?? 0) : timestamp(book.addedAt);
    return (inReading ? 1 : 0) * 2_000_000_000_000_000 + time;
  }
  return timestamp(book.addedAt);
};

const sortedBooks = (books: Book[], query: MockListQuery) => {
  const rows = query.sort === "lastRead" ? books.filter((book) => book.progress != null) : books;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, query.sort);
    const bv = sortValue(b, query.sort);
    const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    if (compared !== 0) return query.order === "asc" ? compared : -compared;
    return query.order === "asc" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  });
};

const querySignature = (query: MockListQuery) =>
  JSON.stringify([
    query.q,
    query.format,
    query.read,
    query.index,
    query.source,
    query.notes,
    query.favorite,
    query.tag,
  ]);

const encodeCursor = (cursor: Cursor) =>
  btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const decodeCursor = (value: string): Cursor | null => {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed: unknown = JSON.parse(atob(normalized));
    if (typeof parsed !== "object" || parsed === null) return null;
    const cursor = parsed as Partial<Cursor>;
    return cursor.v === 2 &&
      SORTS.includes(cursor.sort as BookSort) &&
      (cursor.order === "asc" || cursor.order === "desc") &&
      typeof cursor.signature === "string" &&
      typeof cursor.id === "string" &&
      (typeof cursor.value === "string" || typeof cursor.value === "number")
      ? (cursor as Cursor)
      : null;
  } catch {
    return null;
  }
};

const afterCursor = (book: Book, query: MockListQuery, cursor: Cursor) => {
  const value = sortValue(book, query.sort);
  if (value === cursor.value) return query.order === "asc" ? book.id > cursor.id : book.id < cursor.id;
  return query.order === "asc" ? value > cursor.value : value < cursor.value;
};

export function listPage(books: Book[], query: MockListQuery, limit: number, rawCursor: string | null) {
  const matched = sortedBooks(books.filter((book) => matches(book, query)), query);
  let remaining = matched;
  if (rawCursor) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor || cursor.sort !== query.sort || cursor.order !== query.order || cursor.signature !== querySignature(query)) {
      return { error: "Invalid cursor" as const };
    }
    remaining = matched.filter((book) => afterCursor(book, query, cursor));
  }
  const items = remaining.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    last && remaining.length > limit
      ? encodeCursor({
          v: 2,
          sort: query.sort,
          order: query.order,
          signature: querySignature(query),
          value: sortValue(last, query.sort),
          id: last.id,
        })
      : null;
  return { items, nextCursor, total: matched.length };
}

export function computeFacets(
  books: Book[],
  query: MockListQuery,
  indexing: boolean,
  tags: Tag[] = [],
  favorites = true,
): BookFacets {
  const matching = (ignore?: Dimension) => books.filter((book) => matches(book, query, ignore));
  const count = (ignore: Dimension, predicate: (book: Book) => boolean) => matching(ignore).filter(predicate).length;
  const sourceIds = [...new Set([...KNOWN_SOURCE_IDS, ...books.map(sourceIdOf), "upload"])].sort();
  const tagMatching = matching("tag");
  return {
    total: matching().length,
    format: {
      pdf: count("format", (book) => book.format === "pdf"),
      epub: count("format", (book) => book.format === "epub"),
    },
    read: {
      unread: count("read", (book) => readingStatusOf(book.progress?.percentage) === "unread"),
      reading: count("read", (book) => readingStatusOf(book.progress?.percentage) === "reading"),
      finished: count("read", (book) => readingStatusOf(book.progress?.percentage) === "finished"),
    },
    index: indexing
      ? {
          ready: count("index", (book) => indexStateOf(book) === "ready"),
          pending: count("index", (book) => indexStateOf(book) === "pending"),
          error: count("index", (book) => indexStateOf(book) === "error"),
        }
      : null,
    source: sourceIds.map((id) => ({ id, count: matching("source").filter((book) => sourceIdOf(book) === id).length })),
    notes: { with: count("notes", hasNotes) },
    ...(favorites ? { favorite: { with: count("favorite", (book) => book.favorite === true) } } : {}),
    tag: tags.map((tag) => ({
      id: tag.id,
      count: tagMatching.filter((book) => (book.tagIds ?? []).includes(tag.id)).length,
    })),
  };
}
