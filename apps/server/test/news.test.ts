import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicAddress, validateRssUrl } from '../src/adapters/rss/safety.js';
import { SafeRssSource, MAX_RSS_BYTES } from '../src/adapters/rss/SafeRssSource.js';
import { parseFeed } from '../src/adapters/rss/Parser.js';
import { MemoryArticleCache } from '../src/adapters/rss/MemoryArticleCache.js';
import { topicUrl, type Feed } from '../src/domain/news/News.js';
import { openDb } from '../src/adapters/storage/db.js';
import { SqliteFeedRepository, SqliteBookmarkRepository } from '../src/adapters/storage/SqliteNewsRepositories.js';
import { News } from '../src/use-cases/News.js';
import { buildApp } from '../src/index.js';
import { config } from '../src/config.js';
import type { RssSource } from '../src/ports/news.js';
const feed: Feed = { id: 'feed', kind: 'custom', title: 'Feed', url: 'https://example.com/rss', enabled: true, createdAt: 1 };
const rss = '<rss version="2.0"><channel><title>News</title><item><title>Article</title><link>https://example.com/a</link><source>Publisher</source><description><![CDATA[<script>bad()</script><b>Hello</b> &amp; world]]></description><pubDate>invalid</pubDate><media:thumbnail url="https://example.com/image.jpg"/></item></channel></rss>';
afterEach(() => vi.useRealTimers());
describe('RSS security', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '100.64.0.1', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.1.2.3', '255.255.255.255', '::1', '::', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:808:808::1', '2001::1', '3fff::1'])('blocks %s', ip => expect(publicAddress(ip)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows %s', ip => expect(publicAddress(ip)).toBe(true));
  it.each(['file:///etc/passwd', 'ftp://example.com', 'http://localhost', 'http://a.localhost.', 'http://a.local', 'http://user:pass@example.com', 'https://example.com:8080', 'http://example.com/#x'])('rejects URL %s', url => expect(() => validateRssUrl(url)).toThrow());
  it('validates all DNS answers and pins the selected public address', async () => {
    const download = vi.fn(async () => rss);
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    await new SafeRssSource(lookup, download).load(feed.url, feed);
    expect(download.mock.calls[0]).toEqual([new URL(feed.url), { address: '8.8.8.8', family: 4 }, expect.any(AbortSignal)]);
    const mixed = new SafeRssSource(async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], download);
    await expect(mixed.load(feed.url, feed)).rejects.toThrow('Private');
    await expect(new SafeRssSource(lookup, download).load('http://[::1]', feed)).rejects.toThrow('Private');
    expect(download).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized and non-feed responses without network', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    await expect(new SafeRssSource(lookup, async () => 'x'.repeat(MAX_RSS_BYTES + 1)).load(feed.url, feed)).rejects.toThrow('2 MB');
    await expect(new SafeRssSource(lookup, async () => '<html/>').load(feed.url, feed)).rejects.toThrow('RSS');
  });
  it('times out DNS resolution after ten seconds', async () => {
    vi.useFakeTimers();
    const promise = new SafeRssSource(() => new Promise(() => {}), async () => rss).load(feed.url, feed);
    const assertion = expect(promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000); await assertion;
  });
});
describe('RSS and Atom parser', () => {
  it('extracts safe text, source, image and stable IDs, omitting invalid dates', () => {
    const result = parseFeed(rss, feed);
    expect(result.title).toBe('News');
    expect(result.articles[0]).toMatchObject({ title: 'Article', source: 'Publisher', summary: 'Hello & world', imageUrl: 'https://example.com/image.jpg' });
    expect(result.articles[0].publishedAt).toBeUndefined();
    expect(parseFeed(rss, feed).articles[0].id).toBe(result.articles[0].id);
  });
  it('parses Atom alternate links and encoded malicious content', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Hi</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/read"/><summary>&lt;script&gt;bad&lt;/script&gt;&lt;p&gt;Safe&lt;/p&gt;</summary><published>2026-01-01</published></entry></feed>';
    expect(parseFeed(xml, feed).articles[0]).toMatchObject({ link: 'https://example.com/read', summary: 'Safe', publishedAt: '2026-01-01T00:00:00.000Z' });
  });
  it('decodes decimal and hexadecimal references in RSS text and attributes', () => {
    const xml = '<rss><channel><title>A &amp; B &#39; &#x27; &#8212;</title><item><title>T &amp; &#39; &#x27; &#x2014;</title><link>https://example.com/a?x=1&#38;y=2&amp;z=3</link><description>D &amp; &#39; &#x27; &#169;</description><enclosure type="image/jpeg" url="https://example.com/i?a=1&#38;b=2&amp;c=3&#x26;d=4"/></item></channel></rss>';
    const result = parseFeed(xml, feed);
    expect(result.title).toBe("A & B ' ' —");
    expect(result.articles[0]).toMatchObject({
      title: "T & ' ' —",
      link: 'https://example.com/a?x=1&y=2&z=3',
      summary: "D & ' ' ©",
      imageUrl: 'https://example.com/i?a=1&b=2&c=3&d=4',
    });
  });
  it('decodes decimal and hexadecimal references in Atom text and links', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><title>A &amp; &#38; &#x26;</title><entry><title>Hi &#39; &#x27;</title><link rel="self" href="https://example.com/self?x=1&#38;y=2"/><link rel="alternate" href="https://example.com/read?a=1&#38;b=2&amp;c=3&#x26;d=4"/><summary>&lt;b&gt;Safe&lt;/b&gt; &#8212;</summary></entry></feed>';
    const result = parseFeed(xml, feed);
    expect(result.title).toBe('A & & &');
    expect(result.articles[0]).toMatchObject({ title: "Hi ' '", link: 'https://example.com/read?a=1&b=2&c=3&d=4', summary: 'Safe —' });
  });
  it('rejects DOCTYPE and entity declarations with numeric decoding enabled', () => {
    const external = '<!DOCTYPE rss SYSTEM "https://example.com/evil.dtd"><rss><channel><title>x</title></channel></rss>';
    const internal = '<!DOCTYPE rss [<!ENTITY x "&#38;#38;">]><rss><channel><title>&x;</title></channel></rss>';
    expect(() => parseFeed(external, feed)).toThrow();
    expect(() => parseFeed(internal, feed)).toThrow();
  });
  it('validates links and images after entity decoding', () => {
    const xml = '<rss><channel><item><title>x</title><link>javascript&#58;alert(1)</link></item><item><title>y</title><link>https://example.com/ok</link><enclosure type="image/png" url="data&#58;text/html,x"/></item></channel></rss>';
    const articles = parseFeed(xml, feed).articles;
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({ link: 'https://example.com/ok' });
    expect(articles[0].imageUrl).toBeUndefined();
  });
  it.each(['<rss><channel>', '<html><body>no feed</body></html>', '<!DOCTYPE rss [<!ENTITY x "bad">]><rss><channel/></rss>'])('rejects malformed or unsafe XML', xml => expect(() => parseFeed(xml, feed)).toThrow());
  it('drops unsafe article links', () => expect(parseFeed(rss.replace('https://example.com/a', 'javascript:alert(1)'), feed).articles).toEqual([]));
});
describe('News application and SQLite', () => {
  it('creates topics, aggregates failures, caches, updates and preserves bookmarks', async () => {
    const db = openDb(':memory:');
    try {
      const feeds = new SqliteFeedRepository(db), bookmarks = new SqliteBookmarkRepository(db);
      let now = 1, id = 0;
      const clock = { now: () => now };
      const source: RssSource = { load: vi.fn(async (_url, item) => { if (item.query === 'broken') throw new Error('Unavailable'); return parseFeed(rss, item); }) };
      const news = new News(feeds, bookmarks, source, new MemoryArticleCache(clock), clock, { next: () => String(++id) });
      const topic = await news.addFeed({ kind: 'topic', query: 'ciência & livros' });
      expect(new URL(topic.url).searchParams.get('q')).toBe('ciência & livros');
      expect(new URL(topic.url).searchParams.get('ceid')).toBe('BR:pt-419');
      await news.addFeed({ kind: 'topic', query: 'broken' });
      const result = await news.articles();
      expect(result.articles).toHaveLength(1); expect(result.errors).toEqual([{ feedId: '2', message: 'Unavailable' }]);
      await news.articles(topic.id); expect(source.load).toHaveBeenCalledTimes(2);
      now += 600_000; await news.articles(topic.id); expect(source.load).toHaveBeenCalledTimes(3);
      news.updateFeed(topic.id, { title: 'Renamed', enabled: false });
      expect((await news.articles(topic.id)).articles).toEqual([]);
      expect(() => news.updateFeed(topic.id, { enabled: 'yes' })).toThrow();
      expect(() => topicUrl(' '.repeat(5))).toThrow(); expect(() => topicUrl('x'.repeat(121))).toThrow();
      const bookmark = news.addBookmark(result.articles[0]);
      expect(news.addBookmark(result.articles[0])).toEqual(bookmark);
      news.deleteFeed(topic.id); expect(news.listBookmarks()).toHaveLength(1);
      news.deleteBookmark(bookmark.id); expect(news.listBookmarks()).toEqual([]);
      expect(db.pragma('user_version', { simple: true })).toBe(11);
    } finally { db.close(); }
  });
  it('expires cache at exactly ten minutes', () => {
    let now = 0; const cache = new MemoryArticleCache({ now: () => now });
    cache.set('a', []); now = 599_999; expect(cache.get('a')).toEqual([]);
    now++; expect(cache.get('a')).toBeUndefined();
  });
});
it('serves all News routes with Basic auth and a fake RSS source', async () => {
  const db = openDb(':memory:');
  const source: RssSource = { load: vi.fn(async (_url, item) => parseFeed(rss, item)) };
  const { app } = await buildApp(db, false, source);
  const headers = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}` };
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) => app.inject({ method, url: `/api/news${path}`, headers, payload });
  try {
    expect((await app.inject('/api/news/feeds')).statusCode).toBe(401);
    expect((await request('GET', '/feeds')).json()).toEqual([]);
    expect((await request('POST', '/feeds', { kind: 'topic', query: '' })).statusCode).toBe(400);
    const created = await request('POST', '/feeds', { kind: 'custom', url: feed.url });
    expect(created.statusCode).toBe(201); const id = created.json().id;
    expect(created.json().title).toBe('News');
    expect((await request('PATCH', `/feeds/${id}`, { title: 'Updated' })).json().title).toBe('Updated');
    const articles = (await request('GET', `/articles?feedId=${id}&limit=1`)).json();
    expect(articles.articles).toHaveLength(1); expect(articles.errors).toEqual([]);
    expect((await request('GET', '/articles?limit=abc')).statusCode).toBe(400);
    expect((await request('GET', '/search?q=books')).json().articles).toHaveLength(1);
    expect((await request('GET', '/search?q=')).statusCode).toBe(400);
    const saved = await request('POST', '/bookmarks', articles.articles[0]);
    expect(saved.statusCode).toBe(201);
    expect((await request('POST', '/bookmarks', articles.articles[0])).json().id).toBe(saved.json().id);
    expect((await request('GET', '/bookmarks')).json()).toHaveLength(1);
    expect((await request('DELETE', `/feeds/${id}`)).statusCode).toBe(204);
    expect((await request('DELETE', `/bookmarks/${saved.json().id}`)).statusCode).toBe(204);
    expect((await request('DELETE', '/feeds/missing')).statusCode).toBe(404);
    expect((await request('POST', '/bookmarks', { title: 'Bad', link: 'javascript:bad' })).statusCode).toBe(400);
  } finally { await app.close(); db.close(); }
});
it('migrates an existing v1 database and preserves news data when reopened', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'news-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = openDb(path);
  try {
    db.exec('DROP TABLE feeds; DROP TABLE bookmarks; DROP TABLE settings; PRAGMA user_version=1;');
    db.close(); db = openDb(path);
    const repository = new SqliteFeedRepository(db);
    repository.save(feed);
    expect(repository.get(feed.id)).toEqual(feed);
    db.close(); db = openDb(path);
    expect(new SqliteFeedRepository(db).get(feed.id)).toEqual(feed);
    expect(db.pragma('user_version', { simple: true })).toBe(11);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
