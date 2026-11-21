import type { FavoriteRepository } from "../../ports/index.js";
import type { Db } from "./db.js";

/** One transaction, one statement per block: large filter selections stay bounded. */
const BLOCK_SIZE = 100;

/**
 * The favorite flag lives on `books` (ADR-1), so a row that disappears takes its flag with
 * it and no join is needed to read it back. Only this repository writes the column.
 */
export class SqliteFavoriteRepository implements FavoriteRepository {
  constructor(private db: Db) {}

  set(bookId: string, favorite: boolean): boolean {
    return this.db.prepare("UPDATE books SET favorite = ? WHERE id = ?")
      .run(favorite ? 1 : 0, bookId).changes > 0;
  }

  setMany(bookIds: string[], favorite: boolean): number {
    const ids = [...new Set(bookIds)];
    if (ids.length === 0) return 0;
    const write = this.db.transaction(() => {
      let changed = 0;
      for (let start = 0; start < ids.length; start += BLOCK_SIZE) {
        const block = ids.slice(start, start + BLOCK_SIZE);
        const placeholders = block.map(() => "?").join(",");
        changed += this.db
          .prepare(`UPDATE books SET favorite = ? WHERE id IN (${placeholders})`)
          .run(favorite ? 1 : 0, ...block).changes;
      }
      return changed;
    });
    return write();
  }
}
