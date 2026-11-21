import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createGuardedFetch, GuardedFetchError } from "../src/adapters/llm/GuardedFetch.js";
import { assertAllowedCoverUrl, CoverDownloader, CoverFetchError } from "../src/adapters/metadata/CoverDownloader.js";
import type { HostLookup } from "../src/ports/llm-settings.js";

const image = (bytes = 32): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(bytes, 1)]);

const response = (body: Uint8Array | string | null, init: ResponseInit): Response =>
  new Response(body as unknown as BodyInit, init);

const downloader = (fetch: typeof globalThis.fetch, options: { timeoutMs?: number; maxBytes?: number } = {}) =>
  new CoverDownloader({ fetch, userAgent: "Knowlify/test", ...options });

async function errorOf(promise: Promise<unknown>): Promise<CoverFetchError> {
  return promise.then(
    () => { throw new Error("expected the cover download to fail"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CoverFetchError);
      return error as CoverFetchError;
    },
  );
}

const allow = (url: string): void => { expect(() => assertAllowedCoverUrl(url)).not.toThrow(); };
const deny = (url: string): void => { expect(() => assertAllowedCoverUrl(url)).toThrow(CoverFetchError); };

describe("cover URL policy", () => {
  it("accepts only HTTPS/443 on allowlisted provider hosts", () => {
    allow("https://books.google.com/books/content?id=x");
    allow("https://books.googleusercontent.com/books/content?id=x");
    allow("https://covers.openlibrary.org/b/id/1-L.jpg?default=false");
    allow("https://archive.org/download/olcovers/1.jpg");
    allow("https://ia800.us.archive.org/1.jpg");
    allow("https://covers.openlibrary.org:443/b/id/1-L.jpg");

    deny("http://covers.openlibrary.org/b/id/1-L.jpg");
    deny("https://covers.openlibrary.org:444/b/id/1-L.jpg");
    deny("https://user:pass@covers.openlibrary.org/b/id/1-L.jpg");
    deny("https://covers.openlibrary.org/b/id/1-L.jpg#fragment");
    deny("https://evil.example/cover.jpg");
    deny("https://covers.openlibrary.org.evil.example/cover.jpg");
    deny("https://evilarchive.org/cover.jpg");
    deny("https://127.0.0.1/cover.jpg");
    deny("https://169.254.169.254/latest/meta-data/");
    deny("https://[::1]/cover.jpg");
    deny("ftp://covers.openlibrary.org/cover.jpg");
    deny("not a url");
  });

  it("revalidates every redirect hop against the same allowlist", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://covers.openlibrary.org/")) {
        return response(null, { status: 302, headers: { location: "https://evil.example/cover.jpg" } });
      }
      return response(image(), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const error = await errorOf(downloader(fetch as unknown as typeof globalThis.fetch)
      .fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(error.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows at most three allowlisted redirects and resolves relative locations", async () => {
    const fetch = vi.fn(async (url: string) => {
      const hop = Number(new URL(url).searchParams.get("hop") ?? 0);
      if (hop < 3) {
        const next = new URL(String(fetch.mock.calls.at(-1)?.[0]));
        next.searchParams.set("hop", String(hop + 1));
        return response(null, { status: 302, headers: { location: next.pathname + next.search } });
      }
      return response(image(), { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const body = await downloader(fetch as unknown as typeof globalThis.fetch)
      .fetch("https://covers.openlibrary.org/b/id/1-L.jpg?hop=0");
    expect(body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(fetch).toHaveBeenCalledTimes(4);

    const loop = vi.fn(async () => response(null, {
      status: 302,
      headers: { location: "https://covers.openlibrary.org/again" },
    }));
    const tooMany = await errorOf(downloader(loop as unknown as typeof globalThis.fetch)
      .fetch("https://covers.openlibrary.org/start"));
    expect(tooMany.status).toBe(502);
    expect(tooMany.code).toBe("upstream_failed");
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("rejects oversized bodies by header and by streamed bytes", async () => {
    const declared = await errorOf(downloader(async () => response(image(), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(2 * 1024 * 1024 + 1) },
    })).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(declared.status).toBe(413);

    const streamed = await errorOf(downloader(async () => response(Buffer.alloc(2 * 1024 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(streamed.status).toBe(413);

    const configured = await errorOf(downloader(async () => response(image(100), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }), { maxBytes: 10 }).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(configured.status).toBe(413);
  });

  it("rejects a declared non-image, empty bodies and non-2xx responses", async () => {
    const html = await errorOf(downloader(async () => response("<html>x</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(html.status).toBe(415);

    const empty = await errorOf(downloader(async () => response(null, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(empty.status).toBe(415);

    for (const status of [404, 500, 304]) {
      const failure = await errorOf(downloader(async () => response("", {
        status,
        headers: { "content-type": "image/jpeg" },
      })).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
      expect(failure.status).toBe(502);
    }
  });

  it("maps transport failures and timeouts to a generic 502", async () => {
    const thrown = await errorOf(downloader(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND covers.openlibrary.org"), { code: "ENOTFOUND" });
    }).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(thrown.status).toBe(502);
    expect(thrown.message).not.toContain("openlibrary");

    const timeout = await errorOf(downloader(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }), { timeoutMs: 20 }).fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(timeout.status).toBe(502);
  });

  it("rejects a redirect whose allowlisted host resolves to a private address", async () => {
    let lookups = 0;
    const lookup: HostLookup = async (hostname) => {
      lookups += 1;
      if (hostname === "archive.org") return [{ address: "192.168.1.10", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const guarded = createGuardedFetch({ policy: { mode: "off" }, lookup });
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith("https://covers.openlibrary.org/")) {
        await init?.body;
        return response(null, { status: 302, headers: { location: "https://archive.org/download/olcovers/1.jpg" } });
      }
      return guarded(url, init);
    };
    const error = await errorOf(downloader(fetch as typeof globalThis.fetch)
      .fetch("https://covers.openlibrary.org/b/id/1-L.jpg"));
    expect(error.status).toBe(502);
    expect(error.code).toBe("upstream_failed");
    expect(lookups).toBe(1);
  });
});

describe("SSRF PoCs reused by the cover downloader", () => {
  const privateAnswers: Array<[string, { address: string; family: number }[]]> = [
    ["loopback", [{ address: "127.0.0.1", family: 4 }]],
    ["loopback IPv6", [{ address: "::1", family: 6 }]],
    ["private 10/8", [{ address: "10.0.0.8", family: 4 }]],
    ["private 172.16/12", [{ address: "172.20.0.1", family: 4 }]],
    ["private 192.168/16", [{ address: "192.168.1.10", family: 4 }]],
    ["link-local/metadata", [{ address: "169.254.169.254", family: 4 }]],
    ["reserved", [{ address: "0.0.0.0", family: 4 }]],
    ["mixed public and private", [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]],
  ];

  it.each(privateAnswers)("blocks a hostname resolving to %s before opening a socket", async (_label, addresses) => {
    let lookups = 0;
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: async () => { lookups += 1; return addresses; },
    });
    const error = await guarded("https://covers.openlibrary.org/b/id/1-L.jpg").then(
      () => { throw new Error("expected a blocked address"); },
      (failure: unknown) => failure as GuardedFetchError,
    );
    expect(error).toBeInstanceOf(GuardedFetchError);
    expect(error.code).toBe("blocked");
    expect(lookups).toBe(1);
  });

  it("blocks private, loopback and metadata IP literals without DNS", async () => {
    for (const url of [
      "https://127.0.0.1/x.jpg",
      "https://[::1]/x.jpg",
      "https://10.0.0.1/x.jpg",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      await expect(createGuardedFetch({ policy: { mode: "off" } })(url))
        .rejects.toMatchObject({ code: "blocked" });
    }
  });

  it("pins the first DNS answer: a second resolution cannot rebind a new connection", async () => {
    let lookups = 0;
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const guarded = createGuardedFetch({
        policy: { mode: "list", cidrs: ["127.0.0.1/32"] },
        lookup: async () => {
          lookups += 1;
          return lookups === 1
            ? [{ address: "127.0.0.1", family: 4 }]
            : [{ address: "10.0.0.1", family: 4 }];
        },
      });
      const response = await guarded(`http://rebind.test:${port}/`);
      expect(await response.text()).toBe("ok");
      await expect(guarded(`http://rebind.test:${port}/`)).rejects.toMatchObject({ code: "blocked" });
      expect(lookups).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
