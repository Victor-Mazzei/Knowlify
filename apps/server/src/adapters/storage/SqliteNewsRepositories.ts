import type { Feed, Bookmark } from '../../domain/news/News.js';
import type { FeedRepository, BookmarkRepository } from '../../ports/news.js';
import type { Db } from './db.js';
type FeedRow = Omit<Feed, 'enabled' | 'query'> & { enabled: number; query: string | null };
type BookmarkRow = Omit<Bookmark, 'publishedAt'> & { publishedAt: string | null };
const bookmarkDto = (row: BookmarkRow): Bookmark => ({ ...row, publishedAt: row.publishedAt ?? undefined });
export class SqliteFeedRepository implements FeedRepository {
  constructor(private db: Db) {}
  list(): Feed[] { return (this.db.prepare('SELECT * FROM feeds ORDER BY createdAt, id').all() as FeedRow[]).map(row => ({ ...row, enabled: Boolean(row.enabled), query: row.query ?? undefined })); }
  get(id: string): Feed | undefined { return this.list().find(feed => feed.id === id); }
  save(feed: Feed): void { this.db.prepare('INSERT INTO feeds (id,kind,title,url,query,enabled,createdAt) VALUES (@id,@kind,@title,@url,@query,@enabled,@createdAt) ON CONFLICT(id) DO UPDATE SET title=excluded.title,enabled=excluded.enabled').run({ ...feed, query: feed.query ?? null, enabled: Number(feed.enabled) }); }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM feeds WHERE id=?').run(id).changes > 0; }
}
export class SqliteBookmarkRepository implements BookmarkRepository {
  constructor(private db: Db) {}
  list(): Bookmark[] { return (this.db.prepare('SELECT * FROM bookmarks ORDER BY savedAt DESC, id').all() as BookmarkRow[]).map(bookmarkDto); }
  byLink(link: string): Bookmark | undefined { const row = this.db.prepare('SELECT * FROM bookmarks WHERE link=?').get(link) as BookmarkRow | undefined; return row ? bookmarkDto(row) : undefined; }
  save(bookmark: Bookmark): void { this.db.prepare('INSERT INTO bookmarks (id,title,link,source,summary,publishedAt,savedAt) VALUES (@id,@title,@link,@source,@summary,@publishedAt,@savedAt)').run({ ...bookmark, publishedAt: bookmark.publishedAt ?? null }); }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM bookmarks WHERE id=?').run(id).changes > 0; }
}
