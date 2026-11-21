import { NotFoundError, ValidationError } from '../domain/errors.js';
import { date, plainText, text, topicUrl, webUrl, type Feed, type Bookmark } from '../domain/news/News.js';
import type { Clock, IdGenerator } from '../ports/index.js';
import type { ArticleCache, BookmarkRepository, FeedRepository, RssSource } from '../ports/news.js';
function input(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an object');
  return value as Record<string, unknown>;
}
function limit(value?: string): number {
  if (value === undefined) return 100;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) throw new ValidationError('Limit must be between 1 and 500');
  return number;
}
export class News {
  constructor(private feeds: FeedRepository, private bookmarks: BookmarkRepository, private rss: RssSource, private cache: ArticleCache, private clock: Clock, private ids: IdGenerator) {}
  listFeeds() { return this.feeds.list(); }
  async addFeed(value: unknown): Promise<Feed> {
    const body = input(value);
    const base = { id: this.ids.next(), enabled: true, createdAt: this.clock.now() };
    let feed: Feed;
    if (body.kind === 'topic') {
      const topic = topicUrl(body.query);
      feed = { ...base, kind: 'topic', title: topic.query, ...topic };
    } else if (body.kind === 'custom') {
      feed = { ...base, kind: 'custom', title: 'RSS', url: webUrl(body.url) };
      const result = await this.rss.load(feed.url, feed);
      feed.title = result.title;
      this.cache.set(feed.id, result.articles.map(article => ({ ...article, feedTitle: feed.title })));
    } else throw new ValidationError('Invalid feed kind');
    this.feeds.save(feed);
    return feed;
  }
  updateFeed(id: string, value: unknown): Feed {
    const body = input(value);
    const feed = this.feeds.get(id);
    if (!feed) throw new NotFoundError('Feed not found');
    if (body.title !== undefined) { feed.title = plainText(text(body.title, 500), 500); if (!feed.title) throw new ValidationError('Title is required'); }
    if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw new ValidationError('Invalid enabled flag'); feed.enabled = body.enabled; }
    this.feeds.save(feed); this.cache.delete(id);
    return feed;
  }
  deleteFeed(id: string): void { if (!this.feeds.delete(id)) throw new NotFoundError('Feed not found'); this.cache.delete(id); }
  private async collect(feeds: Feed[], count: number) {
    const results = await Promise.all(feeds.map(async feed => {
      try {
        let articles = this.cache.get(feed.id);
        if (!articles) { articles = (await this.rss.load(feed.url, feed)).articles; this.cache.set(feed.id, articles); }
        return { articles, errors: [] as { feedId: string; message: string }[] };
      } catch (error) { return { articles: [], errors: [{ feedId: feed.id, message: error instanceof Error ? error.message : 'Feed unavailable' }] }; }
    }));
    return { articles: results.flatMap(result => result.articles).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, count), errors: results.flatMap(result => result.errors) };
  }
  articles(feedId?: string, count?: string) {
    const feeds = feedId ? [this.feeds.get(feedId)] : this.feeds.list();
    if (feeds.some(feed => !feed)) throw new NotFoundError('Feed not found');
    return this.collect(feeds.filter((feed): feed is Feed => !!feed && feed.enabled), limit(count));
  }
  search(query: unknown, count?: string) {
    const topic = topicUrl(query);
    return this.collect([{ id: `search:${topic.query}`, kind: 'topic', title: topic.query, ...topic, enabled: true, createdAt: this.clock.now() }], limit(count));
  }
  listBookmarks() { return this.bookmarks.list(); }
  addBookmark(value: unknown): Bookmark {
    const body = input(value);
    const link = webUrl(body.link);
    const existing = this.bookmarks.byLink(link);
    if (existing) return existing;
    const title = plainText(text(body.title, 1000), 1000);
    if (!title) throw new ValidationError('Title is required');
    const bookmark: Bookmark = { id: this.ids.next(), title, link, source: plainText(text(body.source ?? '', 500), 500), summary: plainText(text(body.summary ?? '', 20_000)), publishedAt: date(body.publishedAt), savedAt: this.clock.now() };
    this.bookmarks.save(bookmark); return bookmark;
  }
  deleteBookmark(id: string): void { if (!this.bookmarks.delete(id)) throw new NotFoundError('Bookmark not found'); }
}
