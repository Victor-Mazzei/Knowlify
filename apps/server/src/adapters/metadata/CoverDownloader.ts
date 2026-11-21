import type { CoverFetcher } from "../../ports/library-metadata.js";

export type CoverFetchErrorCode = "invalid_url" | "too_large" | "not_image" | "upstream_failed";

/** A rejected cover download; the route maps the code to 400/413/415/502. */
export class CoverFetchError extends Error {
  constructor(readonly code: CoverFetchErrorCode, readonly status: 400 | 413 | 415 | 502, message: string) {
    super(message);
    this.name = "CoverFetchError";
  }
}

const ALLOWED_HOSTS = ["books.google.com", "books.googleusercontent.com", "covers.openlibrary.org"] as const;
const ALLOWED_SUFFIX = "archive.org";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const invalid = (message: string): never => {
  throw new CoverFetchError("invalid_url", 400, message);
};

const hostAllowed = (hostname: string): boolean =>
  ALLOWED_HOSTS.includes(hostname as (typeof ALLOWED_HOSTS)[number])
  || hostname === ALLOWED_SUFFIX
  || hostname.endsWith(`.${ALLOWED_SUFFIX}`);

/**
 * Validates a user-provided cover URL before any DNS/socket work (ADR-5): HTTPS on 443,
 * no credentials/fragment and an allowlisted provider host. `covers.openlibrary.org`
 * redirects to `archive.org`, which is why both are accepted.
 */
export function assertAllowedCoverUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("The cover URL is not valid");
  }
  if (url.protocol !== "https:") return invalid("The cover URL must use HTTPS");
  if (url.username || url.password) return invalid("The cover URL must not contain credentials");
  if (url.hash) return invalid("The cover URL must not contain a fragment");
  if (url.port !== "" && url.port !== "443") return invalid("The cover URL must use port 443");
  if (!url.hostname) return invalid("The cover URL is not valid");
  if (!hostAllowed(url.hostname.toLowerCase())) return invalid("The cover host is not allowed");
  return url;
}

export interface CoverDownloaderOptions {
  /** Injected createGuardedFetch({ policy: { mode: "off" } }) in the composition root. */
  fetch: typeof globalThis.fetch;
  userAgent: string;
  /** Per-request total deadline, redirects included. */
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Downloads a cover from an allowlisted HTTPS URL. Every redirect hop is revalidated by
 * the same host/protocol policy and goes through the guarded fetch, so DNS is resolved
 * and pinned again for each hop (a redirect cannot smuggle a private address). The body
 * is read in a stream with a 2 MB ceiling; the declared content type is checked here and
 * the bytes are sniffed later by the cover store.
 */
export class CoverDownloader implements CoverFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: CoverDownloaderOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  async fetch(raw: string, signal?: AbortSignal): Promise<Buffer> {
    let url = assertAllowedCoverUrl(raw);
    const deadline = signal ?? AbortSignal.timeout(this.timeoutMs);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.request(url, deadline);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new CoverFetchError("upstream_failed", 502, "The cover host returned an invalid redirect");
        if (hop === MAX_REDIRECTS) {
          throw new CoverFetchError("upstream_failed", 502, "Too many cover redirects");
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new CoverFetchError("upstream_failed", 502, "The cover host returned an invalid redirect");
        }
        url = assertAllowedCoverUrl(next.toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new CoverFetchError("upstream_failed", 502, "The cover host did not return an image");
      }
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!IMAGE_TYPES.has(type)) {
        await response.body?.cancel();
        throw new CoverFetchError("not_image", 415, "The cover URL did not return a supported image");
      }
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > this.maxBytes) {
        await response.body?.cancel();
        throw new CoverFetchError("too_large", 413, "The cover image is too large");
      }
      return await this.readBody(response);
    }
    throw new CoverFetchError("upstream_failed", 502, "Too many cover redirects");
  }

  private async request(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await this.options.fetch(url.toString(), {
        method: "GET",
        signal,
        redirect: "manual",
        headers: {
          accept: "image/jpeg,image/png,image/webp",
          "user-agent": this.options.userAgent,
        },
      });
    } catch (error) {
      if (error instanceof CoverFetchError) throw error;
      // DNS blocked, private/reserved IP, TLS, timeout: all generic, none leak the address.
      throw new CoverFetchError("upstream_failed", 502, "The cover could not be downloaded");
    }
  }

  private async readBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new CoverFetchError("not_image", 415, "The cover response was empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        throw new CoverFetchError("too_large", 413, "The cover image is too large");
      }
      chunks.push(value);
    }
    if (total === 0) throw new CoverFetchError("not_image", 415, "The cover response was empty");
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
}
