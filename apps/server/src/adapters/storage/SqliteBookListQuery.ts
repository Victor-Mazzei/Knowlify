import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ValidationError } from "../../domain/errors.js";
import { FINISHED_AT, UNSTARTED_BELOW } from "../../domain/reading/ReadingStatus.js";
import type {
  Book,
  BookFacets,
  BookFilters,
  BookListFilter,
  BookListQuery,
  BookListReader,
  BookPage,
  BookPageRow,
} from "../../ports/index.js";
import { filtersWhere, normalizeFilters } from "./BookListFilters.js";
import { SqliteBookFacets } from "./SqliteBookFacets.js";
import type { Db } from "./db.js";

type Sort = NonNullable<BookListQuery["sort"]>;
type Order = NonNullable<BookListQuery["order"]>;

export interface NormalizedQuery extends BookFilters {
  limit: number;
  sort: Sort;
  order: Order;
}

interface CursorAnchor {
  sortValue: number | string;
  id: string;
  /** Only for `sort=reading`: which segment the last visible row came from. */
  segment?: 0 | 1;
}

interface QuerySql {
  sql: string;
  params: Array<string | number>;
}

type PageRow = Book & { sort_value?: number };

const CURSOR_VERSION = 2;
const QUERY_HASH_BYTES = 8;
const SIGNATURE_BYTES = 12;
const HEADER_BYTES = 3 + QUERY_HASH_BYTES;
// A sanity guard before hashing/HMAC. Real cursors are ~50-160 chars; Node rejects
// request headers well before this, so longer payloads are never useful.
const MAX_CURSOR_CHARS = 16_384;
const MAX_LIMIT = 200;

const SORT_CODES: Record<Sort, number> = { added: 0, title: 1, lastRead: 2, author: 3, reading: 4 };
const SORT_BY_CODE: readonly Sort[] = ["added", "title", "lastRead", "author", "reading"];

const DEFAULT_SECRET = randomBytes(32);

const encodeSortValue = (value: number | string): Buffer => {
  if (typeof value === "number") {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(value);
    return buffer;
  }
  const title = Buffer.from(value, "utf8");
  if (title.length > 0xffff) throw new Error("Book sort value is too long for a cursor");
  const buffer = Buffer.alloc(2 + title.length);
  buffer.writeUInt16BE(title.length, 0);
  title.copy(buffer, 2);
  return buffer;
};

const encodeId = (id: string): Buffer => {
  const bytes = Buffer.from(id, "utf8");
  if (bytes.length > 0xff) throw new Error("Book id is too long for a cursor");
  const buffer = Buffer.alloc(1 + bytes.length);
  buffer.writeUInt8(bytes.length, 0);
  bytes.copy(buffer, 1);
  return buffer;
};

const orderSql = (sort: Sort, order: Order): string => {
  const direction = order === "asc" ? "ASC" : "DESC";
  switch (sort) {
    case "title":
      return `ORDER BY books.title COLLATE NOCASE ${direction}, books.id ${direction}`;
    case "author":
      return `ORDER BY books.author COLLATE NOCASE ${direction}, books.id ${direction}`;
    case "lastRead":
      return `ORDER BY p.updated_at ${direction}, p.book_id ${direction}`;
    default:
      return `ORDER BY books.added_at ${direction}, books.id ${direction}`;
  }
};

const sortColumn = (sort: Sort): string => {
  switch (sort) {
    case "title":
      return "books.title COLLATE NOCASE";
    case "author":
      return "books.author COLLATE NOCASE";
    case "lastRead":
      return "p.updated_at";
    default:
      return "books.added_at";
  }
};

const tieBreaker = (sort: Sort): string => (sort === "lastRead" ? "p.book_id" : "books.id");

const isTextSort = (sort: Sort): boolean => sort === "title" || sort === "author";

/**
 * Unambiguous canonical form of every filter the cursor is bound to. JSON escapes
 * separators inside `q`, so two different filter sets can never hash the same string.
 */
const canonicalFilters = (filter: BookFilters): string => {
  const normalized = normalizeFilters(filter);
  const canonical: string[] = [
    normalized.q ?? "",
    normalized.format ?? "",
    normalized.read === undefined ? "" : [...normalized.read].sort().join(","),
    normalized.index === undefined ? "" : [...normalized.index].sort().join(","),
    normalized.source === undefined ? "" : [...normalized.source].sort().join(","),
    normalized.notes === true ? "1" : "",
    normalized.author ?? "",
  ];
  // The tag slot is appended only when tag or favorite is present, and favorite adds one
  // more element. Cursors issued before either feature (seven elements) keep their hash.
  if (normalized.tag !== undefined || normalized.favorite === true) {
    canonical.push(normalized.tag === undefined ? "" : [...normalized.tag].sort().join(","));
    if (normalized.favorite === true) canonical.push("1");
  }
  return JSON.stringify(canonical);
};

