import type { Db } from "./db.js";
import type {
  AliasSnapshot,
  DuplicateAlias,
  DuplicateBookStats,
  DuplicateContentAnchor,
  DuplicateContentCounts,
  DuplicateContentGroup,
  DuplicateRepository,
  DuplicateSizeGroup,
  MergeLogEntry,
  MergeLogRepository,
  UnitOfWork,
} from "../../ports/library-dedup.js";

interface AliasRow {
  path: string;
  book_id: string;
  source_id: string | null;
  size: number;
  mtime: number | null;
  content_hash: string;
  detected_at: number;
}

const toAlias = (row: AliasRow): AliasSnapshot => ({
  path: row.path,
  bookId: row.book_id,
  sourceId: row.source_id,
  size: row.size,
  mtime: row.mtime,
  contentHash: row.content_hash,
});

/** Alternate paths and duplicate reads (grouping, user-data stats, merge log). */
export class SqliteBookDuplicateRepository implements DuplicateRepository {
  constructor(private db: Db) {}

  aliasSnapshotForSource(sourceId: string): Map<string, AliasSnapshot> {
    const rows = this.db.prepare("SELECT * FROM book_duplicates WHERE source_id = ?").all(sourceId) as AliasRow[];
    return new Map(rows.map((row) => [row.path, toAlias(row)]));
  }

  aliasesForBook(bookId: string): AliasSnapshot[] {
    const rows = this.db.prepare("SELECT * FROM book_duplicates WHERE book_id = ? ORDER BY detected_at, path")
      .all(bookId) as AliasRow[];
    return rows.map(toAlias);
  }

  upsertAlias(alias: DuplicateAlias): void {
    this.db.prepare(`INSERT INTO book_duplicates
        (path, book_id, source_id, size, mtime, content_hash, detected_at)
      VALUES (@path, @book_id, @source_id, @size, @mtime, @content_hash, @detected_at)
      ON CONFLICT(path) DO UPDATE SET book_id=excluded.book_id, source_id=excluded.source_id,
        size=excluded.size, mtime=excluded.mtime, content_hash=excluded.content_hash,
        detected_at=excluded.detected_at`).run({
      path: alias.path,
      book_id: alias.bookId,
      source_id: alias.sourceId,
      size: alias.size,
      mtime: alias.mtime,
      content_hash: alias.contentHash,
      detected_at: alias.detectedAt,
    });
  }

  deleteAlias(path: string): void {
    this.db.prepare("DELETE FROM book_duplicates WHERE path = ?").run(path);
  }

  deleteAliasesForBook(bookId: string): void {
    this.db.prepare("DELETE FROM book_duplicates WHERE book_id = ?").run(bookId);
  }

  deleteAliasesForSource(sourceId: string): void {
    this.db.prepare("DELETE FROM book_duplicates WHERE source_id = ?").run(sourceId);
  }

  promoteAlias(bookId: string, path: string): boolean {
    return this.db.transaction(() => {
      const alias = this.db.prepare("SELECT * FROM book_duplicates WHERE path = ? AND book_id = ?")
        .get(path, bookId) as AliasRow | undefined;
      if (!alias) return false;
      // The alias path must be free: the decision that creates aliases guarantees it, but a
      // concurrent scan of an overlapping source can still race. Keeping the book is safer
      // than deleting it or overwriting the other row.
      const owner = this.db.prepare("SELECT id FROM books WHERE path = ?").get(path) as { id: string } | undefined;
      if (owner && owner.id !== bookId) return false;
      const changes = this.db.prepare(`UPDATE books SET path=?, source_id=?, size=?, mtime=?, content_hash=?
        WHERE id=?`).run(alias.path, alias.source_id, alias.size, alias.mtime, alias.content_hash, bookId).changes;
      if (changes === 0) return false;
      this.db.prepare("DELETE FROM book_duplicates WHERE path = ?").run(path);
      return true;
    })();
  }

  sizeGroups(): DuplicateSizeGroup[] {
    return this.db.prepare(`SELECT size, COUNT(*) AS count FROM books
      GROUP BY size HAVING COUNT(*) > 1 ORDER BY size`).all() as DuplicateSizeGroup[];
  }

  contentGroups(after: DuplicateContentAnchor | null, limit: number): DuplicateContentGroup[] {
    const base = `SELECT size, content_hash AS contentHash FROM books WHERE content_hash IS NOT NULL`;
    if (after === null) {
      return this.db.prepare(`${base} GROUP BY size, content_hash HAVING COUNT(*) > 1
        ORDER BY size DESC, content_hash ASC LIMIT ?`).all(limit) as DuplicateContentGroup[];
    }
    return this.db.prepare(`${base} AND (size < ? OR (size = ? AND content_hash > ?))
      GROUP BY size, content_hash HAVING COUNT(*) > 1
      ORDER BY size DESC, content_hash ASC LIMIT ?`)
      .all(after.size, after.size, after.contentHash, limit) as DuplicateContentGroup[];
  }

