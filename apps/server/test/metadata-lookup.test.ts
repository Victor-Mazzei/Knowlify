import { describe, expect, it, vi } from "vitest";
import { MetadataCache } from "../src/adapters/metadata/MetadataCache.js";
import { GoogleBooks } from "../src/adapters/metadata/GoogleBooks.js";
import { OpenLibrary } from "../src/adapters/metadata/OpenLibrary.js";
import { MetadataProviderError } from "../src/adapters/metadata/httpJson.js";
import { htmlText } from "../src/adapters/metadata/htmlText.js";
import { MetadataDisabledError } from "../src/domain/library/BookMetadata.js";
import { MetadataLookup, MetadataRateLimitError } from "../src/use-cases/MetadataLookup.js";
import type { MetadataCandidate, MetadataProvider } from "../src/ports/library-metadata.js";

const candidate = (values: Partial<MetadataCandidate> = {}): MetadataCandidate => ({
  source: "googlebooks",
  id: "id",
  title: "Title",
  authors: ["Author"],
  description: null,
  isbn10: null,
  isbn13: null,
  publisher: null,
  year: null,
  language: null,
  coverUrl: null,
  link: null,
  ...values,
});

const provider = (id: "googlebooks" | "openlibrary", run: MetadataProvider["search"], keyConfigured = false): MetadataProvider => ({
  id,
  keyConfigured,
  search: vi.fn(run),
});

function jsonResponse(body: unknown, init: { status?: number; type?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "application/json" },
  });
}

