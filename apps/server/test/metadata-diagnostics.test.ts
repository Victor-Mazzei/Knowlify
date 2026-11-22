import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { metadataRoutes } from "../src/adapters/http/metadata.js";
import { GuardedFetchError, createGuardedFetch } from "../src/adapters/llm/GuardedFetch.js";
import { GoogleBooks } from "../src/adapters/metadata/GoogleBooks.js";
import { MetadataCache } from "../src/adapters/metadata/MetadataCache.js";
import { OpenLibrary } from "../src/adapters/metadata/OpenLibrary.js";
import { MetadataProviderError, classifyHttpStatus, providerFailure } from "../src/adapters/metadata/httpJson.js";
import { logOutbound, observedFetch, outboundTarget, safeAddress } from "../src/adapters/outboundDebug.js";
import { SafeRssSource } from "../src/adapters/rss/SafeRssSource.js";
import { MetadataLookup } from "../src/use-cases/MetadataLookup.js";
import type { Logger } from "../src/ports/index.js";
import type { MetadataProvider } from "../src/ports/library-metadata.js";

const USER_AGENT = "Knowlify/test";

interface FakeServer {
  base: string;
  requests: Array<{ url: string; headers: IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

const servers: FakeServer[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const entry: FakeServer = {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
  servers.push(entry);
  return entry;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** The adapter always targets googleapis; the fake server receives the same path and query. */
const forward = (base: string): typeof globalThis.fetch =>
  ((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return globalThis.fetch(`${base}${url.pathname}${url.search}`, init);
  }) as typeof globalThis.fetch;

const json = (status: number, body: unknown): Parameters<typeof serve>[0] =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

const googleError = (
  code: number,
  status: string,
  reason: string,
  detailReason?: string,
): Record<string, unknown> => ({
  error: {
    code,
    message: "provider message that must never be logged",
    errors: [{ message: "provider message that must never be logged", domain: "global", reason }],
    status,
    ...(detailReason === undefined ? {} : {
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: detailReason }],
    }),
  },
});

/** A response whose body fails while it is being read; the signal may abort first. */
const failingBody = (status: number, mode: "abort" | "network", abort: () => void): Response =>
  new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (mode === "abort") abort();
      controller.error(
        mode === "abort"
          ? new DOMException("aborted", "AbortError")
          : Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      );
    },
  }), { status, headers: { "content-type": "application/json" } });

/** Captured from the public Google Books API without a key (no sensitive fields). */
const REAL_429 = {
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Queries'",
    errors: [{ message: "Quota exceeded for quota metric 'Queries'", domain: "global", reason: "rateLimitExceeded" }],
    status: "RESOURCE_EXHAUSTED",
  },
};

const capture = () => {
  const warns: string[] = [];
  const debug: string[] = [];
  const log = {
    warn: (message: string) => warns.push(message),
    debug: (message: string) => debug.push(message),
  };
  return { log, warns, debug };
};

const search = (adapter: GoogleBooks | OpenLibrary, query: { isbn: string } | { title: string; author?: string }) =>
  adapter.search(query, AbortSignal.timeout(2_000));

const failureOf = async (promise: Promise<unknown>): Promise<Record<string, unknown>> =>
  promise.then(
    () => { throw new Error("expected the provider to fail"); },
    (error: unknown) => error as Record<string, unknown>,
  );

