import type { Db } from "./db.js";
import type { MetadataOverride, MetadataSource, BookMetadataRepository } from "../../ports/library-metadata.js";

interface OverrideRow {
  book_id: string;
  title: string | null;
  author: string | null;
  description: string | null;
  isbn10: string | null;
  isbn13: string | null;
  year: number | null;
  publisher: string | null;
  language: string | null;
  series: string | null;
  series_index: number | null;
  cover_path: string | null;
  source: MetadataSource;
  updated_at: number;
}

const toOverride = (row: OverrideRow): MetadataOverride => ({
  bookId: row.book_id,
  title: row.title,
  author: row.author,
  description: row.description,
  isbn10: row.isbn10,
  isbn13: row.isbn13,
  year: row.year,
  publisher: row.publisher,
  language: row.language,
  series: row.series,
  seriesIndex: row.series_index,
  coverPath: row.cover_path,
  source: row.source,
  updatedAt: row.updated_at,
});

/**
 * The override is the source of truth for user edits; `books.title`, `books.author` and
 * `books.cover_path` stay the materialized effective values so every existing query,
 * index, sort and cursor keeps reading one column (ADR-2). Every write recomputes them
 * from `COALESCE(override, file_*)` inside the same transaction.
 */
export class SqliteBookMetadataRepository implements BookMetadataRepository {
  constructor(private readonly db: Db) {}

  /**
   * The `file_*` columns are the extractor's values. The final `books.title` fallback
   * covers rows created before the v11 backfill or inserted by test fixtures without
   * file metadata: resetting must never violate the NOT NULL constraint.
   */
  private recompute(bookId: string): void {
    this.db.prepare(`UPDATE books SET
        title = COALESCE((SELECT title FROM book_metadata_overrides WHERE book_id = books.id), file_title, title),
        author = COALESCE((SELECT author FROM book_metadata_overrides WHERE book_id = books.id), file_author, author),
        cover_path = COALESCE((SELECT cover_path FROM book_metadata_overrides WHERE book_id = books.id), file_cover_path)
      WHERE id = ?`).run(bookId);
  }

  private exists(bookId: string): boolean {
    return this.db.prepare("SELECT 1 AS present FROM books WHERE id = ?").get(bookId) !== undefined;
  }

  get(bookId: string): MetadataOverride | null {
    const row = this.db.prepare("SELECT * FROM book_metadata_overrides WHERE book_id = ?")
      .get(bookId) as OverrideRow | undefined;
    return row ? toOverride(row) : null;
  }

  save(override: MetadataOverride): boolean {
    return this.db.transaction(() => {
      if (!this.exists(override.bookId)) return false;
      if (isOverrideEmpty(override)) {
        this.db.prepare("DELETE FROM book_metadata_overrides WHERE book_id = ?").run(override.bookId);
      } else {
        this.db.prepare(`INSERT INTO book_metadata_overrides
            (book_id,title,author,description,isbn10,isbn13,year,publisher,language,series,series_index,cover_path,source,updated_at)
          VALUES (@book_id,@title,@author,@description,@isbn10,@isbn13,@year,@publisher,@language,@series,@series_index,@cover_path,@source,@updated_at)
          ON CONFLICT(book_id) DO UPDATE SET title=excluded.title, author=excluded.author,
            description=excluded.description, isbn10=excluded.isbn10, isbn13=excluded.isbn13,
            year=excluded.year, publisher=excluded.publisher, language=excluded.language,
            series=excluded.series, series_index=excluded.series_index, cover_path=excluded.cover_path,
            source=excluded.source, updated_at=excluded.updated_at`).run({
          book_id: override.bookId,
          title: override.title,
          author: override.author,
          description: override.description,
          isbn10: override.isbn10,
          isbn13: override.isbn13,
          year: override.year,
          publisher: override.publisher,
          language: override.language,
          series: override.series,
          series_index: override.seriesIndex,
          cover_path: override.coverPath,
          source: override.source,
          updated_at: override.updatedAt,
        });
      }
      this.recompute(override.bookId);
      return true;
    })();
  }

  reset(bookId: string): boolean {
    return this.db.transaction(() => {
      if (!this.exists(bookId)) return false;
      this.db.prepare("DELETE FROM book_metadata_overrides WHERE book_id = ?").run(bookId);
      this.db.prepare(`UPDATE books SET
          title = COALESCE(file_title, title),
          author = COALESCE(file_author, author),
          cover_path = file_cover_path,
          cover_rev = NULL
        WHERE id = ?`).run(bookId);
      return true;
    })();
  }

  setCover(bookId: string, coverPath: string | null, coverRev: number | null, now: number): boolean {
    return this.db.transaction(() => {
      if (!this.exists(bookId)) return false;
      const row = this.db.prepare("SELECT * FROM book_metadata_overrides WHERE book_id = ?")
        .get(bookId) as OverrideRow | undefined;
      if (row) {
        this.db.prepare("UPDATE book_metadata_overrides SET cover_path = ?, updated_at = ? WHERE book_id = ?")
          .run(coverPath, now, bookId);
        const updated = this.db.prepare("SELECT * FROM book_metadata_overrides WHERE book_id = ?")
          .get(bookId) as OverrideRow;
        if (isOverrideEmpty(toOverride(updated))) {
          this.db.prepare("DELETE FROM book_metadata_overrides WHERE book_id = ?").run(bookId);
        }
      } else if (coverPath !== null) {
        this.db.prepare(`INSERT INTO book_metadata_overrides (book_id,cover_path,source,updated_at)
          VALUES (?,?,'manual',?)`).run(bookId, coverPath, now);
      }
      this.db.prepare(`UPDATE books SET
          cover_path = COALESCE((SELECT cover_path FROM book_metadata_overrides WHERE book_id = books.id), file_cover_path),
          cover_rev = ?
        WHERE id = ?`).run(coverRev, bookId);
      return true;
    })();
  }

  move(fromBookId: string, toBookId: string): boolean {
    return this.db.transaction(() => {
      if (fromBookId === toBookId) return false;
      if (!this.exists(fromBookId) || !this.exists(toBookId)) return false;
      const source = this.db.prepare("SELECT book_id FROM book_metadata_overrides WHERE book_id = ?").get(fromBookId);
      if (!source) return false;
      const target = this.db.prepare("SELECT book_id FROM book_metadata_overrides WHERE book_id = ?").get(toBookId);
      if (target) return false;
      this.db.prepare("UPDATE book_metadata_overrides SET book_id = ? WHERE book_id = ?").run(toBookId, fromBookId);
      this.recompute(toBookId);
      this.recompute(fromBookId);
      return true;
    })();
  }
}

/** A row whose every metadata field is NULL is equivalent to no override at all. */
const isOverrideEmpty = (override: MetadataOverride): boolean =>
  override.title === null
  && override.author === null
  && override.description === null
  && override.isbn10 === null
  && override.isbn13 === null
  && override.year === null
  && override.publisher === null
  && override.language === null
  && override.series === null
  && override.seriesIndex === null
  && override.coverPath === null;
