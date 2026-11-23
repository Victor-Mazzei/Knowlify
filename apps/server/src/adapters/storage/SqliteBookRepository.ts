import type BetterSqlite3 from "better-sqlite3";
import type { Db } from "./db.js";
import type { Book, BookRepository, SourceBookSnapshot } from "../../ports/index.js";
import type { IndexEpoch } from "../../ports/index-epoch.js";

// Callers pass file-extracted values; the row keeps both the file snapshot and the
// effective values materialized from the override (ADR-2). The override subquery reads
// the primary key, so the writer pays one index lookup per row while every reader stays
// on books.title/books.author and their indexes.
const UPSERT = `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status,content_hash,file_title,file_author,file_cover_path)
  VALUES (@id,@title,@author,@format,@path,@cover_path,@size,@added_at,@source_id,@mtime,@status,@content_hash,@title,@author,@cover_path)
  ON CONFLICT(id) DO UPDATE SET
  file_title=excluded.title, file_author=excluded.author, file_cover_path=excluded.cover_path,
  title=COALESCE((SELECT title FROM book_metadata_overrides o WHERE o.book_id = books.id), excluded.title),
  author=COALESCE((SELECT author FROM book_metadata_overrides o WHERE o.book_id = books.id), excluded.author),
  cover_path=COALESCE((SELECT cover_path FROM book_metadata_overrides o WHERE o.book_id = books.id), excluded.cover_path),
  path=excluded.path,
  size=excluded.size,source_id=excluded.source_id,mtime=excluded.mtime,
  status=excluded.status,
  content_hash=CASE
    WHEN excluded.content_hash IS NOT NULL THEN excluded.content_hash
    WHEN books.size <> excluded.size OR books.mtime IS NOT excluded.mtime THEN NULL
    ELSE books.content_hash
  END`;

// Metadata arrives after a possible delete or rescan: update only the fields the
// extractor owns, and only while the indexed file version is still the same.
const UPDATE_METADATA = `UPDATE books SET
  file_title=@title, file_author=@author, file_cover_path=@cover_path,
  title=COALESCE((SELECT o.title FROM book_metadata_overrides o WHERE o.book_id = books.id), @title),
  author=COALESCE((SELECT o.author FROM book_metadata_overrides o WHERE o.book_id = books.id), @author),
  cover_path=COALESCE((SELECT o.cover_path FROM book_metadata_overrides o WHERE o.book_id = books.id), @cover_path),
  status=@status
  WHERE id=@id AND mtime IS @mtime AND size=@size`;

type Prepared = BetterSqlite3.Statement<unknown[], unknown>;

export class SqliteBookRepository implements BookRepository {
  /** Prepared statements are reused across scans: preparing one is not free. */
  private readonly prepared = new Map<string, Prepared>();
  private writeMany: ((rows: Book[]) => void) | null = null;
  private updateMetadata: ((rows: Book[]) => string[]) | null = null;
  private removeMany: ((ids: string[]) => void) | null = null;

  constructor(private db: Db, private readonly epoch?: IndexEpoch) {}