describe("provider failure classification", () => {
  it("classifies every Google Books HTTP outcome and keeps the legacy code", async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      reason: string;
      code?: string;
      errorStatus?: string;
      errorReason?: string;
    }> = [
      {
        status: 400,
        body: googleError(400, "INVALID_ARGUMENT", "badRequest", "API_KEY_INVALID"),
        reason: "key_rejected",
        errorStatus: "INVALID_ARGUMENT",
        errorReason: "API_KEY_INVALID",
      },
      { status: 401, body: {}, reason: "key_rejected" },
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "forbidden", "API_KEY_HTTP_REFERRER_BLOCKED"),
        reason: "referrer_or_ip_blocked",
        errorStatus: "PERMISSION_DENIED",
        errorReason: "API_KEY_HTTP_REFERRER_BLOCKED",
      },
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "forbidden", "API_KEY_IP_ADDRESS_BLOCKED"),
        reason: "referrer_or_ip_blocked",
      },
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED"),
        reason: "service_disabled",
        errorReason: "SERVICE_DISABLED",
      },
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "accessNotConfigured"),
        reason: "service_disabled",
      },
      { status: 403, body: googleError(403, "PERMISSION_DENIED", "forbidden"), reason: "forbidden" },
      { status: 403, body: {}, reason: "forbidden" },
      { status: 404, body: {}, reason: "not_found" },
      {
        status: 429,
        body: REAL_429,
        reason: "rate_limited",
        code: "rate_limited",
        errorStatus: "RESOURCE_EXHAUSTED",
        errorReason: "rateLimitExceeded",
      },
      { status: 500, body: {}, reason: "upstream_error" },
      { status: 503, body: {}, reason: "upstream_error", code: "rate_limited" },
      { status: 418, body: {}, reason: "http_error" },
    ];
    for (const entry of cases) {
      const server = await serve(json(entry.status, entry.body));
      const adapter = new GoogleBooks(forward(server.base), {
        resolveKey: () => ({ state: "ok", key: "fake-key" }),
        userAgent: USER_AGENT,
      });
      const failure = await failureOf(search(adapter, { isbn: "9780132350884" }));
      expect(failure, `status ${entry.status}`).toMatchObject({
        code: entry.code ?? "unavailable",
        reason: entry.reason,
        status: entry.status,
        ...(entry.errorStatus === undefined ? {} : { errorStatus: entry.errorStatus }),
        ...(entry.errorReason === undefined ? {} : { errorReason: entry.errorReason }),
      });
    }
  });

  it("drops provider error identifiers outside the closed allowlist", async () => {
    for (const status of [400, 403]) {
      const server = await serve(json(status, googleError(status, "SENTINEL_API_KEY", "SENTINEL_QUERY")));
      const adapter = new GoogleBooks(forward(server.base), {
        resolveKey: () => ({ state: "ok", key: "SENTINEL_API_KEY" }),
        userAgent: USER_AGENT,
      });
      const failure = await failureOf(search(adapter, { isbn: "9780132350884" }));
      expect(failure, `status ${status}`).toMatchObject({
        code: "unavailable",
        reason: status === 400 ? "http_error" : "forbidden",
        status,
      });
      expect(failure.errorStatus, `status ${status}`).toBeUndefined();
      expect(failure.errorReason, `status ${status}`).toBeUndefined();

      const lookup = new MetadataLookup([adapter], new MetadataCache(), { enabled: true });
      const captured = capture();
      const result = await lookup.search({ isbn: "9780132350884" }, captured.log);
      expect(result.errors, `status ${status}`).toEqual([
        { source: "googlebooks", code: "unavailable", reason: status === 400 ? "http_error" : "forbidden" },
      ]);
      expect(captured.warns, `status ${status}`).toHaveLength(1);
      expect(captured.warns.join(" "), `status ${status}`).not.toContain("SENTINEL");
    }
  });

  it("classifies invalid JSON, oversized bodies and non-Google statuses as bad_response/http", async () => {
    const broken = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
    });
    const brokenAdapter = new GoogleBooks(forward(broken.base), {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    await expect(search(brokenAdapter, { isbn: "9780132350884" }))
      .rejects.toMatchObject({ code: "unavailable", reason: "bad_response", status: 200 });

    const huge = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(1024 * 1024 + 1));
    });
    const hugeAdapter = new GoogleBooks(forward(huge.base), {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    await expect(search(hugeAdapter, { isbn: "9780132350884" }))
      .rejects.toMatchObject({ reason: "bad_response", status: 200 });

    const openLibrary = await serve(json(403, { error: "nope" }));
    const ol = new OpenLibrary(forward(openLibrary.base), { userAgent: USER_AGENT });
    await expect(search(ol, { isbn: "9780132350884" }))
      .rejects.toMatchObject({ code: "unavailable", reason: "forbidden", status: 403 });
  });

  it("maps body read aborts and transport failures instead of bad_response or HTTP status", async () => {
    const cases = [
      ["googlebooks", 200],
      ["googlebooks", 403],
      ["googlebooks", 503],
      ["openlibrary", 200],
      ["openlibrary", 403],
      ["openlibrary", 503],
    ] as const;

    for (const [kind, status] of cases) {
      const aborter = new AbortController();
      const aborting = failingBody(status, "abort", () => aborter.abort());
      const abortAdapter = kind === "googlebooks"
        ? new GoogleBooks(async () => aborting, {
          resolveKey: () => ({ state: "none" }),
          userAgent: USER_AGENT,
        })
        : new OpenLibrary(async () => aborting, { userAgent: USER_AGENT });
      const aborted = await failureOf(abortAdapter.search({ isbn: "9780132350884" }, aborter.signal));
      expect(aborted, `${kind} ${status} abort`).toMatchObject({ code: "timeout", reason: "timeout" });

      const network = failingBody(status, "network", () => {});
      const networkAdapter = kind === "googlebooks"
        ? new GoogleBooks(async () => network, {
          resolveKey: () => ({ state: "none" }),
          userAgent: USER_AGENT,
        })
        : new OpenLibrary(async () => network, { userAgent: USER_AGENT });
      const failed = await failureOf(networkAdapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(2_000)));
      expect(failed, `${kind} ${status} network`).toMatchObject({
        code: "unavailable",
        reason: "network",
        networkCode: "ECONNRESET",
      });
    }
  });

  it("cancels an oversized Google error body and classifies by status only", async () => {
    let closed = false;
    const server = await serve((_req, res) => {
      res.writeHead(403, { "content-type": "application/json", "content-length": String(65 * 1024) });
      res.write("{\"error\":{\"status\":\"PERMISSION_DENIED\"");
      res.on("close", () => { closed = true; });
      // Never finishes the declared 65 KB body.
    });
    const adapter = new GoogleBooks(forward(server.base), {
      resolveKey: () => ({ state: "ok", key: "fake-key" }),
      userAgent: USER_AGENT,
    });
    await expect(search(adapter, { isbn: "9780132350884" }))
      .rejects.toMatchObject({ reason: "forbidden", status: 403 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
  });

  it("classifies timeouts, connection refusals and DNS failures", async () => {
    const silent = await serve(() => { /* never answers */ });
    const timeoutAdapter = new GoogleBooks(forward(silent.base), {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    await expect(timeoutAdapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(60)))
      .rejects.toMatchObject({ code: "timeout", reason: "timeout" });

    const closed = await serve((_req, res) => res.end());
    const refusedPort = new URL(closed.base).port;
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);
    const refusedFetch: typeof globalThis.fetch = (_input, init) =>
      globalThis.fetch(`http://127.0.0.1:${refusedPort}/`, init);
    const refusedAdapter = new GoogleBooks(refusedFetch, {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    const refused = await failureOf(search(refusedAdapter, { isbn: "9780132350884" }));
    expect(refused).toMatchObject({ code: "unavailable", reason: "network", networkCode: "ECONNREFUSED" });

    const dnsFailure: typeof globalThis.fetch = async () => {
      // A real NXDOMAIN for the reserved .invalid TLD; no remote server is involved.
      await dnsLookup("metadata-diagnostics.invalid");
      throw new Error("unexpected DNS answer");
    };
    const dnsAdapter = new GoogleBooks(dnsFailure, {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    const dns = await failureOf(search(dnsAdapter, { isbn: "9780132350884" }));
    expect(dns).toMatchObject({ code: "unavailable", reason: "network", networkCode: "ENOTFOUND" });
  });

  it("classifies GuardedFetch blocks and preserves the raw cause code", () => {
    expect(providerFailure(new GuardedFetchError("blocked", "private"))).toMatchObject({
      code: "unavailable",
      reason: "blocked_destination",
      networkCode: "private",
    });
    expect(providerFailure(new GuardedFetchError("https_required"))).toMatchObject({
      reason: "blocked_destination",
      networkCode: "https_required",
    });
    expect(providerFailure(new GuardedFetchError("unreachable", "ENOTFOUND"))).toMatchObject({
      reason: "network",
      networkCode: "ENOTFOUND",
    });
    expect(providerFailure(new GuardedFetchError("timeout"))).toMatchObject({
      code: "timeout",
      reason: "timeout",
    });
  });

  it("fails closed on an unreadable stored key without calling the provider", async () => {
    let calls = 0;
    const adapter = new GoogleBooks((async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof globalThis.fetch, {
      resolveKey: () => ({ state: "unreadable" }),
      userAgent: USER_AGENT,
    });
    await expect(search(adapter, { isbn: "9780132350884" }))
      .rejects.toMatchObject({ code: "unavailable", reason: "key_unreadable" });
    expect(calls).toBe(0);
  });

  it("parses a real-shaped Google 200 response and sends the key only in the header", async () => {
    const server = await serve(json(200, {
      kind: "books#volumes",
      totalItems: 1,
      items: [{
        kind: "books#volume",
        id: "zyTCAlFPjgYC",
        volumeInfo: {
          title: "Clean Code",
          authors: ["Robert C. Martin"],
          publisher: "Prentice Hall",
          publishedDate: "2008-08-01",
          description: "<p>A handbook of agile software craftsmanship.</p>",
          industryIdentifiers: [
            { type: "ISBN_13", identifier: "9780132350884" },
            { type: "ISBN_10", identifier: "0132350882" },
          ],
          imageLinks: { thumbnail: "http://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover" },
          language: "en",
          infoLink: "http://books.google.com/books?id=zyTCAlFPjgYC",
        },
      }],
    }));
    const adapter = new GoogleBooks(forward(server.base), {
      resolveKey: () => ({ state: "ok", key: "header-key-sentinel" }),
      userAgent: USER_AGENT,
    });
    const candidates = await search(adapter, { isbn: "9780132350884" });
    expect(candidates[0]).toMatchObject({
      source: "googlebooks",
      id: "zyTCAlFPjgYC",
      title: "Clean Code",
      isbn13: "9780132350884",
      isbn10: "0132350882",
      coverUrl: "https://books.google.com/books/content?id=zyTCAlFPjgYC&printsec=frontcover",
    });
    const request = server.requests[0]!;
    expect(request.headers["x-goog-api-key"]).toBe("header-key-sentinel");
    expect(request.headers["user-agent"]).toBe(USER_AGENT);
    expect(request.url).not.toContain("header-key-sentinel");
    expect(request.url).not.toContain("key=");
    expect(request.url).toContain("/books/v1/volumes?q=isbn%3A9780132350884");
  });

  it("classifies statuses without a body through the stable enum", () => {
    expect(classifyHttpStatus(400)).toBe("http_error");
    expect(classifyHttpStatus(401)).toBe("key_rejected");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(404)).toBe("not_found");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(503)).toBe("upstream_error");
  });
});

describe("metadata failure log and additive response", () => {
  it("logs one safe warn line per failed provider and never the key, query or provider message", async () => {
    const key = "google-key-SENTINEL";
    const isbn = "9780132350884";
    const providerMessage = `boom ${key} ${isbn} https://www.googleapis.com/books?q=${isbn}&key=${key}`;
    const ol = await serve(json(403, { error: providerMessage }));
    const google = await serve(json(400, {
      error: {
        code: 400,
        message: providerMessage,
        errors: [{ message: providerMessage, domain: "global", reason: "badRequest" }],
        status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
      },
    }));
    const providers: MetadataProvider[] = [
      new OpenLibrary(forward(ol.base), { userAgent: USER_AGENT }),
      new GoogleBooks(forward(google.base), { resolveKey: () => ({ state: "ok", key }), userAgent: USER_AGENT }),
    ];
    const lookup = new MetadataLookup(providers, new MetadataCache(), { enabled: true });
    const captured = capture();
    const result = await lookup.search({ isbn }, captured.log);

    expect(result.candidates).toEqual([]);
    expect(result.errors).toEqual([
      { source: "openlibrary", code: "unavailable", reason: "forbidden" },
      { source: "googlebooks", code: "unavailable", reason: "key_rejected" },
    ]);
    expect(captured.warns).toHaveLength(2);
    expect(captured.warns[0]).toBe("metadata lookup failed provider=openlibrary reason=forbidden status=403");
    expect(captured.warns[1]).toBe(
      "metadata lookup failed provider=googlebooks reason=key_rejected status=400 "
      + "errorStatus=INVALID_ARGUMENT errorReason=API_KEY_INVALID",
    );
    const output = `${captured.warns.join("\n")} ${JSON.stringify(result)}`;
    expect(output).not.toContain(key);
    expect(output).not.toContain(isbn);
    expect(output).not.toContain("provider message");
    expect(output).not.toContain("boom");
    expect(output).not.toContain("https://");
  });

  it("does not log a successful provider or a cached result", async () => {
    const server = await serve(json(200, {
      items: [{ id: "g1", volumeInfo: { title: "Clean Code", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780132350884" }] } }],
    }));
    const adapter = new GoogleBooks(forward(server.base), {
      resolveKey: () => ({ state: "none" }),
      userAgent: USER_AGENT,
    });
    const lookup = new MetadataLookup([adapter], new MetadataCache(), { enabled: true });
    const captured = capture();
    await lookup.search({ isbn: "9780132350884" }, captured.log);
    await lookup.search({ isbn: "9780132350884" }, captured.log);
    expect(captured.warns).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("includes the reason for a provider error thrown without details", async () => {
    const lookup = new MetadataLookup(
      [{
        id: "googlebooks",
        keyConfigured: false,
        search: async () => { throw new MetadataProviderError("rate_limited"); },
      }],
      new MetadataCache(),
      { enabled: true },
    );
    const captured = capture();
    const result = await lookup.search({ isbn: "9780132350884" }, captured.log);
    expect(result.errors).toEqual([{ source: "googlebooks", code: "rate_limited", reason: "rate_limited" }]);
    expect(captured.warns).toEqual(["metadata lookup failed provider=googlebooks reason=rate_limited"]);
  });

  it("never logs hostile provider identifiers injected by an adapter", async () => {
    const lookup = new MetadataLookup(
      [{
        id: "googlebooks",
        keyConfigured: false,
        search: async () => {
          throw {
            code: "unavailable",
            reason: "network",
            status: 400,
            errorStatus: "SENTINEL_API_KEY",
            errorReason: "SENTINEL_QUERY",
          };
        },
      }],
      new MetadataCache(),
      { enabled: true },
    );
    const captured = capture();
    const result = await lookup.search({ isbn: "9780132350884" }, captured.log);
    expect(result.errors).toEqual([{ source: "googlebooks", code: "unavailable", reason: "network" }]);
    expect(captured.warns).toEqual(["metadata lookup failed provider=googlebooks reason=network status=400"]);
    expect(captured.warns.join(" ")).not.toContain("SENTINEL");
  });

  it("returns the additive reason from the HTTP route without changing source or code", async () => {
    const lookup = new MetadataLookup(
      [{
        id: "googlebooks",
        keyConfigured: false,
        search: async () => {
          throw new MetadataProviderError("unavailable", {
            reason: "service_disabled",
            status: 403,
            errorStatus: "PERMISSION_DENIED",
            errorReason: "SERVICE_DISABLED",
          });
        },
      }],
      new MetadataCache(),
      { enabled: true },
    );
    const app = Fastify();
    await app.register(metadataRoutes, {
      lookup,
      bookMetadata: {} as never,
      library: {} as never,
      progress: {} as never,
      indexing: {} as never,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/metadata/search?isbn=9780132350884" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        candidates: [],
        errors: [{ source: "googlebooks", code: "unavailable", reason: "service_disabled" }],
      });
    } finally {
      await app.close();
    }
  });
});

describe("debug outbound events", () => {
  const loggerFor = (debug: string[]): Logger => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: (message: string) => debug.push(message),
  });

  it("never logs a caller-controlled hostname", () => {
    expect(outboundTarget("https://SENTINEL_HOST.example/SENTINEL_PATH")).toEqual({
      host: "external",
      method: "GET",
    });
    expect(outboundTarget("https://SENTINEL_TOKEN.archive.org/cover.jpg")).toMatchObject({
      host: "archive.org",
    });
    expect(outboundTarget("https://www.googleapis.com/books/v1/volumes")).toMatchObject({
      host: "www.googleapis.com",
    });
    expect(safeAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(safeAddress("SENTINEL_HOST")).toBe("unknown");

    const debug: string[] = [];
    logOutbound(loggerFor(debug), {
      provider: "rss",
      host: "SENTINEL_HOST.example",
      method: "GET",
      durationMs: 1,
    });
    expect(debug).toEqual(["http outbound provider=rss method=GET host=external durationMs=1"]);
    expect(debug.join("\n")).not.toContain("SENTINEL_HOST");
  });

  it("never logs an arbitrary URL pathname or its sentinel", () => {
    const target = outboundTarget("https://archive.org/SENTINEL_SECRET_COVER?token=SECRET");
    expect(target).toEqual({ host: "archive.org", method: "GET" });

    const debug: string[] = [];
    logOutbound(loggerFor(debug), {
      provider: "cover",
      ...target,
      status: 200,
      durationMs: 1,
    });
    logOutbound(loggerFor(debug), {
      provider: "cover",
      host: "archive.org",
      path: "/SENTINEL_SECRET_COVER",
      method: "GET",
      status: 200,
      durationMs: 1,
    });

    expect(debug).toEqual([
      "http outbound provider=cover method=GET host=archive.org status=200 durationMs=1",
      "http outbound provider=cover method=GET host=archive.org status=200 durationMs=1",
    ]);
    expect(debug.join("\n")).not.toContain("SENTINEL_SECRET_COVER");
    expect(debug.join("\n")).not.toContain("token=SECRET");
  });

  it("emits one debug line for a successful metadata exchange without the query", async () => {
    const server = await serve(json(200, { items: [] }));
    const debug: string[] = [];
    const adapter = new GoogleBooks(
      observedFetch(forward(server.base), "googlebooks", loggerFor(debug)),
      { resolveKey: () => ({ state: "none" }), userAgent: USER_AGENT },
    );
    await search(adapter, { isbn: "9780132350884" });
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatch(/^http outbound provider=googlebooks method=GET host=www\.googleapis\.com path=\/books\/v1\/volumes status=200 durationMs=\d+( bytes=\d+)?$/u);
    expect(debug[0]).not.toContain("9780132350884");
    expect(debug[0]).not.toContain("?");
  });

  it("emits a debug line for a fake Google 403 before the warn classification", async () => {
    const server = await serve(json(403, googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED")));
    const debug: string[] = [];
    const adapter = new GoogleBooks(
      observedFetch(forward(server.base), "googlebooks", loggerFor(debug)),
      { resolveKey: () => ({ state: "ok", key: "k" }), userAgent: USER_AGENT },
    );
    await failureOf(search(adapter, { isbn: "9780132350884" }));
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain("provider=googlebooks");
    expect(debug[0]).toContain("status=403");
    expect(debug[0]).toContain("path=/books/v1/volumes");
  });

  it("logs the GuardedFetch destination and never the private IP", async () => {
    const server = await serve((_req, res) => res.end("ok"));
    const debug: string[] = [];
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      debug: { provider: "cover", log: loggerFor(debug) },
    });
    const response = await guarded(`${server.base}/SENTINEL_SECRET_COVER?isbn=9780132350884`);
    await response.body?.cancel();
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatch(/^http outbound provider=cover method=GET host=127\.0\.0\.1 status=200 durationMs=\d+ bytes=2 destination=loopback$/u);
    expect(debug[0]).not.toContain("path=");
    expect(debug[0]).not.toContain("SENTINEL_SECRET_COVER");
    expect(debug[0]).not.toContain("ip=");
    expect(debug[0]).not.toContain("isbn");
  });

  it("logs a blocked destination by category only", async () => {
    const debug: string[] = [];
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      debug: { provider: "cover", log: loggerFor(debug) },
    });
    await guarded("http://127.0.0.1:9/cover.jpg").catch(() => undefined);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain("provider=cover");
    expect(debug[0]).toContain("status=0");
    expect(debug[0]).toContain("destination=loopback");
    expect(debug[0]).toContain("reason=blocked_destination");
    expect(debug[0]).not.toContain("ip=");
  });

  it("logs transport failures with the Node code and no message", async () => {
    const debug: string[] = [];
    const failing: typeof globalThis.fetch = async () => {
      throw Object.assign(new Error("secret path /home/user/book.epub"), { code: "ECONNRESET" });
    };
    const observed = observedFetch(failing, "rss", loggerFor(debug));
    await observed("https://SENTINEL_RSS_HOST.example/SENTINEL_RSS_PATH?q=secret").catch(() => undefined);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain("provider=rss");
    expect(debug[0]).toContain("host=external");
    expect(debug[0]).toContain("reason=network");
    expect(debug[0]).toContain("networkCode=ECONNRESET");
    expect(debug[0]).not.toContain("path=");
    expect(debug[0]).not.toContain("SENTINEL_RSS_HOST");
    expect(debug[0]).not.toContain("SENTINEL_RSS_PATH");
    expect(debug[0]).not.toContain("secret");
    expect(debug[0]).not.toContain("book.epub");
  });

  it("logs an RSS exchange with the destination and without the query string", async () => {
    const debug: string[] = [];
    const xml = '<rss version="2.0"><channel><title>News</title></channel></rss>';
    const source = new SafeRssSource(
      async () => [{ address: "8.8.8.8", family: 4 }],
      async () => xml,
      loggerFor(debug),
    );
    const feed = { id: "f", kind: "custom" as const, title: "Feed", url: "https://feeds.example/rss", enabled: true, createdAt: 1 };
    await source.load("https://SENTINEL_RSS_HOST.example/SENTINEL_RSS_PATH?topic=RSS-QUERY-SENTINEL", feed);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toContain("provider=rss");
    expect(debug[0]).toContain("host=external");
    expect(debug[0]).toContain("status=200");
    expect(debug[0]).toContain("destination=public");
    expect(debug[0]).toContain("ip=8.8.8.8");
    expect(debug[0]).not.toContain("path=");
    expect(debug[0]).not.toContain("SENTINEL_RSS_HOST");
    expect(debug[0]).not.toContain("SENTINEL_RSS_PATH");
    expect(debug[0]).not.toContain("RSS-QUERY-SENTINEL");
  });
});
