import { isIP } from 'node:net';
import { ValidationError } from '../../domain/errors.js';
import { webUrl } from '../../domain/news/News.js';
import { classify } from '../../domain/net/IpClassification.js';
export function validateRssUrl(input: string): URL {
  const url = new URL(webUrl(input));
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if ((url.port && !['80', '443'].includes(url.port)) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || url.hash) throw new ValidationError('RSS destination is not allowed');
  return url;
}
/**
 * RSS pins the family-specific address returned by the lookup, so an IPv4-mapped IPv6
 * literal is not accepted as a public destination (pre-existing transport contract).
 * The range knowledge itself lives in the shared classifier.
 */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 6 && /^::ffff:/i.test(address)) return false;
  return classify(address) === 'public';
}