/**
 * `books_favorite_added` only serves the `added_at` order. Pinning the title/author index
 * lets SQLite keep scanning in sort order and filter favorites as a residual predicate,
 * instead of sorting the whole favorite subset in a temporary B-tree.
 */
const favoriteOrderIndex = (query: Pick<NormalizedQuery, "favorite" | "sort">): string | null => {
  if (query.favorite !== true) return null;
  if (query.sort === "title") return "books_title";
  if (query.sort === "author") return "books_author";
  return null;
};

/**
 * Keyset page query. `added`/`title`/`author` scan the matching books index; `lastRead`
 * drives from `web_progress_updated`, so the ordering index is never sorted in a temporary
 * B-tree (ADR-A1, risk R1).
 */
export function booksPageSql(query: NormalizedQuery, anchor?: CursorAnchor): QuerySql {
  const lastRead = query.sort === "lastRead";
  const { sql: filterSql, params } = filtersWhere(query, lastRead ? { progressAlias: "p" } : {});
  const conditions = filterSql ? [filterSql] : [];
  if (anchor) {
    const comparison = query.order === "asc" ? ">" : "<";
    conditions.push(`(${sortColumn(query.sort)}, ${tieBreaker(query.sort)}) ${comparison} (?, ?)`);
    params.push(anchor.sortValue, anchor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  if (lastRead) {
    // CROSS JOIN pins web_progress as the outer loop: with other filters the planner would
    // otherwise scan books and sort by p.updated_at in a temporary B-tree.
    return {
      sql: `SELECT books.*, p.updated_at AS sort_value FROM web_progress p CROSS JOIN books ON books.id = p.book_id
        ${where} ${orderSql(query.sort, query.order)} LIMIT ?`,
      params,
    };
  }
  const pinned = favoriteOrderIndex(query);
  return {
    sql: `SELECT books.* FROM books${pinned === null ? "" : ` INDEXED BY ${pinned}`} ${where}
      ${orderSql(query.sort, query.order)} LIMIT ?`,
    params,
  };
}

/** Segment 0 is only skipped when the filter explicitly excludes "reading". */
export const readingSegmentAllowed = (query: NormalizedQuery, segment: 0 | 1): boolean => {
  if (segment === 1) return !(query.read?.length === 1 && query.read[0] === "reading");
  return query.read === undefined || query.read.includes("reading");
};

/**
 * One query of the `sort=reading` plan (ADR-1). Segment 0 reads `web_progress_updated` and
 * joins books by primary key; segment 1 scans `books_added` and rejects in-progress books
 * with a correlated `NOT EXISTS`. Both orders are served by an index, never a temp B-tree.
 */
export function readingSegmentSql(segment: 0 | 1, query: NormalizedQuery, anchor?: CursorAnchor): QuerySql {
  const params: Array<string | number> = [];
  const conditions: string[] = [];
  if (segment === 0) {
    // Every row of segment 0 is "reading"; when the filter also includes reading its read
    // predicate is redundant, and other statuses are already true through the range.
    const { sql: filterSql, params: filterParams } =
      filtersWhere(query, query.read?.includes("reading") ? { exclude: "read" } : {});
    conditions.push("p.percentage >= ? AND p.percentage < ?");
    params.push(UNSTARTED_BELOW, FINISHED_AT);
    if (filterSql) {
      conditions.push(filterSql);
      params.push(...filterParams);
    }
    if (anchor) {
      conditions.push("(p.updated_at, p.book_id) < (?, ?)");
      params.push(anchor.sortValue, anchor.id);
    }
    return {
      sql: `SELECT books.*, p.updated_at AS sort_value FROM web_progress p CROSS JOIN books ON books.id = p.book_id
        WHERE ${conditions.join(" AND ")} ORDER BY p.updated_at DESC, p.book_id DESC LIMIT ?`,
      params,
    };
  }
  const { sql: filterSql, params: filterParams } = filtersWhere(query);
  conditions.push(`NOT EXISTS (SELECT 1 FROM web_progress wp
    WHERE wp.book_id = books.id AND wp.percentage >= ? AND wp.percentage < ?)`);
  params.push(UNSTARTED_BELOW, FINISHED_AT);
  if (filterSql) {
    conditions.push(filterSql);
    params.push(...filterParams);
  }
  if (anchor) {
    conditions.push("(books.added_at, books.id) < (?, ?)");
    params.push(anchor.sortValue, anchor.id);
  }
  return {
    sql: `SELECT books.* FROM books WHERE ${conditions.join(" AND ")}
      ORDER BY books.added_at DESC, books.id DESC LIMIT ?`,
    params,
  };
}

export class SqliteBookListQuery implements BookListReader {
  private readonly secret: Buffer;
  private readonly facetsReader: SqliteBookFacets;

  constructor(private db: Db, secret?: string | Buffer) {
    this.secret = secret === undefined
      ? DEFAULT_SECRET
      : Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "utf8");
    this.facetsReader = new SqliteBookFacets(db);
  }

  page(query: BookListQuery): BookPage {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const normalized: NormalizedQuery = {
      ...normalizeFilters(query),
      limit: query.limit,
      sort: query.sort ?? "added",
      order: query.order ?? (query.sort === "title" || query.sort === "author" ? "asc" : "desc"),
    };
    const anchor = query.cursor ? this.decodeCursor(query.cursor, normalized) : undefined;
    if (normalized.sort === "reading") return this.readingPage(normalized, anchor);
    const { sql, params } = booksPageSql(normalized, anchor);
    const rows = this.db.prepare(sql).all(...params, normalized.limit + 1) as PageRow[];
    const hasMore = rows.length > normalized.limit;
    const visible = hasMore ? rows.slice(0, normalized.limit) : rows;
    const pageRows = visible.map((row): BookPageRow => {
      const { sort_value: sortValue, ...book } = row;
      return { book, sortValue: this.sortValueOf(normalized.sort, book, sortValue) };
    });
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      nextCursor: hasMore && last ? this.encodeCursor(normalized, last) : null,
    };
  }

  /**
   * Two sequential queries, at most: in-progress books ordered by last read, then every
   * other book ordered by `added_at`. The second query runs without an anchor when the
   * first one was exhausted on this page, which is consistent because the "rest" segment is
   * always walked from its beginning. A book read during paging can move from segment 1 to
   * segment 0 (the same tolerance `lastRead` already has); the client dedupes by id.
   */
  private readingPage(query: NormalizedQuery, anchor: CursorAnchor | undefined): BookPage {
    const requested = query.limit + 1;
    const rows: Array<PageRow & { segment: 0 | 1 }> = [];
    if (readingSegmentAllowed(query, 0) && anchor?.segment !== 1) {
      const { sql, params } = readingSegmentSql(0, query, anchor?.segment === 0 ? anchor : undefined);
      const first = this.db.prepare(sql).all(...params, requested) as PageRow[];
      for (const row of first) rows.push({ ...row, segment: 0 });
    }
    if (rows.length < requested && readingSegmentAllowed(query, 1)) {
      const { sql, params } = readingSegmentSql(1, query, anchor?.segment === 1 ? anchor : undefined);
      const rest = this.db.prepare(sql).all(...params, requested - rows.length) as PageRow[];
      for (const row of rest) rows.push({ ...row, segment: 1 });
    }
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const pageRows = visible.map((row): BookPageRow => {
      const { sort_value: sortValue, segment, ...book } = row;
      return { book, sortValue: this.sortValueOf(query.sort, book, sortValue), segment };
    });
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      nextCursor: hasMore && last ? this.encodeCursor(query, last) : null,
    };
  }

  count(filter?: BookListFilter, options?: { requireProgress?: boolean }): number {
    const requireProgress = options?.requireProgress === true;
    const { sql, params } = filtersWhere(filter, requireProgress ? { lastRead: true } : {});
    const conditions = sql ? [sql] : [];
    if (requireProgress) {
      // `sort=lastRead` pages only books that have a progress row (contract D3), so `total`
      // must apply the same restriction or it would describe a different result set.
      conditions.push("EXISTS (SELECT 1 FROM web_progress wp WHERE wp.book_id = books.id)");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM books ${where}`).get(...params) as { n: number };
    return row.n;
  }

  facets(filter?: BookListFilter, options?: { indexingEnabled?: boolean }): BookFacets {
    return this.facetsReader.facets(filter, options);
  }

  byIds(ids: string[]): Book[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM books WHERE id IN (${placeholders})`).all(...ids) as Book[];
    const found = new Map(rows.map((book) => [book.id, book]));
    return ids.flatMap((id) => {
      const book = found.get(id);
      return book ? [book] : [];
    });
  }

  matchingIds(filter: BookListFilter, limit: number): string[] {
    const { sql, params } = filtersWhere(filter);
    const where = sql ? `WHERE ${sql}` : "";
    const rows = this.db.prepare(`SELECT id FROM books ${where} ORDER BY added_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Offset page for OPDS (page=N); the JSON API always uses the signed cursor. */
  catalogPage(filter: BookListFilter, limit: number, offset: number): Book[] {
    const { sql, params } = filtersWhere(filter);
    const where = sql ? `WHERE ${sql}` : "";
    return this.db.prepare(`SELECT * FROM books ${where} ORDER BY title COLLATE NOCASE, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Book[];
  }

  private sortValueOf(sort: Sort, book: Book, joinedValue: number | undefined): number | string {
    if (sort === "title") return book.title;
    if (sort === "author") return book.author;
    if (sort === "lastRead") return joinedValue ?? book.added_at;
    if (sort === "reading") return joinedValue ?? book.added_at;
    return book.added_at;
  }

  private queryHash(filter: BookFilters): Buffer {
    return createHash("sha256").update(canonicalFilters(filter)).digest().subarray(0, QUERY_HASH_BYTES);
  }

  private encodeCursor(query: NormalizedQuery, row: BookPageRow): string {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt8(CURSOR_VERSION, 0);
    header.writeUInt8(SORT_CODES[query.sort], 1);
    header.writeUInt8(query.order === "desc" ? 1 : 0, 2);
    this.queryHash(query).copy(header, 3);

    const parts: Buffer[] = [header];
    if (query.sort === "reading") {
      // Segment byte before the numeric key; the decoder requires the exact size.
      const segment = Buffer.alloc(1);
      segment.writeUInt8(row.segment ?? 1, 0);
      parts.push(segment);
    }
    parts.push(encodeSortValue(row.sortValue), encodeId(row.book.id));
    const body = Buffer.concat(parts);
    const signature = createHmac("sha256", this.secret).update(body).digest().subarray(0, SIGNATURE_BYTES);
    return Buffer.concat([body, signature]).toString("base64url");
  }

  private decodeCursor(cursor: string, query: NormalizedQuery): CursorAnchor {
    if (cursor.length > MAX_CURSOR_CHARS) throw new ValidationError("cursor is invalid");
    const raw = Buffer.from(cursor, "base64url");
    // Base64 decoding is permissive; requiring a canonical round-trip rejects garbage
    // and non-URL-safe characters instead of silently accepting a different payload.
    if (raw.length === 0 || raw.toString("base64url") !== cursor) {
      throw new ValidationError("cursor is invalid");
    }
    const minimum = HEADER_BYTES + 8 + 1 + SIGNATURE_BYTES;
    if (raw.length < minimum) throw new ValidationError("cursor is invalid");
    const body = raw.subarray(0, raw.length - SIGNATURE_BYTES);
    const signature = raw.subarray(raw.length - SIGNATURE_BYTES);
    const expected = createHmac("sha256", this.secret).update(body).digest().subarray(0, SIGNATURE_BYTES);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new ValidationError("cursor is invalid");
    }

    // Version 1 cursors signed only q/format and are intentionally rejected: they are
    // ephemeral, and the client restarts paging on a 400 (contract D4).
    if (body.readUInt8(0) !== CURSOR_VERSION) throw new ValidationError("cursor is invalid");
    const sort = SORT_BY_CODE[body.readUInt8(1)];
    if (sort === undefined) throw new ValidationError("cursor is invalid");
    const flags = body.readUInt8(2);
    if ((flags & ~1) !== 0) throw new ValidationError("cursor is invalid");
    const order: Order = (flags & 1) === 1 ? "desc" : "asc";
    const hash = body.subarray(3, HEADER_BYTES);
    if (sort !== query.sort || order !== query.order || !timingSafeEqual(hash, this.queryHash(query))) {
      throw new ValidationError("cursor does not match the current query");
    }

    let offset = HEADER_BYTES;
    let segment: 0 | 1 | undefined;
    if (sort === "reading") {
      if (offset + 1 > body.length) throw new ValidationError("cursor is invalid");
      const code = body.readUInt8(offset);
      if (code !== 0 && code !== 1) throw new ValidationError("cursor is invalid");
      segment = code;
      offset += 1;
    }
    let sortValue: number | string;
    if (isTextSort(sort)) {
      if (offset + 2 > body.length) throw new ValidationError("cursor is invalid");
      const length = body.readUInt16BE(offset);
      offset += 2;
      if (offset + length > body.length) throw new ValidationError("cursor is invalid");
      sortValue = body.subarray(offset, offset + length).toString("utf8");
      offset += length;
    } else {
      if (offset + 8 > body.length) throw new ValidationError("cursor is invalid");
      sortValue = body.readDoubleBE(offset);
      offset += 8;
      if (!Number.isFinite(sortValue)) throw new ValidationError("cursor is invalid");
    }
    if (offset + 1 > body.length) throw new ValidationError("cursor is invalid");
    const idLength = body.readUInt8(offset);
    offset += 1;
    if (idLength === 0 || offset + idLength !== body.length) throw new ValidationError("cursor is invalid");
    const id = body.subarray(offset, offset + idLength).toString("utf8");
    return segment === undefined ? { sortValue, id } : { sortValue, id, segment };
  }
}
