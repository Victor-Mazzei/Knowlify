import type { Article } from '../../domain/news/News.js';
import type { Clock } from '../../ports/index.js';
import type { ArticleCache } from '../../ports/news.js';
export class MemoryArticleCache implements ArticleCache {
  private entries = new Map<string, { expires: number; articles: Article[] }>();
  constructor(private clock: Clock) {}
  get(key: string): Article[] | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= this.clock.now()) { this.entries.delete(key); return undefined; }
    return entry.articles;
  }
  set(key: string, articles: Article[]): void {
    // Bound memory even when many one-off searches are made within the TTL.
    if (this.entries.size >= 200) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: this.clock.now() + 600_000, articles });
  }
  delete(key: string): void { this.entries.delete(key); }
}
