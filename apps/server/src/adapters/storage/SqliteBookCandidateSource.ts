import type { BookCandidateDetails, BookCandidateSource } from "../../ports/assistant.js";
import type { Db } from "./db.js";

/** Same ceiling as the term budget in `recommendIntent`. */
const MAX_TERMS = 8;
const MAX_MATCHES = 50;
/** Stay below SQLite's variable limit; a shortlist never needs more. */
const MAX_DETAIL_IDS = 500;

interface DetailRow {
  id: string;
  title: string;
  author: string;
  format: "pdf" | "epub";
  cover_path: string | null;
  cover_rev: number | null;
  language: string | null;
  series: string | null;
  description: string | null;
}

interface TagRow {
  book_id: string;
  name: string;
}

/**
 * Read side of the Library context for book recommendations (ADR-15). Both queries are
 * parameterized, bounded and only ever return `status = 'ready'` rows: an excluded book
 * has no row (and its tombstones never return), while pending and failed books stay out
 * of the shortlist. The LIKE scan is measured by the BE-3.0 spike.
 */
export class SqliteBookCandidateSource implements BookCandidateSource {
  constructor(private readonly db: Db) {}

  metadataMatches(terms: readonly string[], limit: number): string[] {
    const cleaned = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].slice(0, MAX_TERMS);
    if (cleaned.length === 0) return [];
    const cap = Math.max(1, Math.min(MAX_MATCHES, Math.trunc(limit) || MAX_MATCHES));
    const patterns = cleaned.map((term) => `%${escapeLike(term)}%`);
    const params: Array<string | number> = [];
    const fields: string[] = [];
    for (const pattern of patterns) {
      // Title and author are the materialized effective values (override included);
      // series and description live only in the override row.
      fields.push("b.title LIKE ? ESCAPE '\\'");
      params.push(pattern);
      fields.push("b.author LIKE ? ESCAPE '\\'");
      params.push(pattern);
      fields.push("o.series LIKE ? ESCAPE '\\'");
      params.push(pattern);
      fields.push("o.description LIKE ? ESCAPE '\\'");
      params.push(pattern);
    }
    const tagFields = patterns.map(() => "t.name LIKE ? ESCAPE '\\'").join(" OR ");
    params.push(...patterns);
    params.push(cap);
    // `IN (subquery)` materializes the tag match once. A correlated EXISTS re-ran the tag
    // join for every book and pushed the worst-case p95 over the 25 ms budget (BE-3.0).
    const rows = this.db.prepare(`
      SELECT b.id AS id FROM books b
      LEFT JOIN book_metadata_overrides o ON o.book_id = b.id
      WHERE b.status = 'ready' AND (
        ${fields.join(" OR ")}
        OR b.id IN (
          SELECT bt.book_id FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
          WHERE ${tagFields}
        )
      )
      ORDER BY b.added_at DESC, b.id
      LIMIT ?`).all(...params) as { id: string }[];
    return rows.map((row) => row.id);
  }

  details(ids: readonly string[]): BookCandidateDetails[] {
    const unique = [...new Set(ids)].slice(0, MAX_DETAIL_IDS);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT b.id, b.title, b.author, b.format, b.cover_path, b.cover_rev,
        o.language, o.series, o.description
      FROM books b
      LEFT JOIN book_metadata_overrides o ON o.book_id = b.id
      WHERE b.id IN (${placeholders}) AND b.status = 'ready'`).all(...unique) as DetailRow[];
    const tags = this.tagsFor(unique);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return unique.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      return [{
        bookId: row.id,
        title: row.title,
        author: row.author,
        format: row.format,
        language: row.language,
        series: row.series,
        description: row.description,
        tags: tags.get(row.id) ?? [],
        hasCover: row.cover_path !== null && row.cover_path !== "",
        coverRev: row.cover_rev,
      }];
    });
  }

  private tagsFor(ids: readonly string[]): Map<string, string[]> {
    const tags = new Map<string, string[]>();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT bt.book_id, t.name FROM book_tags bt
      JOIN tags t ON t.id = bt.tag_id
      WHERE bt.book_id IN (${placeholders})
      ORDER BY bt.book_id, t.name_key`).all(...ids) as TagRow[];
    for (const row of rows) {
      const list = tags.get(row.book_id);
      if (list) list.push(row.name);
      else tags.set(row.book_id, [row.name]);
    }
    return tags;
  }
}

/** `%`, `_` and the escape character itself are literals in the search term. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
