import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ValidationError } from '../../domain/errors.js';
import { date, plainText, webUrl, type Article, type Feed } from '../../domain/news/News.js';
type Node = Record<string, unknown>;
const object = (value: unknown): Node => value !== null && typeof value === 'object' ? value as Node : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const string = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : String(object(value)['#text'] ?? '');
function link(value: unknown): string | undefined { try { return webUrl(value); } catch { return undefined; } }
export function parseFeed(xml: string, feed: Feed): { title: string; articles: Article[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new ValidationError('Invalid RSS/Atom XML');
  // fast-xml-parser v5 gates numeric character references behind htmlEntities; enabling it restores v4-compatible decoding in text and attributes.
  const root = object(new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true, htmlEntities: true, removeNSPrefix: true }).parse(xml) as unknown);
  const atom = root.feed !== undefined;
  const channel = object(atom ? root.feed : object(root.rss).channel);
  if (!root.feed && !object(root.rss).channel) throw new ValidationError('Expected RSS or Atom feed');
  const title = plainText(string(channel.title), 500) || feed.title;
  const articles: Article[] = [];
  for (const raw of list(atom ? channel.entry : channel.item)) {
    const item = object(raw);
    const links = list(item.link);
    const alternate = links.find(value => !object(value)['@_rel'] || object(value)['@_rel'] === 'alternate');
    const url = link(atom ? object(alternate)['@_href'] : string(item.link));
    if (!url) continue;
    const content = string(item.description ?? item.summary ?? item.encoded ?? item.content);
    const media = object(item.thumbnail ?? item['content']);
    const enclosure = object(item.enclosure);
    const imageUrl = link(media['@_url'] ?? (String(enclosure['@_type']).startsWith('image/') ? enclosure['@_url'] : undefined) ?? content.match(/<img\b[^>]*src=["']([^"']+)/i)?.[1]);
    articles.push({ id: createHash('sha256').update(`${feed.id}:${url}`).digest('hex'), feedId: feed.id, feedTitle: feed.title, source: plainText(string(item.source), 500) || title, title: plainText(string(item.title), 1000), link: url, summary: plainText(content), imageUrl, publishedAt: date(string(item.pubDate ?? item.published ?? item.updated ?? item.date)) });
  }
  return { title, articles };
}