  private statement(sql: string): Prepared {
    let statement = this.prepared.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.prepared.set(sql, statement);
    }
    return statement;
  }

  list(q?: string): Book[] {
    if (!q) return this.statement("SELECT * FROM books ORDER BY added_at DESC").all() as Book[];
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    return this.statement("SELECT * FROM books WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' ORDER BY added_at DESC").all(like, like) as Book[];
  }
  catalog(q: string, recent: boolean): Book[] {
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const order = recent ? "added_at DESC, id" : "title COLLATE NOCASE, id";
    return this.statement(`SELECT * FROM books WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' ORDER BY ${order}${recent ? " LIMIT 50" : ""}`).all(pattern, pattern) as Book[];
  }
  get(id: string) { return this.statement("SELECT * FROM books WHERE id = ?").get(id) as Book | undefined; }
  byPath(path: string) { return this.statement("SELECT * FROM books WHERE path = ?").get(path) as Book | undefined; }
  save(book: Book): void { this.statement(UPSERT).run(withHash(book)); }
  saveMany(books: Book[]): void {
    if (books.length === 0) return;
    const write = (this.writeMany ??= this.db.transaction((rows: Book[]) => {
      const statement = this.statement(UPSERT);
      for (const row of rows) statement.run(withHash(row));
    }));
    write(books);
  }
  updateMetadataMany(books: Book[]): string[] {
    if (books.length === 0) return [];
    const update = (this.updateMetadata ??= this.db.transaction((rows: Book[]) => {
      const statement = this.statement(UPDATE_METADATA);
      const updated: string[] = [];
      for (const row of rows) if (statement.run(row).changes > 0) updated.push(row.id);
      return updated;
    }));
    return update(books);
  }
  // Foreign keys are not enabled on this connection, so the override cascade is explicit:
  // every deletion path must drop the row or it would outlive the book (ADR-2).
  delete(id: string): void {
    this.db.transaction(() => {
      this.statement("DELETE FROM book_metadata_overrides WHERE book_id = ?").run(id);
      this.statement("DELETE FROM books WHERE id = ?").run(id);
    })();
    // Foreign keys are enabled (better-sqlite3 default): deleting the row cascades the
    // index rows, chunks and vectors, so every cached passage id for it is now stale.
    this.epoch?.bump();
  }
  deleteMany(ids: string[]): void {
    if (ids.length === 0) return;
    const remove = (this.removeMany ??= this.db.transaction((rows: string[]) => {
      // One IN list per 500 ids keeps the statement below SQLite's variable limit
      // while avoiding one prepared delete per book.
      for (let start = 0; start < rows.length; start += 500) {
        const chunk = rows.slice(start, start + 500);
        const placeholders = chunk.map(() => "?").join(",");
        this.statement(`DELETE FROM book_metadata_overrides WHERE book_id IN (${placeholders})`).run(...chunk);
        this.statement(`DELETE FROM books WHERE id IN (${placeholders})`).run(...chunk);
      }
    }));
    remove(ids);
    this.epoch?.bump();
  }
  forSource(id: string): Book[] { return this.statement("SELECT * FROM books WHERE source_id = ?").all(id) as Book[]; }
  snapshotForSource(id: string): Map<string, SourceBookSnapshot> {
    const rows = this.statement("SELECT id, path, mtime, size FROM books WHERE source_id = ?")
      .all(id) as Pick<Book, "id" | "path" | "mtime" | "size">[];
    return new Map(rows.map((row) => [row.path, { id: row.id, mtime: row.mtime, size: row.size }]));
  }
  countForSource(id: string): number {
    return (this.statement("SELECT COUNT(*) AS n FROM books WHERE source_id = ?").get(id) as { n: number }).n;
  }
  count(): number { return (this.statement("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n; }
  deleteSource(id: string): void {
    this.db.transaction(() => {
      this.statement("DELETE FROM book_metadata_overrides WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)").run(id);
      this.statement("DELETE FROM books WHERE source_id = ?").run(id);
    })();
    this.epoch?.bump();
  }
  pending(limit: number): Book[] { return this.statement("SELECT * FROM books WHERE status = 'pending' LIMIT ?").all(limit) as Book[]; }
  pendingCount(): number { return (this.statement("SELECT COUNT(*) AS n FROM books WHERE status = 'pending'").get() as { n: number }).n; }
  bySize(size: number, excludePath?: string): Book[] {
    return excludePath === undefined
      ? this.statement("SELECT * FROM books WHERE size = ?").all(size) as Book[]
      : this.statement("SELECT * FROM books WHERE size = ? AND path <> ?").all(size, excludePath) as Book[];
  }
  sizesPresent(sizes: number[]): Set<number> {
    const present = new Set<number>();
    for (let start = 0; start < sizes.length; start += 500) {
      const batch = sizes.slice(start, start + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.statement(`SELECT DISTINCT size FROM books WHERE size IN (${placeholders})`).all(...batch) as { size: number }[];
      for (const row of rows) present.add(row.size);
    }
    return present;
  }
  setContentHashIfCurrent(
    id: string,
    hash: string,
    size: number,
    mtime: number | null,
    observedMtime?: number,
  ): boolean {
    if (mtime === null && observedMtime !== undefined) {
      // A managed upload has no mtime yet. Store the one observed while the bytes were
      // read, but only while the row still has no mtime, so a concurrent writer wins.
      return this.statement("UPDATE books SET content_hash = ?, mtime = ? WHERE id = ? AND size = ? AND mtime IS NULL")
        .run(hash, observedMtime, id, size).changes > 0;
    }
    return this.statement("UPDATE books SET content_hash = ? WHERE id = ? AND size = ? AND mtime IS ?")
      .run(hash, id, size, mtime).changes > 0;
  }
  clearContentHashIfCurrent(id: string, size: number, mtime: number | null): boolean {
    return this.statement("UPDATE books SET content_hash = NULL WHERE id = ? AND size = ? AND mtime IS ?")
      .run(id, size, mtime).changes > 0;
  }
  seedContentHashes(size: number): void {
    // The ingestion pipeline already computed the full SHA-256; its fingerprint is the same
    // `size:mtime` pair the scanner invalidates on, so a match makes the hash trustworthy.
    this.statement(`UPDATE books SET content_hash = (
        SELECT bi.content_hash FROM book_index bi
        WHERE bi.book_id = books.id AND bi.content_hash IS NOT NULL
          AND bi.fingerprint = books.size || ':' || COALESCE(books.mtime, '')
      )
      WHERE content_hash IS NULL AND size = ? AND EXISTS (
        SELECT 1 FROM book_index bi
        WHERE bi.book_id = books.id AND bi.content_hash IS NOT NULL
          AND bi.fingerprint = books.size || ':' || COALESCE(books.mtime, '')
      )`).run(size);
  }
}

const withHash = (book: Book): Book & { content_hash: string | null } => ({ ...book, content_hash: book.content_hash ?? null });
