import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGuardedFetch, GuardedFetchError } from "../src/adapters/llm/GuardedFetch.js";
import type { HostLookup, ResolvedAddress } from "../src/ports/llm-settings.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; port: number; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, server };
}

function lookup(addresses: ResolvedAddress[]): HostLookup {
  return async () => addresses;
}

async function errorOf(promise: Promise<unknown>): Promise<GuardedFetchError> {
  return promise.then(
    () => { throw new Error("expected the guarded fetch to fail"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GuardedFetchError);
      return error as GuardedFetchError;
    },
  );
}

describe("guarded fetch", () => {
  it("connects through the pinned private address when the policy allows it", async () => {
    let received: { method?: string; authorization?: string; body?: string } = {};
    const { url, port } = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = {
          method: req.method,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const response = await guarded(`http://localhost:${port}/v1/models`, {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received.method).toBe("POST");
    expect(received.authorization).toBe("Bearer key");
    expect(received.body).toBe('{"hello":"world"}');
    expect(url).toContain("127.0.0.1");
  });

  it("sends Unicode JSON bodies with a byte-accurate content length", async () => {
    const payload = {
      model: "unicode-model",
      messages: [{
        role: "user",
        content: "Pergunta: o que é “café”? 🚀 Ação, coração, maçã. 你好，世界.",
      }],
      excerpt: "Trecho com emoji 🧠📚 e acentuação — fim.",
    };
    const serialized = JSON.stringify(payload);
    let received: { body: string; contentLength: string | undefined; bytes: number } | undefined;
    const { port } = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        received = {
          body: raw.toString("utf8"),
          contentLength: req.headers["content-length"],
          bytes: raw.length,
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const response = await guarded(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialized,
    });
    expect(response.status).toBe(200);
    await response.json();
    expect(received).toBeDefined();
    expect(received?.contentLength).toBe(String(Buffer.byteLength(serialized, "utf8")));
    expect(received?.bytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(received?.body).toBe(serialized);
    expect(JSON.parse(received?.body ?? "")).toEqual(payload);
  });

  it("keeps abort armed after headers and closes a stalled body", async () => {
    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const { port } = await listen((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", () => {
        closed = true;
        resolveClosed();
      });
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const controller = new AbortController();
    const response = await guarded(`http://localhost:${port}/stall`, { signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected a response body");
    const first = await reader.read();
    expect(Buffer.from(first.value ?? []).toString("utf8")).toContain("first");

    controller.abort(new DOMException("timed out", "TimeoutError"));
    await expect(reader.read()).rejects.toMatchObject({ code: "timeout" });
    await Promise.race([
      closedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket was not destroyed")), 2_000)),
    ]);
    expect(closed).toBe(true);

    const recovered = await guarded(`http://localhost:${port}/ok`);
    expect(await recovered.text()).toBe("ok");
  });

  it("blocks a hostname that resolves to loopback when private access is off", async () => {
    let hits = 0;
    const { port } = await listen((_req, res) => {
      hits += 1;
      res.end("should not run");
    });
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const error = await errorOf(guarded(`http://localhost:${port}/`));
    expect(error.code).toBe("blocked");
    expect(hits).toBe(0);
  });

  it("blocks an IP literal without using DNS and allows it with `on`", async () => {
    const { url } = await listen((_req, res) => res.end("ok"));
    const blocked = await errorOf(createGuardedFetch({ policy: { mode: "off" } })(url));
    expect(blocked.code).toBe("blocked");

    const allowed = await createGuardedFetch({ policy: { mode: "on" } })(url);
    expect(await allowed.text()).toBe("ok");
  });

  it("requires HTTPS/443 for public addresses before opening a socket", async () => {
    let lookups = 0;
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: async () => {
        lookups += 1;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    });
    const error = await errorOf(guarded("http://public.example:11434/v1/models"));
    expect(error.code).toBe("https_required");
    expect(lookups).toBe(1);
  });

  it("rejects a hostname when any resolved answer is private", async () => {
    const guarded = createGuardedFetch({
      policy: { mode: "off" },
      lookup: lookup([
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    });
    expect((await errorOf(guarded("https://api.example.com/v1"))).code).toBe("blocked");
  });

  it("refuses a second DNS answer that rebinds to a forbidden address", async () => {
    const { port } = await listen((_req, res) => res.end("ok"));
    let lookups = 0;
    const guarded = createGuardedFetch({
      policy: { mode: "list", cidrs: ["127.0.0.1/32"] },
      lookup: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "10.0.0.1", family: 4 }];
      },
    });
    const first = await guarded(`http://rebind.test:${port}/`);
    expect(await first.text()).toBe("ok");
    expect((await errorOf(guarded(`http://rebind.test:${port}/`))).code).toBe("blocked");
    expect(lookups).toBe(2);
  });

  it("does not follow redirects", async () => {
    let targetHits = 0;
    const { port } = await listen((req, res) => {
      if (req.url === "/target") {
        targetHits += 1;
        res.end("target");
        return;
      }
      res.writeHead(302, { location: "/target" });
      res.end();
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const response = await guarded(`http://localhost:${port}/start`);
    expect(response.status).toBe(302);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(targetHits).toBe(0);
  });

  it("destroys the upstream socket when the response body is cancelled", async () => {
    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      const timer = setInterval(() => res.write("data: more\n\n"), 20);
      timer.unref();
      res.on("close", () => {
        clearInterval(timer);
        closed = true;
        resolveClosed();
      });
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const response = await guarded(`http://localhost:${port}/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString("utf8")).toContain("first");
    await reader?.cancel();
    await Promise.race([
      closedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket was not destroyed")), 2_000)),
    ]);
    expect(closed).toBe(true);
  });

  it("maps an aborted connection to a fixed code", async () => {
    const { port } = await listen(() => {
      // Never answer: the caller aborts.
    });
    const guarded = createGuardedFetch({
      policy: { mode: "on" },
      lookup: lookup([{ address: "127.0.0.1", family: 4 }]),
    });
    const controller = new AbortController();
    const pending = guarded(`http://localhost:${port}/slow`, { signal: controller.signal });
    controller.abort(new DOMException("timed out", "TimeoutError"));
    expect((await errorOf(pending)).code).toBe("timeout");
  });

  it("rejects unsupported schemes and credentials without touching the network", async () => {
    const guarded = createGuardedFetch({ policy: { mode: "on" } });
    expect((await errorOf(guarded("ftp://example.com/v1"))).code).toBe("blocked");
    expect((await errorOf(guarded("http://user:pass@127.0.0.1/"))).code).toBe("blocked");
  });
});
