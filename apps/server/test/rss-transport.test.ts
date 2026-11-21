import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { pinnedDownload, MAX_RSS_BYTES } from '../src/adapters/rss/SafeRssSource.js';
afterEach(() => vi.restoreAllMocks());
function response(status: number, body: string, length?: number) {
  let options: http.RequestOptions | undefined;
  const request = new PassThrough();
  vi.spyOn(http, 'request').mockImplementation(((url: URL, opts: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    options = opts;
    queueMicrotask(() => {
      const stream = new PassThrough() as unknown as http.IncomingMessage;
      stream.statusCode = status;
      stream.headers = length === undefined ? {} : { 'content-length': String(length) };
      callback(stream);
      if (!stream.destroyed) stream.end(body);
    });
    return request as unknown as http.ClientRequest;
  }) as typeof http.request);
  return () => options;
}
it.each([301, 302, 307, 404, 500])('rejects HTTP %s without following redirects', async status => {
  response(status, '');
  await expect(pinnedDownload(new URL('http://example.com'), { address: '8.8.8.8', family: 4 }, new AbortController().signal)).rejects.toThrow('rejected');
  expect(http.request).toHaveBeenCalledTimes(1);
});
it('rejects size declared by headers', async () => {
  response(200, '', MAX_RSS_BYTES + 1);
  await expect(pinnedDownload(new URL('http://example.com'), { address: '8.8.8.8', family: 4 }, new AbortController().signal)).rejects.toThrow('rejected');
});
it('rejects streamed content beyond the byte limit', async () => {
  response(200, 'x'.repeat(MAX_RSS_BYTES + 1));
  await expect(pinnedDownload(new URL('http://example.com'), { address: '8.8.8.8', family: 4 }, new AbortController().signal)).rejects.toThrow('2 MB');
});
it('preserves the original hostname and pins DNS through the request lookup', async () => {
  const options = response(200, '<rss/>');
  expect(await pinnedDownload(new URL('http://example.com'), { address: '8.8.8.8', family: 4 }, new AbortController().signal)).toBe('<rss/>');
  const callback = vi.fn();
  options()?.lookup?.('example.com', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(options()?.agent).toBe(false);
});