describe("MetadataLookup use case", () => {
  it("reports provider availability without ever exposing the key", () => {
    const lookup = new MetadataLookup(
      [provider("googlebooks", async () => [], true), provider("openlibrary", async () => [], false)],
      new MetadataCache(),
      { enabled: true },
    );
    expect(lookup.status()).toEqual({
      enabled: true,
      providers: [{ id: "googlebooks", keyConfigured: true }, { id: "openlibrary", keyConfigured: false }],
    });
  });

  it("keeps the successful provider when the other fails and returns stable codes", async () => {
    const lookup = new MetadataLookup(
      [
        provider("googlebooks", async () => { throw new MetadataProviderError("rate_limited"); }),
        provider("openlibrary", async () => [candidate({ source: "openlibrary", id: "OL1W" })]),
      ],
      new MetadataCache(),
      { enabled: true },
    );
    const result = await lookup.search({ isbn: "9780132350884" });
    expect(result.candidates).toEqual([candidate({ source: "openlibrary", id: "OL1W" })]);
    expect(result.errors).toEqual([{ source: "googlebooks", code: "rate_limited", reason: "rate_limited" }]);
  });

  it("maps unknown and aborted failures without leaking details", async () => {
    const lookup = new MetadataLookup(
      [
        provider("googlebooks", async () => { throw new Error("secret https://provider.example/?key=abc"); }),
        provider("openlibrary", async (_query, signal) => {
          void signal;
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        }),
      ],
      new MetadataCache(),
      { enabled: true },
    );
    const result = await lookup.search({ title: "Clean Code" });
    expect(result.errors).toEqual([
      { source: "googlebooks", code: "unavailable", reason: "network" },
      { source: "openlibrary", code: "timeout", reason: "timeout" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("caches each provider for 10 minutes and evicts the oldest entry", async () => {
    let now = 0;
    const cache = new MetadataCache(600_000, 2, () => now);
    const search = vi.fn(async () => [candidate({ isbn13: "9780132350884" })]);
    const lookup = new MetadataLookup([provider("googlebooks", search)], cache, { enabled: true, now: () => now });
    await lookup.search({ isbn: "9780132350884" });
    await lookup.search({ isbn: "9780132350884" });
    expect(search).toHaveBeenCalledTimes(1);

    now = 600_001;
    await lookup.search({ isbn: "9780132350884" });
    expect(search).toHaveBeenCalledTimes(2);

    await lookup.search({ title: "A" });
    await lookup.search({ title: "B" });
    expect(cache.size).toBe(2);
    await lookup.search({ isbn: "9780132350884" });
    expect(search).toHaveBeenCalledTimes(5);
  });

  it("rate limits valid lookups at 12/min with Retry-After data", async () => {
    let now = 1_000;
    const lookup = new MetadataLookup([provider("googlebooks", async () => [])], new MetadataCache(), {
      enabled: true,
      now: () => now,
    });
    for (let index = 0; index < 12; index += 1) await lookup.search({ title: `Title ${index}` });
    const error = await lookup.search({ title: "Too many" }).then(
      () => { throw new Error("expected a rate limit"); },
      (failure: unknown) => failure as MetadataRateLimitError,
    );
    expect(error).toBeInstanceOf(MetadataRateLimitError);
    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(60);
    now += 60_000;
    await expect(lookup.search({ title: "Again" })).resolves.toBeDefined();
  });

  it("uses the first provider by default and does not ask the fallback", async () => {
    const fallback = vi.fn(async () => [candidate({ source: "googlebooks", id: "g" })]);
    const lookup = new MetadataLookup(
      [
        provider("openlibrary", async () => [
          candidate({ source: "openlibrary", id: "ol-2", title: "No ISBN" }),
          candidate({ source: "openlibrary", id: "ol", isbn13: "9780132350884", title: "Open", description: "rich" }),
          candidate({ source: "openlibrary", id: "ol-dup", isbn13: "9780132350884", title: "Open" }),
        ]),
        provider("googlebooks", fallback),
      ],
      new MetadataCache(),
      { enabled: true },
    );
    const result = await lookup.search({ isbn: "9780132350884" });
    expect(result.candidates.map((entry) => entry.id)).toEqual(["ol", "ol-2"]);
    expect(result.errors).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to the next provider when the first finds nothing or fails", async () => {
    const empty = new MetadataLookup(
      [
        provider("openlibrary", async () => []),
        provider("googlebooks", async () => [candidate({ source: "googlebooks", id: "g" })]),
      ],
      new MetadataCache(),
      { enabled: true },
    );
    expect((await empty.search({ title: "Rare" })).candidates.map((entry) => entry.id)).toEqual(["g"]);

    const failing = new MetadataLookup(
      [
        provider("openlibrary", async () => { throw new MetadataProviderError("timeout"); }),
        provider("googlebooks", async () => [candidate({ source: "googlebooks", id: "g" })]),
      ],
      new MetadataCache(),
      { enabled: true },
    );
    const result = await failing.search({ title: "Rare" });
    expect(result.candidates.map((entry) => entry.id)).toEqual(["g"]);
    expect(result.errors).toEqual([{ source: "openlibrary", code: "timeout", reason: "timeout" }]);
  });

  it("validates the query and the feature switch before calling a provider", async () => {
    const search = vi.fn(async () => []);
    const disabled = new MetadataLookup([provider("googlebooks", search)], new MetadataCache(), { enabled: false });
    await expect(disabled.search({ isbn: "9780132350884" })).rejects.toBeInstanceOf(MetadataDisabledError);
    expect(search).not.toHaveBeenCalled();

    const enabled = new MetadataLookup([provider("googlebooks", search)], new MetadataCache(), { enabled: true });
    await expect(enabled.search({ isbn: "0132350884" })).rejects.toMatchObject({ details: { field: "isbn" } });
    await expect(enabled.search({ isbn: "9780132350884", title: "x" })).rejects.toMatchObject({ details: { field: "query" } });
    expect(search).not.toHaveBeenCalled();
  });
});

describe("provider adapters", () => {
  it("Google Books builds the documented query, sanitizes fields and allowlists links", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      items: [{
        id: "g1",
        volumeInfo: {
          title: "<b>Clean</b> Code",
          authors: ["Robert C. Martin", "<script>alert(1)</script>"],
          description: "<p>First</p><script>bad()</script><p>Second &amp; last</p>",
          industryIdentifiers: [
            { type: "ISBN_13", identifier: "978-0-13-235088-4" },
            { type: "ISBN_10", identifier: "0-13-235088-2" },
            { type: "ISBN_13", identifier: "9780132350885" },
          ],
          publisher: "Prentice Hall",
          publishedDate: "2008-08-01",
          language: "EN-us",
          imageLinks: { thumbnail: "http://books.google.com/books/content?id=g1&printsec=frontcover" },
          infoLink: "http://books.google.com/books?id=g1",
        },
      }, {
        id: "evil",
        volumeInfo: {
          title: "Evil",
          imageLinks: { thumbnail: "https://evil.example/cover.jpg" },
          infoLink: "https://evil.example/book",
        },
      }],
    }));
    const adapter = new GoogleBooks(fetch as unknown as typeof globalThis.fetch, {
      resolveKey: () => ({ state: "ok", key: "secret-key" }),
      userAgent: "Knowlify/1.0.0",
    });
    const result = await adapter.search({ title: "Clean Code", author: "Martin" }, AbortSignal.timeout(1_000));
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toBe("/books/v1/volumes");
    expect(url.searchParams.get("q")).toBe('intitle:"Clean Code" inauthor:"Martin"');
    expect(url.searchParams.get("maxResults")).toBe("8");
    expect(url.searchParams.get("printType")).toBe("books");
    expect(url.searchParams.get("key")).toBeNull();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe("secret-key");
    expect(result[0]).toEqual({
      source: "googlebooks",
      id: "g1",
      title: "Clean Code",
      authors: ["Robert C. Martin"],
      description: "First\nSecond & last",
      isbn10: "0132350882",
      isbn13: "9780132350884",
      publisher: "Prentice Hall",
      year: 2008,
      language: "en-us",
      coverUrl: "https://books.google.com/books/content?id=g1&printsec=frontcover",
      link: "https://books.google.com/books?id=g1",
    });
    expect(result[1]).toMatchObject({ id: "evil", coverUrl: null, link: null });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("Google Books maps 429, malformed JSON and oversized responses to stable errors", async () => {
    const noKey = () => ({ state: "none" } as const);
    const rate = new GoogleBooks(async () => jsonResponse({}, { status: 429 }) as Response, { resolveKey: noKey, userAgent: "Knowlify/1" });
    await expect(rate.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "rate_limited" });
    const broken = new GoogleBooks(async () => new Response("not json", { status: 200 }), { resolveKey: noKey, userAgent: "Knowlify/1" });
    await expect(broken.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "unavailable" });
    const huge = new GoogleBooks(async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }), { resolveKey: noKey, userAgent: "Knowlify/1" });
    await expect(huge.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("Google Books resolves the key per request, sends it only in the header and fails closed when unreadable", async () => {
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init ?? {});
      return jsonResponse({ items: [] });
    });
    let resolution: { state: "none" } | { state: "ok"; key: string } | { state: "unreadable" } = { state: "none" };
    const adapter = new GoogleBooks(fetch as unknown as typeof globalThis.fetch, {
      resolveKey: () => resolution,
      userAgent: "Knowlify/1",
    });

    await adapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000));
    expect(new Headers(requests[0]?.headers).get("x-goog-api-key")).toBeNull();

    resolution = { state: "ok", key: "rotated-key-sentinel" };
    await adapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000));
    expect(adapter.keyConfigured).toBe(true);
    expect(new Headers(requests[1]?.headers).get("x-goog-api-key")).toBe("rotated-key-sentinel");
    for (const [url] of fetch.mock.calls) {
      expect(String(url)).not.toContain("rotated-key-sentinel");
      expect(String(url)).not.toContain("key=");
    }

    // The third call must not reach the provider: an unreadable envelope never falls
    // back to an unauthenticated request and never surfaces the sealed value.
    resolution = { state: "unreadable" };
    expect(adapter.keyConfigured).toBe(false);
    const failure = await adapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000))
      .then(() => { throw new Error("expected the adapter to fail closed"); }, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain("rotated-key-sentinel");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Google Books never leaks the key through a transport error", async () => {
    const key = "transport-error-key-sentinel";
    const adapter = new GoogleBooks(async () => {
      throw new Error(`the request to www.googleapis.com failed with ${key}`);
    }, { resolveKey: () => ({ state: "ok", key }), userAgent: "Knowlify/1" });
    const failure = await adapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000))
      .then(() => { throw new Error("expected the provider to fail"); }, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(key);
  });

  it("Open Library uses isbn/title parameters, builds covers and keeps only safe links", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      docs: [{
        key: "/works/OL17618370W",
        title: "Clean Code",
        author_name: ["Robert C. Martin"],
        first_publish_year: 2008,
        isbn: ["0-13-235088-2", "978-0-13-235088-4"],
        publisher: ["Prentice Hall", "Pearson"],
        language: ["eng", "en"],
        cover_i: 8065615,
      }, {
        key: "javascript:alert(1)",
        title: "Bad key",
      }],
    }));
    const adapter = new OpenLibrary(fetch as unknown as typeof globalThis.fetch, { userAgent: "Knowlify/1.0.0" });
    const result = await adapter.search({ title: "Clean Code", author: "Martin" }, AbortSignal.timeout(1_000));
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://openlibrary.org");
    expect(url.searchParams.get("title")).toBe("Clean Code");
    expect(url.searchParams.get("author")).toBe("Martin");
    expect(url.searchParams.get("limit")).toBe("8");
    expect(result[0]).toEqual({
      source: "openlibrary",
      id: "/works/OL17618370W",
      title: "Clean Code",
      authors: ["Robert C. Martin"],
      description: null,
      isbn10: "0132350882",
      isbn13: "9780132350884",
      publisher: "Prentice Hall",
      year: 2008,
      language: "eng",
      coverUrl: "https://covers.openlibrary.org/b/id/8065615-L.jpg?default=false",
      link: "https://openlibrary.org/works/OL17618370W",
    });
    expect(result[1]).toMatchObject({ id: "javascript:alert(1)", link: null });

    await adapter.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000));
    const isbnUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(isbnUrl.searchParams.get("isbn")).toBe("9780132350884");
    expect(isbnUrl.searchParams.get("title")).toBeNull();
  });

  it("Open Library reports quota/errors with the same codes", async () => {
    const rate = new OpenLibrary(async () => new Response("", { status: 429 }), { userAgent: "Knowlify/1" });
    await expect(rate.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "rate_limited" });
    const timeout = new OpenLibrary(async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }, { userAgent: "Knowlify/1" });
    await expect(timeout.search({ isbn: "9780132350884" }, AbortSignal.timeout(1_000)))
      .rejects.toMatchObject({ code: "timeout" });
  });
});

describe("htmlText sanitization", () => {
  it("removes scripts/styles/tags, decodes entities and enforces limits", () => {
    expect(htmlText("<p>A &amp; B</p><script>x()</script><style>p{}</style>", 100)).toBe("A & B");
    expect(htmlText("one<br>two", 100, true)).toBe("one\ntwo");
    expect(htmlText("<p>one</p><p>two</p>", 100, true)).toBe("one\ntwo");
    expect(htmlText("a&#10;b&#x41;", 100)).toBe("a bA");
    expect(htmlText("bad\u0007text", 100)).toBe("bad text");
    expect(htmlText("x".repeat(300), 10)).toHaveLength(10);
    expect(htmlText("   ", 10)).toBeNull();
    expect(htmlText(42, 10)).toBeNull();
    expect(htmlText("a\n\n\n\nb", 100, true)).toBe("a\n\nb");
  });
});
