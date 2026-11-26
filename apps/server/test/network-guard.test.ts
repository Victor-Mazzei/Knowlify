import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { networkRejection } from "../src/adapters/http/networkGuard.js";

const original = {
  networkGuard: config.networkGuard,
  trustProxy: config.trustProxy,
  logLevel: config.logLevel,
  webDir: config.webDir,
};

const apps: { app: FastifyInstance; db: Db }[] = [];

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
    db.close();
  }
  Object.assign(config, original);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const basic = (user = config.user, password = config.password) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
});
const AUTH = basic();
const LAN_PEER = "192.168.1.20";
const LAN_HOST = `${LAN_PEER}:47870`;
const LAN_ORIGIN = `http://${LAN_HOST}`;

async function makeApp(options: {
  guard?: "off" | "lan";
  trustProxy?: boolean | number | string;
  webDir?: string;
  logLevel?: typeof config.logLevel;
} = {}) {
  config.networkGuard = options.guard ?? "lan";
  config.trustProxy = options.trustProxy ?? false;
  config.logLevel = options.logLevel ?? "info";
  if (options.webDir !== undefined) config.webDir = options.webDir;
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  const db = openDb(":memory:");
  const { app } = await buildApp(db, { stream });
  await app.ready();
  apps.push({ app, db });
  return { app, logs };
}

const guardRejected = (response: LightMyRequestResponse): boolean =>
  response.statusCode === 403 && (response.json() as { message?: string }).message === "Forbidden";

/** Raw HTTP over TCP: HTTP/1.0 lets the request omit Host, which `inject` cannot do. */
const rawRequest = (port: string, payload: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = createConnection({ port: Number(port), host: "127.0.0.1" }, () => socket.write(payload));
  let data = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { data += chunk; });
  socket.on("end", () => resolve(data));
  socket.on("error", reject);
});

const health = (app: FastifyInstance, options: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  forwarded?: string;
} = {}) => app.inject({
  method: "GET",
  url: "/health",
  remoteAddress: options.remoteAddress ?? "127.0.0.1",
  headers: {
    host: options.host ?? "localhost:47870",
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.forwarded === undefined ? {} : { "x-forwarded-for": options.forwarded }),
  },
});

describe("KNOWLIFY_NETWORK_GUARD=off", () => {
  it("keeps the historical behaviour: no peer, host, origin or route checks", async () => {
    const { app } = await makeApp({ guard: "off" });
    expect((await health(app, { remoteAddress: "8.8.8.8", host: "evil.com", origin: "https://evil.com" })).statusCode).toBe(200);
    const fs = await app.inject({
      method: "GET",
      url: "/api/fs",
      remoteAddress: "8.8.8.8",
      headers: { ...AUTH, host: "evil.com", origin: "https://evil.com" },
    });
    expect(guardRejected(fs)).toBe(false);
  });

  it("does not rate-limit failed Basic attempts", async () => {
    const { app } = await makeApp({ guard: "off" });
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/books",
        remoteAddress: "198.51.100.9",
        headers: { ...basic(config.user, "wrong"), host: "localhost" },
      });
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
    }
  });
});

describe("peer allowlist", () => {
  it("rejects public peers with a generic 403", async () => {
    const { app } = await makeApp();
    for (const peer of ["8.8.8.8", "203.0.113.9", "::ffff:8.8.8.8", "2001:db8::1"]) {
      const response = await health(app, { remoteAddress: peer });
      expect(response.statusCode, peer).toBe(403);
      expect(response.json()).toEqual({ message: "Forbidden" });
    }
  });

  it("serves loopback, RFC 1918, CGNAT and link-local peers", async () => {
    const { app } = await makeApp();
    for (const peer of ["127.0.0.1", "::1", "10.1.2.3", LAN_PEER, "100.64.0.1", "169.254.10.5"]) {
      const response = await health(app, { remoteAddress: peer, host: peer.includes(":") ? `[${peer}]` : peer });
      expect(response.statusCode, peer).toBe(200);
    }
  });

  it("never trusts X-Forwarded-For, even when trustProxy is on", async () => {
    const direct = await makeApp({ trustProxy: false });
    expect((await health(direct.app, { remoteAddress: "8.8.8.8", forwarded: "127.0.0.1" })).statusCode).toBe(403);
    const trusting = await makeApp({ trustProxy: true });
    expect((await health(trusting.app, { remoteAddress: "8.8.8.8", forwarded: "127.0.0.1" })).statusCode).toBe(403);
    expect((await health(trusting.app, { remoteAddress: "127.0.0.1", forwarded: "8.8.8.8" })).statusCode).toBe(200);
  });
});

