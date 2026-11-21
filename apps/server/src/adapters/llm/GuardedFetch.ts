import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  evaluateDestination,
  evaluateResolvedDestination,
  type DestinationVerdict,
} from "../../domain/assistant/LlmConfig.js";
import type { HostLookup, ResolvedAddress } from "../../ports/llm-settings.js";
import type { AllowPrivatePolicy } from "../../domain/net/IpClassification.js";

export type GuardedFetchCode =
  | "blocked"
  | "https_required"
  | "unreachable"
  | "timeout"
  | "tls"
  | "rejected";

export class GuardedFetchError extends Error {
  constructor(readonly code: GuardedFetchCode) {
    super(`Guarded request failed (${code})`);
    this.name = "GuardedFetchError";
  }
}

export interface GuardedFetchOptions {
  policy: AllowPrivatePolicy;
  /** Test seam; production resolves DNS with `dns.lookup(..., { all: true })`. */
  lookup?: HostLookup;
}

const defaultLookup: HostLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
};

function abortCode(signal: AbortSignal | null | undefined): GuardedFetchCode {
  const reason: unknown = signal?.reason;
  if (typeof reason === "object" && reason !== null && "name" in reason && reason.name === "TimeoutError") {
    return "timeout";
  }
  return "unreachable";
}

function tlsFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /certificate|TLS|SSL/i.test(message);
}

function mapFailure(error: unknown, signal: AbortSignal | null | undefined): GuardedFetchError {
  if (error instanceof GuardedFetchError) return error;
  if (signal?.aborted) return new GuardedFetchError(abortCode(signal));
  if (tlsFailure(error)) return new GuardedFetchError("tls");
  return new GuardedFetchError("unreachable");
}

function requestHeaders(init: RequestInit | undefined, body: string | Buffer | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  }
  if (body !== undefined && headers["content-length"] === undefined) {
    // HTTP counts bytes, not UTF-16 code units: Unicode prompts would otherwise be
    // truncated by the server (or rejected as an incomplete body).
    headers["content-length"] = String(typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length);
  }
  return headers;
}

function requestBody(body: RequestInit["body"]): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return body.toString();
  throw new GuardedFetchError("rejected");
}

function copyHeaders(source: IncomingHttpHeaders): Headers {
  const target = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) target.append(name, entry);
    else target.set(name, value);
  }
  return target;
}

/**
 * Adapts a Node response stream into a web ReadableStream. Cancellation destroys the
 * socket (no leaked upstream connection) and backpressure pauses the Node stream.
 */
function toWebBody(stream: Readable, abortFailure: () => Error | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      });
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
      // `aborted` can arrive before `error`; surface the caller's abort reason so the
      // client maps a timeout/cancel instead of a generic transport failure.
      stream.on("aborted", () => controller.error(abortFailure() ?? new Error("The upstream response was aborted")));
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
    },
  }, { highWaterMark: 64 * 1024 });
}

/**
 * Builds a `fetch` compatible function for UI-provided LLM URLs (ADR-15). DNS is
 * resolved inside the connection's `lookup`, every answer is classified and the
 * selected IP is pinned, so a second resolution cannot redirect the socket. Public
 * destinations require HTTPS/443; redirects are never followed and error messages
 * never include the resolved address or the provider body.
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof globalThis.fetch {
  const lookup = options.lookup ?? defaultLookup;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new GuardedFetchError("blocked");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new GuardedFetchError("blocked");
    if (!url.hostname || url.username || url.password) throw new GuardedFetchError("blocked");

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    let pinned: ResolvedAddress | undefined;
    let lookupFailure: GuardedFetchError | undefined;

    if (literalFamily !== 0) {
      const verdict: DestinationVerdict = evaluateDestination(url, hostname, options.policy);
      if (verdict !== "ok") throw new GuardedFetchError(verdict);
      pinned = { address: hostname, family: literalFamily };
    }

    const pinnedLookup: LookupFunction = (lookupHost, lookupOptions, callback) => {
      const answer = (chosen: ResolvedAddress): void => {
        // Node 20+ may ask for all addresses (happy eyeballs); return the pinned one.
        if (lookupOptions.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
        else callback(null, chosen.address, chosen.family);
      };
      if (pinned) {
        answer(pinned);
        return;
      }
      void (async () => {
        try {
          const addresses = await lookup(lookupHost);
          if (addresses.length === 0) throw new GuardedFetchError("unreachable");
          const verdict = evaluateResolvedDestination(url, addresses.map((entry) => entry.address), options.policy);
          if (verdict !== "ok") throw new GuardedFetchError(verdict);
          const chosen = addresses.find((entry) => isIP(entry.address) === entry.family);
          if (!chosen) throw new GuardedFetchError("blocked");
          pinned = chosen;
          answer(chosen);
        } catch (error) {
          const failure = mapFailure(error, init?.signal);
          lookupFailure = failure;
          callback(failure as NodeJS.ErrnoException, "", 0);
        }
      })();
    };

    const body = requestBody(init?.body);
    const headers = requestHeaders(init, body);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
      protocol: url.protocol,
      hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers,
      agent: false,
      lookup: pinnedLookup,
      // The address is already pinned and validated; dual-stack racing would add a
      // second connection path the policy did not approve.
      autoSelectFamily: false,
    };

    return await new Promise<Response>((resolve, reject) => {
      let settled = false;
      let streaming: Readable | undefined;
      let abortFailure: GuardedFetchError | undefined;
      const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = transport(requestOptions, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        const status = response.statusCode ?? 0;
        const hasBody = status !== 204 && status !== 304;
        if (!hasBody) {
          cleanup();
          resolve(new Response(null, {
            status,
            statusText: response.statusMessage ?? "",
            headers: copyHeaders(response.headers),
          }));
          return;
        }
        streaming = response;
        // Headers are not the end of the request: keep the caller's abort armed until
        // the body finishes, errors or is cancelled. Otherwise a provider that sends
        // headers and then stalls would hang the chat/probe forever.
        response.once("end", cleanup);
        response.once("error", cleanup);
        response.once("aborted", cleanup);
        response.once("close", cleanup);
        resolve(new Response(toWebBody(response, () => abortFailure), {
          status,
          statusText: response.statusMessage ?? "",
          headers: copyHeaders(response.headers),
        }));
      });

      const onAbort = (): void => {
        const error = new GuardedFetchError(abortCode(init?.signal));
        abortFailure = error;
        if (streaming && !streaming.destroyed) streaming.destroy(error);
        request.destroy(error);
        cleanup();
      };
      const cleanup = (): void => {
        init?.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(lookupFailure ?? mapFailure(error, init?.signal));
      };

      request.on("error", fail);
      if (init?.signal) {
        if (init.signal.aborted) {
          onAbort();
        } else {
          init.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      try {
        if (body !== undefined) request.write(body);
        request.end();
      } catch (error) {
        request.destroy();
        fail(error);
      }
    });
  }) as typeof globalThis.fetch;
}
