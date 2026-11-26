import { describe, expect, it } from "vitest";
import { createGuardedFetch } from "../src/adapters/llm/GuardedFetch.js";
import { GithubReleaseSource } from "../src/adapters/update/GithubReleaseSource.js";
import type { ReleaseFetchResult } from "../src/ports/update.js";

const FIXED_URL = "https://api.github.com/repos/Victor-Mazzei/Knowlify/releases/latest";
const MAX_BODY = 1024 * 1024;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (payload: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const latest = (overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  json({ tag_name: "v2.5.0", draft: false, prerelease: false, ...overrides }, headers);

const sourceWith = (fetch: typeof globalThis.fetch, timeoutMs?: number): GithubReleaseSource =>
  new GithubReleaseSource({ fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

const failed = (result: ReleaseFetchResult) => {
  expect(result.outcome).toBe("failed");
  return result as Extract<ReleaseFetchResult, { outcome: "failed" }>;
};

describe("GithubReleaseSource", () => {
  it("requests the fixed public API with fixed headers and no credentials", async () => {
    const { fetch, calls } = fakeFetch(() => latest());
    const result = await sourceWith(fetch).latest(null);
    expect(result).toMatchObject({ outcome: "ok", release: { tag: "v2.5.0" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FIXED_URL);
    expect(calls[0]!.init?.method).toBe("GET");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("knowlify-update-check");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("if-none-match")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(calls[0]!.url).not.toContain("?");
  });

  it("sends the stored ETag and handles 304 without reading a body", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, {
      status: 304,
      headers: { etag: 'W/"next-etag"' },
    }));
    const result = await sourceWith(fetch).latest('W/"saved-etag"');
    expect(result).toEqual({ outcome: "not_modified", etag: 'W/"next-etag"' });
    expect(new Headers(calls[0]!.init?.headers).get("if-none-match")).toBe('W/"saved-etag"');
  });

  it("discards draft and prerelease responses", async () => {
    for (const flag of ["draft", "prerelease"]) {
      const { fetch } = fakeFetch(() => latest({ [flag]: true }));
      expect(failed(await sourceWith(fetch).latest(null)).reason).toBe("bad_tag");
    }
  });

  it("rejects invalid tags and never reads a provider URL", async () => {
    for (const tagName of ["latest", "v2.5", "2.5.0", "v2.5.0-rc.1", `v2.5.0-${"a".repeat(80)}`]) {
      const { fetch } = fakeFetch(() => latest({ tag_name: tagName }));
      expect(failed(await sourceWith(fetch).latest(null)).reason, tagName).toBe("bad_tag");
    }
    const { fetch } = fakeFetch(() => latest({
      html_url: "http://evil.example/releases?tag=v2.5.0",
      assets: [{ browser_download_url: "http://evil.example/x" }],
    }));
    const result = await sourceWith(fetch).latest(null);
    expect(result).toMatchObject({ outcome: "ok", release: { tag: "v2.5.0" } });
    expect(JSON.stringify(result)).not.toContain("evil.example");
  });

  it("keeps only a well-formed ETag from the response", async () => {
    const { fetch } = fakeFetch(() => latest({}, {
      etag: "bad etag with spaces",
      "x-untrusted": "sentinel",
    }));
    const result = await sourceWith(fetch).latest(null);
    expect(result).toMatchObject({ outcome: "ok", etag: null });
  });

  it("maps 403 and 429 to rate_limited and parses the documented waits", async () => {
    const forbidden = fakeFetch(() => new Response(null, {
      status: 403,
      headers: { "retry-after": "120" },
    }));
    expect(failed(await sourceWith(forbidden.fetch).latest(null))).toMatchObject({
      reason: "rate_limited",
      status: 403,
      retryAfterMs: 120_000,
    });

    const reset = Math.floor(Date.now() / 1000) + 7_200;
    const limited = fakeFetch(() => new Response(null, {
      status: 429,
      headers: { "x-ratelimit-reset": String(reset) },
    }));
    const result = failed(await sourceWith(limited.fetch).latest(null));
    expect(result.reason).toBe("rate_limited");
    expect(result.status).toBe(429);
    expect(result.retryAfterMs).toBeGreaterThan(7_000_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(7_200_000);
  });

  it("treats 5xx and redirects as silent HTTP failures", async () => {
    for (const status of [301, 302, 307, 500, 503]) {
      const { fetch } = fakeFetch(() => new Response(null, {
        status,
        headers: status < 400 ? { location: "https://evil.example/" } : {},
      }));
      const result = failed(await sourceWith(fetch).latest(null));
      expect(result.reason).toBe("http_error");
      expect(result.status).toBe(status);
    }
  });

  it("requires a JSON content type", async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ tag_name: "v2.5.0" }), {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    expect(failed(await sourceWith(fetch).latest(null)).reason).toBe("bad_response");
  });

  it("treats malformed JSON and non-object payloads as bad responses", async () => {
    for (const body of ["{not json", "[]", "null", "\"v2.5.0\""]) {
      const { fetch } = fakeFetch(() => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      expect(failed(await sourceWith(fetch).latest(null)).reason, body).toBe("bad_response");
    }
  });

  it("cancels a body above 1 MB", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY + 1));
        // Deliberately left open: cancelling an already closed stream would not call the
        // source's cancel hook, and this test proves the oversized read is cancelled.
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = fakeFetch(() => new Response(oversized, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    expect(failed(await sourceWith(fetch).latest(null)).reason).toBe("bad_response");
    expect(cancelled).toBe(true);
  });

  it("cancels an oversized body already declared by Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never produce bytes: the ceiling must be enforced from the header alone.
      },
      cancel() {
        cancelled = true;
      },
    });
    const { fetch } = fakeFetch(() => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(MAX_BODY + 1) },
    }));
    expect(failed(await sourceWith(fetch).latest(null)).reason).toBe("bad_response");
    expect(cancelled).toBe(true);
  });

  it("maps a stalled request to timeout", async () => {
    const { fetch } = fakeFetch((call) => new Promise<Response>((_resolve, reject) => {
      call.init?.signal?.addEventListener("abort", () => reject(call.init?.signal?.reason));
    }));
    const result = await sourceWith(fetch, 20).latest(null);
    expect(failed(result).reason).toBe("timeout");
  });

  it("maps transport failures and blocked destinations to the silent network category", async () => {
    const offline = fakeFetch(() => Promise.reject(new Error("socket closed")));
    expect(failed(await sourceWith(offline.fetch).latest(null)).reason).toBe("network");

    // Public-only policy: a hostname resolving to a private address is refused before
    // any connection is opened. No real network is used: the lookup is injected.
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: async () => [{ address: "10.0.0.1", family: 4 }],
    });
    await expect(guarded(FIXED_URL)).rejects.toMatchObject({ code: "blocked" });
    expect(failed(await sourceWith(guarded).latest(null)).reason).toBe("network");
  });
});
