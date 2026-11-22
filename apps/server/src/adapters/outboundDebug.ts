import { isIP } from "node:net";
import type { Logger } from "../ports/index.js";

/**
 * One debug line per outbound HTTP exchange. Only routing metadata is allowed here:
 * the host, the method, a closed allowlist of fixed provider paths, status, duration,
 * size and the SSRF verdict. Cover, RSS and LLM URLs are caller/provider controlled, so
 * their pathname is never logged as-is; neither are bodies, query strings or headers.
 */

export interface OutboundTarget {
  host: string;
  /** Present only when the pathname is one of the known safe routes. */
  path?: string;
  method: string;
}

export interface OutboundEvent extends OutboundTarget {
  provider: string;
  status?: number;
  durationMs: number;
  bytes?: number;
  reason?: string;
  networkCode?: string;
  /** Destination kind: public, private, loopback, link-local, reserved or unknown. */
  destination?: string;
  /** Only filled for a public destination; private addresses stay at the category. */
  ip?: string;
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Hostnames are caller/provider controlled (RSS feeds, LLM base URLs and archive.org
 * subdomains), so a token can hide in a subdomain. Only exact known hosts, IP literals
 * and fixed categories reach the log; everything else becomes `external`.
 */
const SAFE_HOSTS: ReadonlySet<string> = new Set([
  "www.googleapis.com",
  "openlibrary.org",
  "covers.openlibrary.org",
  "books.google.com",
  "books.googleusercontent.com",
  "archive.org",
  "localhost",
  "unknown",
  "external",
]);
const ARCHIVE_SUBDOMAIN = /(?:^|\.)archive\.org$/;

/** A closed host allowlist plus IP literals; never a caller-controlled hostname. */
export function safeHost(value: unknown): string {
  if (typeof value !== "string") return "external";
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 255) return "external";
  if (SAFE_HOSTS.has(host)) return host;
  if (ARCHIVE_SUBDOMAIN.test(host)) return "archive.org";
  const bare = host.replace(/^\[|\]$/g, "");
  return isIP(bare) !== 0 ? host : "external";
}

/**
 * Closed allowlist of exact paths whose text is known to be safe and useful in a log.
 * Every other pathname (cover URLs, RSS feeds, LLM endpoints) is omitted; only the
 * host is reported for them.
 */
const SAFE_PATHS: ReadonlySet<string> = new Set([
  "/books/v1/volumes",
  "/search.json",
  "/books/content",
]);

const safePath = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_PATHS.has(value) ? value : undefined;

const token = (value: string, pattern: RegExp, fallback: string): string =>
  !/[\r\n]/u.test(value) && pattern.test(value) ? value : fallback;

/** Host, safe path and method of a URL; the query string and credentials are dropped. */
export function outboundTarget(input: FetchInput, method?: string): OutboundTarget {
  const raw = typeof input === "string"
    ? input
    : input instanceof URL ? input.toString() : input.url;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { host: "unknown", method: methodToken(method) };
  }
  const path = safePath(url.pathname);
  return {
    host: safeHost(url.hostname),
    ...(path === undefined ? {} : { path }),
    method: methodToken(method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET")),
  };
}

const methodToken = (value: string | undefined): string => {
  const method = (value ?? "GET").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10);
  return method.length > 0 ? method : "GET";
};

const statusOf = (value: number | undefined): string | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599
    ? String(value)
    : undefined;

const bytesOf = (value: number | undefined): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;

/** Emits the shared debug line; a logger without `debug` (or at a higher level) is a no-op. */
export function logOutbound(log: Logger | undefined, event: OutboundEvent): void {
  if (!log?.debug) return;
  const fields = [
    `provider=${token(event.provider, TOKEN, "http")}`,
    `method=${methodToken(event.method)}`,
    `host=${safeHost(event.host)}`,
  ];
  // Re-check here as well: a caller passing a raw URL pathname must not leak it.
  const path = safePath(event.path);
  if (path !== undefined) fields.push(`path=${path}`);
  const status = statusOf(event.status);
  if (status !== undefined) fields.push(`status=${status}`);
  fields.push(`durationMs=${Math.max(0, Math.round(event.durationMs))}`);
  const bytes = bytesOf(event.bytes);
  if (bytes !== undefined) fields.push(`bytes=${bytes}`);
  if (event.destination !== undefined) {
    fields.push(`destination=${token(event.destination, TOKEN, "unknown")}`);
  }
  if (event.ip !== undefined && event.destination === "public") {
    fields.push(`ip=${safeAddress(event.ip)}`);
  }
  if (event.reason !== undefined) fields.push(`reason=${token(event.reason, TOKEN, "unknown")}`);
  if (event.networkCode !== undefined) {
    fields.push(`networkCode=${token(event.networkCode, TOKEN, "unknown")}`);
  }
  log.debug(`http outbound ${fields.join(" ")}`);
}

/** Content-Length of a response, when the provider declared it. */
export function responseBytes(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** A client/resolved address ready for a single-line log; `unknown` when it is not one. */
export function safeAddress(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const address = value.trim();
  if (address.length === 0 || address.length > 64) return "unknown";
  return isIP(address) !== 0 ? address : "unknown";
}

/** Raw Node code when a transport failure exposes one; never the error message. */
export function networkCodeOf(error: unknown): string | undefined {  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && TOKEN.test(direct)) return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && TOKEN.test(code) ? code : undefined;
}

export function outboundFailure(error: unknown, signal?: AbortSignal | null): {
  reason: string;
  networkCode?: string;
} {
  const name = (error as { name?: unknown } | null)?.name;
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") return { reason: "timeout" };
  return { reason: "network", networkCode: networkCodeOf(error) };
}

/**
 * Wraps a plain fetch with the shared debug line. Guarded fetches log from inside
 * `GuardedFetch` (they also know the SSRF verdict); this covers operator-owned URLs
 * that intentionally bypass the guard.
 */
export function observedFetch(
  fetchFn: typeof globalThis.fetch,
  provider: string,
  log?: Logger,
): typeof globalThis.fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const target = outboundTarget(input, init?.method);
    const started = Date.now();
    try {
      const response = await fetchFn(input, init);
      logOutbound(log, {
        provider,
        ...target,
        status: response.status,
        durationMs: Date.now() - started,
        bytes: responseBytes(response),
      });
      return response;
    } catch (error) {
      logOutbound(log, {
        provider,
        ...target,
        status: 0,
        durationMs: Date.now() - started,
        ...outboundFailure(error, init?.signal),
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}
