import { FINISHED_AT, UNSTARTED_BELOW, type ReadingStatus } from "../../domain/reading/ReadingStatus.js";
import type {
  Book,
  BookFacets,
  BookFilters,
  BookIndexStatus,
  BookListFilter,
} from "../../ports/index.js";
import { filtersWhere } from "./BookListFilters.js";
import type { Db } from "./db.js";

interface GroupRow {
  key: string | null;
  n: number;
}

interface IndexCountRow {
  ready: number;
  pending: number;
  error: number;
}

const whereSql = (sql: string): string => (sql ? `WHERE ${sql}` : "");

/**
 * Disjunctive facet counts for the filter panel (ADR-A1 addendum). Each dimension applies
 * every other filter but ignores its own, so the UI can show what would remain after a
 * toggle. One GROUP BY per dimension keeps the whole response around six queries.
 */
export class SqliteBookFacets {
  constructor(private db: Db) {}

  facets(filter?: BookListFilter, options: { indexingEnabled?: boolean } = {}): BookFacets {
    const filters = filter ?? {};
    return {
      total: this.count(filters),
      format: this.formatCounts(filters),
      read: this.readCounts(filters),
      index: options.indexingEnabled === false ? null : this.indexCounts(filters),
      source: this.sourceCounts(filters),
      tag: this.tagCounts(filters),
      // Forcing the notes predicate is exactly "ignore the notes filter": other filters stay.
      notes: { with: this.count({ ...filters, notes: true }) },
      // Same rule for favorite; the COUNT matches the partial index (ADR-1).
      favorite: { with: this.count({ ...filters, favorite: true }) },
    };
  }

  private count(filter: BookFilters): number {
    const where = filtersWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM books ${whereSql(where.sql)}`)
      .get(...where.params) as { n: number };
    return row.n;
  }

  private formatCounts(filter: BookFilters): Record<Book["format"], number> {
    const where = filtersWhere(filter, { exclude: "format" });
    const rows = this.db
      .prepare(`SELECT books.format AS key, COUNT(*) AS n FROM books ${whereSql(where.sql)} GROUP BY books.format`)
      .all(...where.params) as GroupRow[];
    const counts: Record<Book["format"], number> = { pdf: 0, epub: 0 };
    for (const row of rows) {
      if (row.key === "pdf" || row.key === "epub") counts[row.key] = row.n;
    }
    return counts;
  }

  private readCounts(filter: BookFilters): Record<ReadingStatus, number> {
    const where = filtersWhere(filter, { exclude: "read" });
    // A LEFT JOIN reads every book once; the read filter itself was excluded above.
    const rows = this.db.prepare(`
      SELECT CASE
        WHEN wp.percentage IS NULL OR wp.percentage < ? THEN 'unread'
        WHEN wp.percentage >= ? THEN 'finished'
        ELSE 'reading'
      END AS key, COUNT(*) AS n
      FROM books LEFT JOIN web_progress wp ON wp.book_id = books.id
      ${whereSql(where.sql)}
      GROUP BY key
    `).all(UNSTARTED_BELOW, FINISHED_AT, ...where.params) as GroupRow[];
    const counts: Record<ReadingStatus, number> = { unread: 0, reading: 0, finished: 0 };
    for (const row of rows) {
      if (row.key === "unread" || row.key === "reading" || row.key === "finished") counts[row.key] = row.n;
    }
    return counts;
  }

  private indexCounts(filter: BookFilters): Record<BookIndexStatus, number> {
    const where = filtersWhere(filter, { exclude: "index" });
    // Mirrors the filter predicates: pending excludes metadata errors, while ready/error
    // are state equality (a metadata failure normally has no row at all).
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN bi.state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
        COALESCE(SUM(CASE WHEN books.status <> 'error'
          AND (bi.state IS NULL OR bi.state IN ('pending','indexing')) THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN bi.state = 'error' THEN 1 ELSE 0 END), 0) AS error
      FROM books LEFT JOIN book_index bi ON bi.book_id = books.id
      ${whereSql(where.sql)}
    `).get(...where.params) as IndexCountRow;
    return { ready: row.ready, pending: row.pending, error: row.error };
  }

  private sourceCounts(filter: BookFilters): Array<{ id: string; count: number }> {
    const where = filtersWhere(filter, { exclude: "source" });
    const rows = this.db
      .prepare(`SELECT books.source_id AS key, COUNT(*) AS n FROM books ${whereSql(where.sql)} GROUP BY books.source_id`)
      .all(...where.params) as GroupRow[];
    const counts = new Map<string | null, number>();
    for (const row of rows) counts.set(row.key, row.n);
    // Known sources always appear (0 included) so the panel keeps a stable list; the label
    // comes from GET /api/sources. Orphan ids from deleted sources are not exposed.
    const sources = this.db.prepare("SELECT id FROM sources ORDER BY path").all() as { id: string }[];
    return [
      ...sources.map((source) => ({ id: source.id, count: counts.get(source.id) ?? 0 })),
      { id: "upload", count: counts.get(null) ?? 0 },
    ];
  }

  /**
   * Disjunctive tag facet: every known tag appears (0 included) and the tag filter itself is
   * excluded while the other filters still apply. The join reads `book_tags` (at most one row
   * per tag per book) and resolves books by primary key.
   */
  private tagCounts(filter: BookFilters): Array<{ id: string; count: number }> {
    const where = filtersWhere(filter, { exclude: "tag" });
    // Without other filters the covering tag index answers the whole facet: no join with
    // books is needed. Filtered requests still join to apply the remaining predicates.
    const rows = where.sql === ""
      ? this.db.prepare("SELECT tag_id AS key, COUNT(*) AS n FROM book_tags GROUP BY tag_id").all() as GroupRow[]
      : this.db.prepare(`SELECT bt.tag_id AS key, COUNT(*) AS n FROM book_tags bt
        JOIN books ON books.id = bt.book_id ${whereSql(where.sql)} GROUP BY bt.tag_id`)
        .all(...where.params) as GroupRow[];
    const counts = new Map<string, number>();
    for (const row of rows) if (row.key !== null) counts.set(row.key, row.n);
    const tags = this.db.prepare("SELECT id FROM tags ORDER BY name_key").all() as { id: string }[];
    return tags.map((tag) => ({ id: tag.id, count: counts.get(tag.id) ?? 0 }));
  }
}