  contentGroupCounts(): DuplicateContentCounts {
    const row = this.db.prepare(`SELECT COUNT(*) AS groups, COALESCE(SUM(count - 1), 0) AS redundantBooks FROM (
      SELECT COUNT(*) AS count FROM books WHERE content_hash IS NOT NULL
      GROUP BY size, content_hash HAVING COUNT(*) > 1
    )`).get() as DuplicateContentCounts;
    return { groups: row.groups, redundantBooks: row.redundantBooks };
  }

  redundantBookIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM books b WHERE b.content_hash IS NOT NULL AND EXISTS (
      SELECT 1 FROM books other WHERE other.size = b.size AND other.content_hash = b.content_hash AND other.id <> b.id
    )`).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  statsForBooks(bookIds: string[]): Map<string, DuplicateBookStats> {
    const stats = new Map<string, DuplicateBookStats>();
    for (const id of bookIds) {
      stats.set(id, { notes: 0, conversations: 0, hasProgress: false, progressUpdatedAt: null, indexState: "none" });
    }
    for (let start = 0; start < bookIds.length; start += 500) {
      const batch = bookIds.slice(start, start + 500);
      const placeholders = batch.map(() => "?").join(",");
      const notes = this.db.prepare(`SELECT book_id, COUNT(*) AS n FROM notes
        WHERE book_id IN (${placeholders}) GROUP BY book_id`).all(...batch) as { book_id: string; n: number }[];
      for (const row of notes) {
        const entry = stats.get(row.book_id);
        if (entry) entry.notes = row.n;
      }
      const conversations = this.db.prepare(`SELECT book_id, COUNT(*) AS n FROM conversations
        WHERE scope_kind = 'book' AND book_id IN (${placeholders}) GROUP BY book_id`)
        .all(...batch) as { book_id: string; n: number }[];
      for (const row of conversations) {
        const entry = stats.get(row.book_id);
        if (entry) entry.conversations = row.n;
      }
      const progress = this.db.prepare(`SELECT book_id, updated_at FROM web_progress
        WHERE book_id IN (${placeholders})`).all(...batch) as { book_id: string; updated_at: number }[];
      for (const row of progress) {
        const entry = stats.get(row.book_id);
        if (!entry) continue;
        entry.hasProgress = true;
        entry.progressUpdatedAt = row.updated_at;
      }
      const indexes = this.db.prepare(`SELECT book_id, state FROM book_index
        WHERE book_id IN (${placeholders})`).all(...batch) as { book_id: string; state: DuplicateBookStats["indexState"] }[];
      for (const row of indexes) {
        const entry = stats.get(row.book_id);
        if (entry) entry.indexState = row.state;
      }
    }
    return stats;
  }

  aliasesForBooks(bookIds: string[]): Map<string, string[]> {
    const aliases = new Map<string, string[]>();
    for (let start = 0; start < bookIds.length; start += 500) {
      const batch = bookIds.slice(start, start + 500);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT book_id, path FROM book_duplicates
        WHERE book_id IN (${placeholders}) ORDER BY detected_at, path`).all(...batch) as { book_id: string; path: string }[];
      for (const row of rows) {
        const list = aliases.get(row.book_id);
        if (list) list.push(row.path);
        else aliases.set(row.book_id, [row.path]);
      }
    }
    return aliases;
  }

  reclaimableBytes(bookIds: string[]): number {
    let total = 0;
    for (let start = 0; start < bookIds.length; start += 500) {
      const batch = bookIds.slice(start, start + 500);
      const placeholders = batch.map(() => "?").join(",");
      const row = this.db.prepare(`SELECT
        COALESCE((SELECT SUM(LENGTH(text)) FROM chunks WHERE book_id IN (${placeholders})), 0) +
        COALESCE((SELECT SUM(LENGTH(vec)) FROM chunk_vectors WHERE book_id IN (${placeholders})), 0) AS bytes`)
        .get(...batch, ...batch) as { bytes: number };
      total += row.bytes;
    }
    return total;
  }
}

export class SqliteMergeLogRepository implements MergeLogRepository {
  constructor(private db: Db) {}

  save(entry: MergeLogEntry): void {
    this.db.prepare(`INSERT INTO book_merge_log
        (id, canonical_id, duplicate_id, duplicate_path, source_id, content_hash, note_ids_json, progress_json, merged_at)
      VALUES (@id, @canonical_id, @duplicate_id, @duplicate_path, @source_id, @content_hash, @note_ids_json, @progress_json, @merged_at)`)
      .run({
        id: entry.id,
        canonical_id: entry.canonicalId,
        duplicate_id: entry.duplicateId,
        duplicate_path: entry.duplicatePath,
        source_id: entry.sourceId,
        content_hash: entry.contentHash,
        note_ids_json: JSON.stringify(entry.noteIds),
        progress_json: entry.progress === null ? null : JSON.stringify(entry.progress),
        merged_at: entry.mergedAt,
      });
  }

  prune(before: number): number {
    return this.db.prepare("DELETE FROM book_merge_log WHERE merged_at < ?").run(before).changes;
  }
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private db: Db) {}

  run<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