describe("Host allowlist", () => {
  it("accepts loopback, private, CGNAT, [::1], .local and single-label hosts", async () => {
    const { app } = await makeApp();
    for (const host of [
      "localhost",
      "localhost:47870",
      "127.0.0.1:47870",
      "[::1]:47870",
      LAN_HOST,
      "10.0.0.7:47870",
      "100.64.0.1:47870",
      "knowlify.local:47870",
      "desktop",
    ]) {
      expect((await health(app, { host })).statusCode, host).toBe(200);
    }
  });

  it("rejects public hostnames, public literals and a missing Host", async () => {
    const { app } = await makeApp();
    for (const host of ["evil.com", "evil.com:47870", "8.8.8.8", "8.8.8.8:47870"]) {
      const response = await health(app, { host });
      expect(response.statusCode, host).toBe(403);
      expect(response.json()).toEqual({ message: "Forbidden" });
    }
    // `app.inject` always fills a default Host, so the header-less case is exercised twice:
    // directly on the decision function and with a raw HTTP/1.0 request (Host is optional).
    expect(networkRejection(LAN_PEER, { method: "GET", url: "/health", headers: {} })).toBe("host");
    // A duplicate Host is invisible in `req.headers`; the count comes from the raw headers.
    expect(networkRejection(LAN_PEER, {
      method: "GET",
      url: "/health",
      headers: { host: "localhost" },
      hostHeaderCount: 2,
    })).toBe("host");
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const raw = await rawRequest(new URL(address).port, "GET /health HTTP/1.0\r\n\r\n");
    expect(raw.startsWith("HTTP/1.1 403")).toBe(true);
    expect(raw).toContain('{"message":"Forbidden"}');
  });

  it("rejects duplicate, absent and space-padded Host headers on a real socket", async () => {
    const { app } = await makeApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = new URL(address).port;
    const cases: Array<{ name: string; payload: string; status: 403 | readonly [400, 403] }> = [
      {
        name: "duplicate public first",
        payload: "GET /health HTTP/1.1\r\nHost: evil.com\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        status: 403,
      },
      {
        name: "duplicate local first",
        payload: "GET /health HTTP/1.1\r\nHost: localhost\r\nHost: evil.com\r\nConnection: close\r\n\r\n",
        status: 403,
      },
      {
        name: "duplicate local only",
        payload: "GET /health HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        status: 403,
      },
      {
        name: "absent in HTTP/1.1",
        payload: "GET /health HTTP/1.1\r\nConnection: close\r\n\r\n",
        // Node's parser refuses an HTTP/1.1 request without Host before Fastify runs
        // (400 today); if a future parser forwards it, the guard answers 403.
        status: [400, 403],
      },
      {
        name: "space in hostname",
        payload: "GET /health HTTP/1.1\r\nHost: local host\r\nConnection: close\r\n\r\n",
        status: 403,
      },
      {
        name: "space before port",
        payload: "GET /health HTTP/1.1\r\nHost: localhost :47870\r\nConnection: close\r\n\r\n",
        status: 403,
      },
    ];
    for (const testCase of cases) {
      const raw = await rawRequest(port, testCase.payload);
      const status = Number(raw.split(" ")[1]);
      const allowed = Array.isArray(testCase.status) ? testCase.status : [testCase.status];
      // A 200 with a public Host is the failure this test exists to catch.
      expect(allowed, `${testCase.name}: ${raw.split("\r\n")[0]}`).toContain(status);
      if (status === 403) expect(raw, testCase.name).toContain('{"message":"Forbidden"}');
    }
  });
});

describe("Origin allowlist", () => {
  it("accepts the desktop webview, the dev server and the sidecar UI", async () => {
    const { app } = await makeApp();
    for (const origin of ["tauri://localhost", "http://tauri.localhost", "http://localhost:5174", LAN_ORIGIN]) {
      expect((await health(app, { origin })).statusCode, origin).toBe(200);
    }
  });

  it("rejects a public origin", async () => {
    const { app } = await makeApp();
    for (const origin of ["https://evil.com", "https://evil.com:8443", "null"]) {
      const response = await health(app, { origin });
      expect(response.statusCode, origin).toBe(403);
      expect(response.json()).toEqual({ message: "Forbidden" });
    }
  });
});

