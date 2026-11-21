import type { Db } from "./db.js";
import type { IgnoredBook } from "../../domain/library/IgnoredBook.js";
import type { IgnoredBookRepository } from "../../ports/library-ignore.js";

interface IgnoredRow {
  id: string;
  path: string | null;
  source_id: string | null;
  content_hash: string | null;
  size: number;
  title: string;
  author: string;
  format: IgnoredBook["format"];
  managed: 0 | 1;
  ignored_at: number;
}

const toIgnored = (row: IgnoredRow): IgnoredBook => ({
  id: row.id,
  path: row.path,
  sourceId: row.source_id,
  contentHash: row.content_hash,
  size: row.size,
  title: row.title,
  author: row.author,
  format: row.format,
  managed: row.managed === 1,
  ignoredAt: row.ignored_at,
});

const chunk = <T>(values: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) batches.push(values.slice(start, start + size));
  return batches;
};

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

/** Tombstone rows for deleted books (ADR-4). */
export class SqliteIgnoredBookRepository implements IgnoredBookRepository {
  constructor(private db: Db) {}

  saveMany(books: IgnoredBook[]): number {
    if (books.length === 0) return 0;
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ignored_books
      (id,path,source_id,content_hash,size,title,author,format,managed,ignored_at)
      VALUES (@id,@path,@source_id,@content_hash,@size,@title,@author,@format,@managed,@ignored_at)`);
    return this.db.transaction(() => {
      let inserted = 0;
      for (const book of books) {
        inserted += insert.run({
          id: book.id,
          path: book.path,
          source_id: book.sourceId,
          content_hash: book.contentHash,
          size: book.size,
          title: book.title,
          author: book.author,
          format: book.format,
          managed: book.managed ? 1 : 0,
          ignored_at: book.ignoredAt,
        }).changes;
      }
      return inserted;
    })();
  }

  pathsAmong(paths: string[]): Set<string> {
    const ignored = new Set<string>();
    for (const batch of chunk(paths, 500)) {
      const rows = this.db.prepare(`SELECT path FROM ignored_books
        WHERE path IN (${placeholders(batch.length)})`).all(...batch) as { path: string }[];
      for (const row of rows) ignored.add(row.path);
    }
    return ignored;
  }

  sizesAmong(sizes: number[]): Set<number> {
    const ignored = new Set<number>();
    for (const batch of chunk(sizes, 500)) {
      const rows = this.db.prepare(`SELECT DISTINCT size FROM ignored_books
        WHERE size IN (${placeholders(batch.length)})`).all(...batch) as { size: number }[];
      for (const row of rows) ignored.add(row.size);
    }
    return ignored;
  }

  hasHash(contentHash: string): boolean {
    return this.db.prepare("SELECT 1 FROM ignored_books WHERE content_hash = ? LIMIT 1").get(contentHash) !== undefined;
  }

  removeByHash(contentHash: string): number {
    return this.db.prepare("DELETE FROM ignored_books WHERE content_hash = ?").run(contentHash).changes;
  }

  deleteMany(ids: string[]): number {
    let removed = 0;
    for (const batch of chunk(ids, 500)) {
      removed += this.db.prepare(`DELETE FROM ignored_books WHERE id IN (${placeholders(batch.length)})`)
        .run(...batch).changes;
    }
    return removed;
  }

  byIds(ids: string[]): IgnoredBook[] {
    const rows: IgnoredBook[] = [];
    for (const batch of chunk(ids, 500)) {
      rows.push(...(this.db.prepare(`SELECT * FROM ignored_books WHERE id IN (${placeholders(batch.length)})`)
        .all(...batch) as IgnoredRow[]).map(toIgnored));
    }
    return rows;
  }

  list(limit: number, offset: number): IgnoredBook[] {
    const rows = this.db.prepare("SELECT * FROM ignored_books ORDER BY ignored_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as IgnoredRow[];
    return rows.map(toIgnored);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ignored_books").get() as { n: number }).n;
  }
}
