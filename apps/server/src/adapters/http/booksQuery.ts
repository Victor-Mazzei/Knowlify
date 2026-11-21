import { ValidationError } from "../../domain/errors.js";
import type { BookFilters, BookIndexStatus, BookListQuery, BookSort } from "../../ports/index.js";
import type { ReadingStatus } from "../../domain/reading/ReadingStatus.js";

export interface BooksQuerystring {
  limit?: string;
  cursor?: string;
  q?: string;
  sort?: string;
  order?: string;
  format?: string;
  ids?: string;
  read?: string;
  index?: string;
  source?: string;
  notes?: string;
  author?: string;
  tag?: string;
  favorite?: string;
}

export const MAX_LIST_LIMIT = 200;
export const MAX_LIST_IDS = 100;
export const MAX_SEARCH_CHARS = 200;
export const MAX_AUTHOR_CHARS = 200;
const MAX_SOURCE_FILTERS = 10;
const MAX_TAG_FILTERS = 10;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const READ_VALUES: readonly ReadingStatus[] = ["unread", "reading", "finished"];
const INDEX_VALUES: readonly BookIndexStatus[] = ["ready", "pending", "error"];
const SORTS: readonly BookSort[] = ["added", "title", "lastRead", "author", "reading"];

export const queryValue = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${name} must be a single value`);
  return value;
};

export const queryEnum = <T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
  fallback: T,
): T => {
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new ValidationError(`${name} must be one of: ${values.join(", ")}`);
  return value as T;
};

export const queryOptionalEnum = <T extends string>(
  value: string | undefined,
  name: string,
  values: readonly T[],
): T | undefined => {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new ValidationError(`${name} must be one of: ${values.join(", ")}`);
  return value as T;
};

export const queryLimit = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
};

export const queryIds = (value: string): string[] => {
  const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_LIST_IDS) throw new ValidationError(`ids accepts at most ${MAX_LIST_IDS} values`);
  return ids;
};

/** CSV list of whitelisted values; empty entries are ignored, duplicates collapsed. */
const queryCsv = <T extends string>(value: string | undefined, name: string, values: readonly T[]): T[] => {
  if (value === undefined) return [];
  const parsed = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  for (const part of parsed) {
    if (!values.includes(part as T)) throw new ValidationError(`${name} must be one of: ${values.join(", ")}`);
  }
  return parsed as T[];
};

const querySources = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  const sources = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (sources.length > MAX_SOURCE_FILTERS) {
    throw new ValidationError(`source accepts at most ${MAX_SOURCE_FILTERS} values`);
  }
  const invalid = sources.find((source) => !SOURCE_ID.test(source));
  if (invalid !== undefined) {
    throw new ValidationError("source ids must match ^[A-Za-z0-9_-]{1,64}$");
  }
  return sources;
};

const queryTags = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  const tags = [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
  if (tags.length > MAX_TAG_FILTERS) {
    throw new ValidationError(`tag accepts at most ${MAX_TAG_FILTERS} values`);
  }
  const invalid = tags.find((tag) => !TAG_ID.test(tag));
  if (invalid !== undefined) {
    throw new ValidationError("tag ids must match ^[A-Za-z0-9_-]{1,64}$");
  }
  return tags;
};

/**
 * Parses and validates the additive list filters (contract frozen in
 * docs/planner/2026-11-07-library-filters.md). Unknown parameters are ignored on purpose so
 * a newer client keeps working against an older server for the parameters it does not use.
 */
export function parseBookFilters(
  query: BooksQuerystring,
  indexingEnabled: boolean,
): BookFilters {
  const rawQ = queryValue(query.q, "q");
  if (rawQ !== undefined && rawQ.length > MAX_SEARCH_CHARS) {
    throw new ValidationError(`q accepts at most ${MAX_SEARCH_CHARS} characters`);
  }
  const q = rawQ?.trim() || undefined;
  const rawAuthor = queryValue(query.author, "author");
  if (rawAuthor !== undefined && rawAuthor.length > MAX_AUTHOR_CHARS) {
    throw new ValidationError(`author accepts at most ${MAX_AUTHOR_CHARS} characters`);
  }
  const author = rawAuthor?.trim() || undefined;
  const format = queryOptionalEnum(queryValue(query.format, "format"), "format", ["pdf", "epub"] as const);
  const read = queryCsv(queryValue(query.read, "read"), "read", READ_VALUES);
  const index = queryCsv(queryValue(query.index, "index"), "index", INDEX_VALUES);
  if (index.length > 0 && !indexingEnabled) throw new ValidationError("indexing is disabled");
  const source = querySources(queryValue(query.source, "source"));
  const tag = queryTags(queryValue(query.tag, "tag"));
  const notesValue = queryValue(query.notes, "notes");
  if (notesValue !== undefined && notesValue !== "0" && notesValue !== "1") {
    throw new ValidationError("notes must be 0 or 1");
  }
  const favoriteValue = queryValue(query.favorite, "favorite");
  // Only the positive filter exists; anything else (including 0) is a client error.
  if (favoriteValue !== undefined && favoriteValue !== "1") {
    throw new ValidationError("favorite must be 1");
  }
  return {
    ...(q !== undefined ? { q } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(format !== undefined ? { format } : {}),
    // The three statuses together select every book, so the filter is redundant.
    ...(read.length > 0 && read.length < 3 ? { read } : {}),
    ...(index.length > 0 ? { index } : {}),
    ...(source.length > 0 ? { source } : {}),
    ...(tag.length > 0 ? { tag } : {}),
    ...(notesValue === "1" ? { notes: true } : {}),
    ...(favoriteValue === "1" ? { favorite: true } : {}),
  };
}

export const defaultOrder = (sort: BookSort): "asc" | "desc" => (sort === "title" || sort === "author" ? "asc" : "desc");

export function parseBookListQuery(query: BooksQuerystring, indexingEnabled: boolean): BookListQuery {
  const filters = parseBookFilters(query, indexingEnabled);
  const limit = queryLimit(queryValue(query.limit, "limit"));
  const sort = queryEnum(queryValue(query.sort, "sort"), "sort", SORTS, "added");
  const order = queryEnum(queryValue(query.order, "order"), "order", ["asc", "desc"] as const, defaultOrder(sort));
  if (sort === "reading" && order !== "desc") {
    throw new ValidationError("order must be desc for sort=reading");
  }
  const cursor = queryValue(query.cursor, "cursor");
  return {
    ...filters,
    limit,
    sort,
    order,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}
