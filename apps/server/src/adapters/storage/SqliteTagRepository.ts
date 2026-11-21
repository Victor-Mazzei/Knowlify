import type { Db } from "./db.js";
import type { Tag } from "../../domain/library/Tag.js";
import type { TagApplyResult, TagRecord, TagRepository, TagWithCount } from "../../ports/library-tags.js";

interface TagRow {
  id: string;
  name: string;
  color: Tag["color"];
  created_at: number;
  count?: number;
}

const toTag = (row: TagRow): Tag => ({
  id: row.id,
  name: row.name,
  color: row.color,
  createdAt: row.created_at,
});

const chunk = <T>(values: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) batches.push(values.slice(start, start + size));
  return batches;
};

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

/** Tags and their book links (ADR-5). All statements are parameterized. */
export class SqliteTagRepository implements TagRepository {
  constructor(private db: Db) {}

  list(): TagWithCount[] {
    const rows = this.db.prepare(`SELECT t.*, COUNT(bt.book_id) AS count FROM tags t
      LEFT JOIN book_tags bt ON bt.tag_id = t.id
      GROUP BY t.id ORDER BY t.name_key`).all() as TagRow[];
    return rows.map((row) => ({ ...toTag(row), count: row.count ?? 0 }));
  }

  get(id: string): Tag | undefined {
    const row = this.db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as TagRow | undefined;
    return row && toTag(row);
  }

  byIds(ids: string[]): Tag[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM tags WHERE id IN (${placeholders(ids.length)})`).all(...ids) as TagRow[];
    const found = new Map(rows.map((row) => [row.id, toTag(row)]));
    return ids.flatMap((id) => {
      const tag = found.get(id);
      return tag ? [tag] : [];
    });
  }

  byNameKey(nameKey: string): Tag | undefined {
    const row = this.db.prepare("SELECT * FROM tags WHERE name_key = ?").get(nameKey) as TagRow | undefined;
    return row && toTag(row);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n;
  }

  create(tag: TagRecord): void {
    this.db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES (?,?,?,?,?)")
      .run(tag.id, tag.name, tag.nameKey, tag.color, tag.createdAt);
  }

  update(tag: TagRecord): void {
    this.db.prepare("UPDATE tags SET name = ?, name_key = ?, color = ? WHERE id = ?")
      .run(tag.name, tag.nameKey, tag.color, tag.id);
  }

  delete(id: string): boolean {
    // ON DELETE CASCADE removes only the associations; the books stay untouched.
    return this.db.prepare("DELETE FROM tags WHERE id = ?").run(id).changes > 0;
  }

  forBooks(bookIds: string[]): Map<string, string[]> {
    const tags = new Map<string, string[]>();
    for (const batch of chunk(bookIds, 500)) {
      const rows = this.db.prepare(`SELECT book_id, tag_id FROM book_tags
        WHERE book_id IN (${placeholders(batch.length)}) ORDER BY book_id, tag_id`).all(...batch) as {
        book_id: string;
        tag_id: string;
      }[];
      for (const row of rows) {
        const list = tags.get(row.book_id);
        if (list) list.push(row.tag_id);
        else tags.set(row.book_id, [row.tag_id]);
      }
    }
    // Contract: `tagIds` ordered by name_key, not by opaque id.
    const tagRows = this.db.prepare("SELECT id, name_key FROM tags").all() as { id: string; name_key: string }[];
    const names = new Map(tagRows.map((row) => [row.id, row.name_key] as const));
    for (const list of tags.values()) {
      list.sort((a, b) => {
        const left = names.get(a) ?? a;
        const right = names.get(b) ?? b;
        return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return tags;
  }

  reassign(fromBookId: string, toBookId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO book_tags (book_id, tag_id, created_at)
        SELECT ?, tag_id, created_at FROM book_tags WHERE book_id = ?`).run(toBookId, fromBookId);
      this.db.prepare("DELETE FROM book_tags WHERE book_id = ?").run(fromBookId);
    })();
  }

  apply(bookIds: string[], add: string[], remove: string[], now: number, maxPerBook: number): TagApplyResult {
    let added = 0;
    let removed = 0;
    if (add.length > 0) {
      // One multi-row INSERT OR IGNORE per batch: `changes` counts only newly inserted links.
      for (const books of chunk(bookIds, 200)) {
        for (const tags of chunk(add, 50)) {
          const values = books.flatMap((bookId) => tags.map(() => "(?,?,?)")).join(",");
          const params: Array<string | number> = [];
          for (const bookId of books) for (const tagId of tags) params.push(bookId, tagId, now);
          added += this.db.prepare(`INSERT OR IGNORE INTO book_tags (book_id, tag_id, created_at) VALUES ${values}`)
            .run(...params).changes;
        }
      }
    }
    if (remove.length > 0) {
      for (const books of chunk(bookIds, 500)) {
        removed += this.db.prepare(`DELETE FROM book_tags WHERE book_id IN (${placeholders(books.length)})
          AND tag_id IN (${placeholders(remove.length)})`).run(...books, ...remove).changes;
      }
    }
    let overLimitBookId: string | null = null;
    for (const books of chunk(bookIds, 500)) {
      const row = this.db.prepare(`SELECT book_id FROM book_tags WHERE book_id IN (${placeholders(books.length)})
        GROUP BY book_id HAVING COUNT(*) > ? LIMIT 1`).get(...books, maxPerBook) as { book_id: string } | undefined;
      if (row) {
        overLimitBookId = row.book_id;
        break;
      }
    }
    return { added, removed, overLimitBookId };
  }
}