describe("loopback-only routes", () => {
  it("blocks admin surfaces for a remote peer and allows them on loopback", async () => {
    const { app } = await makeApp();
    const adminRequests = [
      { method: "GET", url: "/api/fs?path=%2F" },
      { method: "POST", url: "/api/sources", payload: { path: "" } },
      { method: "DELETE", url: "/api/sources/some-id" },
      { method: "PUT", url: "/api/settings/llm", payload: {} },
      { method: "POST", url: "/api/settings/chat", payload: {} },
      { method: "GET", url: "/api/mcp/tokens" },
      { method: "POST", url: "/api/mcp/tokens", payload: {} },
      { method: "GET", url: "/api/account" },
      { method: "PUT", url: "/api/account/password", payload: {} },
    ] as const;
    for (const request of adminRequests) {
      const remote = await app.inject({
        ...request,
        remoteAddress: LAN_PEER,
        headers: { ...AUTH, host: LAN_HOST },
      });
      expect(guardRejected(remote), `remote ${request.method} ${request.url}`).toBe(true);
      // Only the loopback-only rejection names a code; the UI uses it to explain the phone limit.
      expect(remote.json(), `remote ${request.method} ${request.url}`).toEqual({ message: "Forbidden", code: "local_only" });
      const local = await app.inject({
        ...request,
        remoteAddress: "127.0.0.1",
        headers: { ...AUTH, host: "127.0.0.1:47870" },
      });
      expect(guardRejected(local), `loopback ${request.method} ${request.url}`).toBe(false);
    }
  });

  it("keeps reads and library writes available to a remote peer", async () => {
    const { app } = await makeApp();
    for (const request of [
      { method: "GET", url: "/api/sources" },
      { method: "GET", url: "/api/settings/llm" },
      { method: "GET", url: "/api/books?limit=20" },
      { method: "POST", url: "/api/scan" },
    ] as const) {
      const response = await app.inject({
        ...request,
        remoteAddress: LAN_PEER,
        headers: { ...AUTH, host: LAN_HOST },
      });
      expect(guardRejected(response), `remote ${request.method} ${request.url}`).toBe(false);
    }
  });
});

