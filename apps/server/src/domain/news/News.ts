import { ValidationError } from '../errors.js';
export interface NewsLocale { hl: string; gl: string; ceid: string }
export const defaultNewsLocale: NewsLocale = { hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' };
export interface Feed { id: string; kind: 'topic' | 'custom'; title: string; url: string; query?: string; enabled: boolean; createdAt: number }
export interface Article { id: string; feedId: string; feedTitle: string; source: string; title: string; link: string; summary: string; imageUrl?: string; publishedAt?: string }
export interface Bookmark { id: string; title: string; link: string; source: string; summary: string; publishedAt?: string; savedAt: number }
export function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit) throw new ValidationError('Invalid text');
  return value.trim();
}
export function topicUrl(value: unknown): { query: string; url: string } {
  const query = text(value, 120);
  if (!query) throw new ValidationError('Query is required');
  const url = new URL('https://news.google.com/rss/search');
  url.search = new URLSearchParams({ q: query, ...defaultNewsLocale }).toString();
  return { query, url: url.href };
}
export function webUrl(value: unknown): string {
  const input = text(value, 8192);
  try { const url = new URL(input); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return input; } catch { /* Report a domain error below. */ }
  throw new ValidationError('Invalid HTTP(S) URL');
}
export function plainText(input: string, limit = 5000): string {
  const decoded = input.replace(/&(?:lt|gt|amp|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
    const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
  });
  return decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
