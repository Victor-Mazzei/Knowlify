import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { ValidationError } from '../../domain/errors.js';
import type { Feed } from '../../domain/news/News.js';
import type { RssSource } from '../../ports/news.js';
import type { Logger } from '../../ports/index.js';
import { logOutbound, outboundFailure, outboundTarget } from '../outboundDebug.js';
import { publicAddress, validateRssUrl } from './safety.js';
import { parseFeed } from './Parser.js';
export const MAX_RSS_BYTES = 2 * 1024 * 1024;
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export type Download = (url: URL, address: { address: string; family: number }, signal: AbortSignal) => Promise<string>;
export const pinnedDownload: Download = (url, address, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? https : http).request(url, {
    signal, agent: false, family: address.family,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'Knowlify/1.0' },
  }, response => {
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300 || Number(response.headers['content-length']) > MAX_RSS_BYTES) {
      response.destroy(); reject(new ValidationError('RSS response rejected (status, redirect or size)')); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RSS_BYTES) { reject(new ValidationError('RSS exceeds 2 MB')); response.destroy(); }
      else chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('aborted', () => reject(new ValidationError('RSS response interrupted')));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  request.on('error', reject);
  request.end();
});
export class SafeRssSource implements RssSource {
  constructor(
    private lookup: Lookup = host => dns.lookup(host, { all: true }),
    private download: Download = pinnedDownload,
    private readonly log?: Logger,
  ) {}

  async load(input: string, feed: Feed) {
    const url = validateRssUrl(input);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const started = Date.now();
    // RSS URLs are user-provided; the shared helper drops their pathname (only hosts
    // and the closed allowlist of fixed provider paths are safe to log).
    const target = { provider: 'rss', ...outboundTarget(url, 'GET') };
    let responded = false;
    let blocked = false;
    const controller = new AbortController();
    const deadline = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new ValidationError('RSS timed out')), { once: true }));
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await Promise.race([deadline, (async () => {
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.lookup(host);
        if (!addresses.length || addresses.some(a => isIP(a.address) !== a.family || !publicAddress(a.address))) {
          blocked = true;
          throw new ValidationError('Private or reserved RSS destination');
        }
        const xml = await this.download(url, addresses[0], controller.signal);
        if (Buffer.byteLength(xml) > MAX_RSS_BYTES) throw new ValidationError('RSS exceeds 2 MB');
        responded = true;
        logOutbound(this.log, {
          ...target,
          status: 200,
          durationMs: Date.now() - started,
          bytes: Buffer.byteLength(xml),
          destination: 'public',
          ip: addresses[0].address,
        });
        return parseFeed(xml, feed);
      })()]);
    } catch (error) {
      // One line per exchange: a response already logged above is not reported again.
      if (!responded) {
        logOutbound(this.log, {
          ...target,
          status: 0,
          durationMs: Date.now() - started,
          destination: blocked ? 'blocked' : undefined,
          ...(blocked
            ? { reason: 'blocked_destination' }
            : controller.signal.aborted
              ? { reason: 'timeout' }
              : error instanceof ValidationError
                ? { reason: 'http_error' }
                : { reason: 'network', networkCode: outboundFailure(error, controller.signal).networkCode }),
        });
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}
