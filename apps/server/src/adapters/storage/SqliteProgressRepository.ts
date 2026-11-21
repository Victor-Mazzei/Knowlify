import type { Db } from "./db.js";
import type { ReadingProgress, ProgressRepository, StoredProgress } from "../../ports/index.js";

interface ProgressRow {
  book_id: string;
  percentage: number;
  updated_at: number;
}

/** Stay below SQLite's variable limit when listing a large library. */
const BATCH_SIZE = 500;

export class SqliteProgressRepository implements ProgressRepository {
  constructor(private db: Db) {}
  get(id: string) { return this.db.prepare("SELECT position,percentage FROM web_progress WHERE book_id = ?").get(id) as ReadingProgress | undefined; }
  getMany(ids: string[]): Map<string, StoredProgress> {
    const progress = new Map<string, StoredProgress>();
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batch = ids.slice(offset, offset + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT book_id,percentage,updated_at FROM web_progress WHERE book_id IN (${placeholders})`)
        .all(...batch) as ProgressRow[];
      for (const row of rows) progress.set(row.book_id, { percentage: row.percentage, updatedAt: row.updated_at });
    }
    return progress;
  }
  save(id: string, progress: ReadingProgress, now: number): void {
    this.db.prepare(`INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(book_id) DO UPDATE SET position=excluded.position,percentage=excluded.percentage,updated_at=excluded.updated_at`).run(id, progress.position, progress.percentage, now);
  }
  merge(fromBookId: string, toBookId: string): { kept: boolean; progress: { position: string; percentage: number; updatedAt: number } | null } {
    return this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT position,percentage,updated_at FROM web_progress WHERE book_id = ?")
        .get(fromBookId) as { position: string; percentage: number; updated_at: number } | undefined;
      if (!duplicate) return { kept: false, progress: null };
      const stored = { position: duplicate.position, percentage: duplicate.percentage, updatedAt: duplicate.updated_at };
      const canonical = this.db.prepare("SELECT updated_at FROM web_progress WHERE book_id = ?")
        .get(toBookId) as { updated_at: number } | undefined;
      if (!canonical || duplicate.updated_at > canonical.updated_at) {
        this.db.prepare(`INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(book_id) DO UPDATE SET position=excluded.position,percentage=excluded.percentage,updated_at=excluded.updated_at`)
          .run(toBookId, stored.position, stored.percentage, stored.updatedAt);
      }
      this.db.prepare("DELETE FROM web_progress WHERE book_id = ?").run(fromBookId);
      return { kept: true, progress: stored };
    })();
  }
}
