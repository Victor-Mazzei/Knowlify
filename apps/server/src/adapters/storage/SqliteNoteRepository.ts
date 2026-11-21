import type { Db } from "./db.js";
import type { Note, NoteGroupAnchor, NoteGroupBook, NoteGroupRow, NoteRepository } from "../../ports/index.js";

const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * A note matches when its own text matches or when its book title/author matches. The
 * book branch makes every note of that book match, which is the contract for `q`.
 */
const MATCH = `(n.body LIKE ? ESCAPE '\\' OR n.quote LIKE ? ESCAPE '\\' OR n.label LIKE ? ESCAPE '\\'
  OR b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\')`;

const matchParams = (q: string | undefined): string[] => {
  if (q === undefined) return [];
  const pattern = likePattern(q);
  return [pattern, pattern, pattern, pattern, pattern];
};

/** Exported so the storage test can assert the plan uses the notes_book_updated index. */
export function noteGroupsQuery(
  q: string | undefined,
  anchor: NoteGroupAnchor | undefined,
  fetch: number,
): { sql: string; params: (string | number)[] } {
  const where = q === undefined ? "" : `WHERE ${MATCH}`;
  const having = anchor === undefined ? "" : "HAVING (MAX(n.updated_at), n.book_id) < (?, ?)";
  return {
    sql: `SELECT n.book_id, MAX(n.updated_at) AS last_at, COUNT(*) AS c
      FROM notes n JOIN books b ON b.id = n.book_id
      ${where}
      GROUP BY n.book_id
      ${having}
      ORDER BY last_at DESC, n.book_id DESC
      LIMIT ?`,
    params: [
      ...matchParams(q),
      ...(anchor === undefined ? [] : [anchor.lastNoteAt, anchor.bookId]),
      fetch,
    ],
  };
}

/** One window query fetches every group's first page instead of one query per book. */
export function notesForGroupsQuery(
  bookIds: string[],
  q: string | undefined,
  perGroup: number,
): { sql: string; params: (string | number)[] } {
  const placeholders = bookIds.map(() => "?").join(",");
  const match = q === undefined ? "" : ` AND ${MATCH}`;
  return {
    sql: `WITH ranked AS (
        SELECT n.id, n.book_id, n.location, n.label, n.quote, n.body, n.created_at, n.updated_at,
          ROW_NUMBER() OVER (PARTITION BY n.book_id ORDER BY n.updated_at DESC, n.id DESC) AS rn
        FROM notes n JOIN books b ON b.id = n.book_id
        WHERE n.book_id IN (${placeholders})${match}
      )
      SELECT id, book_id, location, label, quote, body, created_at, updated_at
      FROM ranked WHERE rn <= ? ORDER BY book_id, rn`,
    params: [...bookIds, ...matchParams(q), perGroup],
  };
}

export class SqliteNoteRepository implements NoteRepository {
  constructor(private db: Db) {}
  search(q: string | undefined, limit: number): (Note & { book_title: string })[] {
    const like = q ? likePattern(q) : null;
    return this.db.prepare(`SELECT n.*, b.title AS book_title FROM notes n JOIN books b ON b.id = n.book_id
      WHERE ? IS NULL OR n.body LIKE ? ESCAPE '\\' OR n.quote LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\'
      ORDER BY n.updated_at DESC LIMIT ?`).all(like, like, like, like, limit) as (Note & { book_title: string })[];
  }
  list(id: string): Note[] { return this.db.prepare("SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC").all(id) as Note[]; }
  groups(q: string | undefined, limit: number, anchor?: NoteGroupAnchor): {
    rows: NoteGroupRow[];
    nextAnchor: NoteGroupAnchor | null;
  } {
    const { sql, params } = noteGroupsQuery(q, anchor, limit + 1);
    const fetched = this.db.prepare(sql).all(...params) as { book_id: string; last_at: number; c: number }[];
    const hasMore = fetched.length > limit;
    const visible = hasMore ? fetched.slice(0, limit) : fetched;
    const last = visible[visible.length - 1];
    return {
      rows: visible.map((row) => ({ bookId: row.book_id, noteCount: row.c, lastNoteAt: row.last_at })),
      nextAnchor: hasMore && last ? { lastNoteAt: last.last_at, bookId: last.book_id } : null,
    };
  }
  forGroups(bookIds: string[], q: string | undefined, perGroup: number): Note[] {
    if (bookIds.length === 0) return [];
    const { sql, params } = notesForGroupsQuery(bookIds, q, perGroup);
    return this.db.prepare(sql).all(...params) as Note[];
  }
  booksForGroups(bookIds: string[]): NoteGroupBook[] {
    if (bookIds.length === 0) return [];
    const placeholders = bookIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id, title, author, format, cover_path IS NOT NULL AS has_cover
      FROM books WHERE id IN (${placeholders})`).all(...bookIds) as {
        id: string; title: string; author: string; format: "pdf" | "epub"; has_cover: 0 | 1;
      }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      format: row.format,
      hasCover: row.has_cover === 1,
    }));
  }
  countMatching(q: string | undefined): { books: number; notes: number } {
    const where = q === undefined ? "" : `WHERE ${MATCH}`;
    const notes = (this.db.prepare(`SELECT COUNT(*) AS n FROM notes n JOIN books b ON b.id = n.book_id ${where}`)
      .get(...matchParams(q)) as { n: number }).n;
    const books = (this.db.prepare(`SELECT COUNT(DISTINCT n.book_id) AS n FROM notes n JOIN books b ON b.id = n.book_id ${where}`)
      .get(...matchParams(q)) as { n: number }).n;
    return { books, notes };
  }
  listMatching(bookId: string, q: string): Note[] {
    return this.db.prepare(`SELECT n.* FROM notes n JOIN books b ON b.id = n.book_id
      WHERE n.book_id = ? AND ${MATCH} ORDER BY n.created_at DESC`)
      .all(bookId, ...matchParams(q)) as Note[];
  }
  get(id: string) { return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined; }
  save(note: Note): void {
    this.db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
      VALUES (@id,@book_id,@location,@label,@quote,@body,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`).run(note);
  }
  delete(id: string): boolean { return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0; }
  deleteForBook(id: string): void { this.db.prepare("DELETE FROM notes WHERE book_id = ?").run(id); }
  countForBooks(bookIds: string[]): number {
    let count = 0;
    for (let start = 0; start < bookIds.length; start += 500) {
      const batch = bookIds.slice(start, start + 500);
      const placeholders = batch.map(() => "?").join(",");
      count += (this.db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE book_id IN (${placeholders})`)
        .get(...batch) as { n: number }).n;
    }
    return count;
  }
  reassign(fromBookId: string, toBookId: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM notes WHERE book_id = ? ORDER BY created_at, id")
        .all(fromBookId) as { id: string }[];
      if (rows.length > 0) {
        this.db.prepare("UPDATE notes SET book_id = ? WHERE book_id = ?").run(toBookId, fromBookId);
      }
      return rows.map((row) => row.id);
    })();
  }
}