describe("guard coverage", () => {
  it("works with request logging disabled", async () => {
    config.networkGuard = "lan";
    const db = openDb(":memory:");
    const { app } = await buildApp(db, false);
    await app.ready();
    apps.push({ app, db });
    expect((await health(app, { host: "evil.com" })).statusCode).toBe(403);
    expect((await health(app, { host: LAN_HOST, remoteAddress: LAN_PEER })).statusCode).toBe(200);
  });

  it("runs before CORS and authentication", async () => {
    const { app } = await makeApp();
    // CORS reflects any Origin; the guard must answer first.
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/chat/messages",
      remoteAddress: LAN_PEER,
      headers: {
        host: LAN_HOST,
        origin: "https://evil.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(guardRejected(preflight)).toBe(true);
    // The loopback-only route answers 403 even without credentials (auth would answer 401).
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/sources",
      remoteAddress: LAN_PEER,
      headers: { host: LAN_HOST },
      payload: { path: "" },
    });
    expect(guardRejected(unauthenticated)).toBe(true);
    // The desktop preflight still works.
    const desktop = await app.inject({
      method: "OPTIONS",
      url: "/api/chat/messages",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:47870",
        origin: "tauri://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(desktop.statusCode).toBe(204);
    expect(desktop.headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });

  it("covers /health, /opds, /kosync, /mcp and the static UI", async () => {
    const webDir = await mkdtemp(join(tmpdir(), "knowlify-network-guard-web-"));
    await writeFile(join(webDir, "index.html"), "<!doctype html><title>Knowlify</title>");
    try {
      const { app } = await makeApp({ webDir });
      const kosync = { "x-auth-user": config.user, "x-auth-key": createHash("md5").update(config.password).digest("hex") };

      const requests = [
        { method: "GET", url: "/health" },
        { method: "GET", url: "/opds", headers: AUTH },
        { method: "GET", url: "/kosync/users/auth", headers: kosync },
        { method: "POST", url: "/mcp", headers: { "content-type": "application/json" }, payload: {} },
        { method: "GET", url: "/" },
        { method: "GET", url: "/library" },
        { method: "GET", url: "/assets/app.js" },
      ] as const;

      for (const request of requests) {
        const rejected = await app.inject({
          ...request,
          remoteAddress: LAN_PEER,
          headers: { ...("headers" in request ? request.headers : {}), host: "evil.com" },
        });
        expect(guardRejected(rejected), `evil host ${request.method} ${request.url}`).toBe(true);

        const publicPeer = await app.inject({
          ...request,
          remoteAddress: "8.8.8.8",
          headers: { ...("headers" in request ? request.headers : {}), host: LAN_HOST },
        });
        expect(guardRejected(publicPeer), `public peer ${request.method} ${request.url}`).toBe(true);
      }

      expect((await app.inject({ url: "/", remoteAddress: LAN_PEER, headers: { host: LAN_HOST } })).statusCode).toBe(200);
      expect((await app.inject({ url: "/library", remoteAddress: LAN_PEER, headers: { host: LAN_HOST } })).statusCode).toBe(200);
    } finally {
      await rm(webDir, { recursive: true, force: true });
    }
  });
});

describe("authentication failure limiter", () => {
  it("answers 429 on the 11th Basic failure and recovers after the window", async () => {
    const { app } = await makeApp();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));

    const attempt = () => app.inject({
      method: "GET",
      url: "/api/books",
      remoteAddress: LAN_PEER,
      headers: { ...basic(config.user, "wrong-password"), host: LAN_HOST },
    });

    for (let failure = 1; failure <= 10; failure += 1) {
      expect((await attempt()).statusCode, `failure ${failure}`).toBe(401);
    }
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ message: "Too many attempts" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    vi.setSystemTime(new Date("2026-03-01T10:01:01Z"));
    const recovered = await app.inject({
      method: "GET",
      url: "/api/books?limit=1",
      remoteAddress: LAN_PEER,
      headers: { ...AUTH, host: LAN_HOST },
    });
    expect(recovered.statusCode).toBe(200);
  });

  it("keys the limiter on the socket address even with a forged X-Forwarded-For", async () => {
    const { app } = await makeApp({ trustProxy: true });
    const attempt = (forwarded: string) => app.inject({
      method: "GET",
      url: "/api/books",
      remoteAddress: LAN_PEER,
      headers: { ...basic(config.user, "wrong-password"), host: LAN_HOST, "x-forwarded-for": forwarded },
    });
    for (let failure = 1; failure <= 10; failure += 1) {
      expect((await attempt(`203.0.113.${failure}`)).statusCode, `failure ${failure}`).toBe(401);
    }
    expect((await attempt("198.51.100.7")).statusCode).toBe(429);
  });

  it("limits KOSync failures per peer too", async () => {
    const { app } = await makeApp();
    const attempt = () => app.inject({
      method: "GET",
      url: "/kosync/users/auth",
      remoteAddress: LAN_PEER,
      headers: {
        host: LAN_HOST,
        "x-auth-user": config.user,
        "x-auth-key": createHash("md5").update("wrong-password").digest("hex"),
      },
    });
    for (let failure = 1; failure <= 10; failure += 1) {
      expect((await attempt()).statusCode, `failure ${failure}`).toBe(401);
    }
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ message: "Too many attempts" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
});

describe("log sentinels", () => {
  it("never logs the Host, Origin, URL or credentials, only the rejection category", async () => {
    const { app, logs } = await makeApp({ logLevel: "debug" });
    const sentinels = {
      host: "evil-host-sentinel.example",
      origin: "https://origin-sentinel.example/path?secret=origin-query-sentinel",
      route: "/api/fs?path=%2Froute-query-sentinel",
      user: "user-name-sentinel",
      password: "password-sentinel",
    };

    const hostRejected = await health(app, { host: sentinels.host });
    expect(hostRejected.statusCode).toBe(403);
    const originRejected = await health(app, { host: "localhost", origin: sentinels.origin });
    expect(originRejected.statusCode).toBe(403);
    const routeRejected = await app.inject({
      method: "GET",
      url: sentinels.route,
      remoteAddress: LAN_PEER,
      headers: { ...AUTH, host: LAN_HOST },
    });
    expect(guardRejected(routeRejected)).toBe(true);

    for (let failure = 1; failure <= 11; failure += 1) {
      await app.inject({
        method: "GET",
        url: "/api/books",
        remoteAddress: LAN_PEER,
        headers: { ...basic(sentinels.user, sentinels.password), host: LAN_HOST },
      });
    }

    // KOSync has its own rate-limited log line; the md5 header must stay out of the log too.
    const kosyncPeer = "10.0.0.9";
    const kosyncHost = `${kosyncPeer}:47870`;
    for (let failure = 1; failure <= 11; failure += 1) {
      await app.inject({
        method: "GET",
        url: "/kosync/users/auth",
        remoteAddress: kosyncPeer,
        headers: {
          host: kosyncHost,
          "x-auth-user": sentinels.user,
          "x-auth-key": createHash("md5").update(sentinels.password).digest("hex"),
        },
      });
    }

    const output = logs.join("");
    expect(output).toContain("network guard rejected category=host");
    expect(output).toContain("network guard rejected category=origin");
    expect(output).toContain("network guard rejected category=route");
    expect(output).toContain("auth failed provider=basic");
    expect(output).toContain("auth rate-limited provider=basic");
    expect(output).toContain("auth failed provider=kosync");
    expect(output).toContain("auth rate-limited provider=kosync");
    for (const sentinel of Object.values(sentinels)) {
      expect(output, sentinel).not.toContain(sentinel);
    }
    expect(output).not.toContain("origin-sentinel.example");
    expect(output).not.toContain("route-query-sentinel");
    expect(output).not.toContain("evil-host-sentinel");
  });
});
