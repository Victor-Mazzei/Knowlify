import { FINISHED_AT, UNSTARTED_BELOW, type ReadingStatus } from "../../domain/reading/ReadingStatus.js";
import type { BookFilters, BookIndexStatus } from "../../ports/index.js";

export type SqlValue = string | number;

export interface FilterSql {
  /** Boolean expression without the `WHERE` keyword; empty when nothing is filtered. */
  sql: string;
  params: SqlValue[];
}

export type BookFilterDimension = "format" | "read" | "index" | "source" | "notes" | "tag" | "favorite";

export interface FilterSqlOptions {
  /** Facets ignore their own dimension but still apply every other filter. */
  exclude?: BookFilterDimension;
  /**
   * `sort=lastRead` drives the page from a `web_progress` join, so read predicates read the
   * joined row instead of a correlated lookup.
   */
  progressAlias?: string;
  /**
   * Counts behind a lastRead page: only books with progress are considered, and "unread"
   * (no progress row) can never match. Reading/finished keep the correlated predicate.
   */
  lastRead?: boolean;
}

const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

const unique = <T extends string>(values: readonly T[] | undefined): T[] =>
  values === undefined ? [] : [...new Set(values)];

/**
 * Canonical form used by the cursor signature and by the SQL builder. The three reading
 * statuses together select every book, so they collapse to no filter; lists are sorted so
 * the same filter set always produces the same signature.
 */
export function normalizeFilters(filter?: BookFilters): BookFilters {
  if (!filter) return {};
  const q = filter.q?.trim() || undefined;
  const read = unique(filter.read);
  const index = unique(filter.index);
  const source = unique(filter.source);
  const tag = unique(filter.tag).sort();
  const author = filter.author?.trim() || undefined;
  return {
    ...(q !== undefined ? { q } : {}),
    ...(filter.format !== undefined ? { format: filter.format } : {}),
    ...(read.length > 0 && read.length < 3 ? { read } : {}),
    ...(index.length > 0 ? { index } : {}),
    ...(source.length > 0 ? { source } : {}),
    ...(filter.notes ? { notes: true } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(tag.length > 0 ? { tag } : {}),
    ...(filter.favorite === true ? { favorite: true } : {}),
  };
}

const readPredicate = (statuses: ReadingStatus[], progressAlias?: string, lastRead = false): FilterSql => {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const status of statuses) {
    if (status === "unread") {
      if (progressAlias || lastRead) {
        // `lastRead` only returns books with a progress row, so none of them is unstarted.
        parts.push("(0)");
      } else {
        parts.push("(NOT EXISTS (SELECT 1 FROM web_progress wp WHERE wp.book_id = books.id AND wp.percentage >= ?))");
        params.push(UNSTARTED_BELOW);
      }
    } else if (status === "reading") {
      if (progressAlias) {
        parts.push(`(${progressAlias}.percentage >= ? AND ${progressAlias}.percentage < ?)`);
      } else {
        parts.push("(EXISTS (SELECT 1 FROM web_progress wp WHERE wp.book_id = books.id AND wp.percentage >= ? AND wp.percentage < ?))");
      }
      params.push(UNSTARTED_BELOW, FINISHED_AT);
    } else {
      if (progressAlias) parts.push(`(${progressAlias}.percentage >= ?)`);
      else parts.push("(EXISTS (SELECT 1 FROM web_progress wp WHERE wp.book_id = books.id AND wp.percentage >= ?))");
      params.push(FINISHED_AT);
    }
  }
  return { sql: `(${parts.join(" OR ")})`, params };
};

const indexPredicate = (statuses: BookIndexStatus[]): FilterSql => {
  const parts = statuses.map((status) => {
    if (status === "ready") {
      return "(EXISTS (SELECT 1 FROM book_index bi WHERE bi.book_id = books.id AND bi.state = 'ready'))";
    }
    if (status === "error") {
      return "(EXISTS (SELECT 1 FROM book_index bi WHERE bi.book_id = books.id AND bi.state = 'error'))";
    }
    // No row means the book was never queued and is still pending; metadata errors can
    // never be indexed, so they are not "pending" even though they have no row either.
    return "(books.status <> 'error' AND NOT EXISTS (SELECT 1 FROM book_index bi WHERE bi.book_id = books.id AND bi.state IN ('ready','error')))";
  });
  return { sql: `(${parts.join(" OR ")})`, params: [] };
};

const sourcePredicate = (sources: string[]): FilterSql => {
  // `IFNULL` keeps the OR between real ids and "upload" in one predicate. IN lists with
  // several values or a NULL branch make SQLite collect rows before sorting (MULTI-INDEX
  // OR / temp B-tree); scanning the ordering index and filtering the residual stays ordered.
  return {
    sql: `IFNULL(books.source_id, 'upload') IN (${sources.map(() => "?").join(",")})`,
    params: sources,
  };
};

/**
 * Tag filter (ADR-6). A scalar subquery is used instead of `EXISTS` on purpose: SQLite may
 * rewrite a correlated EXISTS into a join starting from `book_tags` and then sort the
 * ordering column in a temporary B-tree when the tag is rare. The scalar form is never
 * reordered, so the page keeps scanning the matching books index.
 */
const tagPredicate = (tagIds: string[]): FilterSql => ({
  sql: `(SELECT 1 FROM book_tags bt WHERE bt.book_id = books.id AND bt.tag_id IN (${tagIds.map(() => "?").join(",")}) LIMIT 1) IS NOT NULL`,
  params: tagIds,
});

/**
 * Builds the shared WHERE expression for the page, `total` and the facets. Values are always
 * bound as parameters; only whitelisted column names and static predicates enter the SQL.
 */
export function filtersWhere(filter?: BookFilters, options: FilterSqlOptions = {}): FilterSql {
  const filters = normalizeFilters(filter);
  const conditions: FilterSql[] = [];
  const excluded = options.exclude;
  if (filters.q !== undefined) {
    const pattern = likePattern(filters.q);
    conditions.push({
      sql: "(books.title LIKE ? ESCAPE '\\' OR books.author LIKE ? ESCAPE '\\')",
      params: [pattern, pattern],
    });
  }
  if (filters.format !== undefined && excluded !== "format") {
    conditions.push({ sql: "books.format = ?", params: [filters.format] });
  }
  if (filters.read !== undefined && excluded !== "read") {
    conditions.push(readPredicate(filters.read, options.progressAlias, options.lastRead));
  }
  if (filters.index !== undefined && excluded !== "index") {
    conditions.push(indexPredicate(filters.index));
  }
  if (filters.source !== undefined && excluded !== "source") {
    conditions.push(sourcePredicate(filters.source));
  }
  if (filters.notes && excluded !== "notes") {
    conditions.push({ sql: "EXISTS (SELECT 1 FROM notes n WHERE n.book_id = books.id)", params: [] });
  }
  if (filters.author !== undefined) {
    conditions.push({ sql: "books.author = ? COLLATE NOCASE", params: [filters.author] });
  }
  if (filters.tag !== undefined && excluded !== "tag") {
    conditions.push(tagPredicate(filters.tag));
  }
  if (filters.favorite === true && excluded !== "favorite") {
    // Matches the partial index `books_favorite_added ... WHERE favorite = 1` (ADR-1).
    conditions.push({ sql: "books.favorite = 1", params: [] });
  }
  return {
    sql: conditions.map((condition) => condition.sql).filter(Boolean).join(" AND "),
    params: conditions.flatMap((condition) => condition.params),
  };
}
