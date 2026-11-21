import type { Article, Bookmark, Feed } from '../domain/news/News.js';
export interface RssSource { load(url: string, feed: Feed): Promise<{ title: string; articles: Article[] }> }
export interface FeedRepository { list(): Feed[]; get(id: string): Feed | undefined; save(feed: Feed): void; delete(id: string): boolean }
export interface BookmarkRepository { list(): Bookmark[]; byLink(link: string): Bookmark | undefined; save(bookmark: Bookmark): void; delete(id: string): boolean }
export interface ArticleCache { get(key: string): Article[] | undefined; set(key: string, articles: Article[]): void; delete(key: string): void }
