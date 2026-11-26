import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteUpdateConfigStore, SqliteUpdateStateStore } from "../src/adapters/update/SqliteUpdateStore.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { ReleaseFetchResult } from "../src/ports/update.js";

const original = {
  update: { ...config.update },
  networkGuard: config.networkGuard,
  logLevel: config.logLevel,
};

const apps: Array<{ app: FastifyInstance; db: Db }> = [];

afterEach(async () => {
  for (const { app, db } of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
    db.close();
  }
  config.update = { ...original.update };
  config.networkGuard = original.networkGuard;
  config.logLevel = original.logLevel;
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const ok = (tag = "v2.5.0", etag: string | null = 'W/"one"'): ReleaseFetchResult => ({
  outcome: "ok",
  release: {
    tag,
    version: {
      major: tag.slice(1).split(".")[0]!,
      minor: tag.slice(1).split(".")[1]!,
      patch: tag.slice(1).split(".")[2]!,
      prerelease: [],
    },
  },
  etag,
});

interface FakeFetch {
  calls: string[];
  fetch: typeof globalThis.fetch;
}

function fakeFetch(result: ReleaseFetchResult | (() => ReleaseFetchResult)): FakeFetch {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const value = typeof result === "function" ? result() : result;
    if (value.outcome === "failed") {
      const status = value.status ?? 500;
      return new Response(null, {
        status,
        headers: value.retryAfterMs === undefined ? {} : { "retry-after": String(Math.ceil(value.retryAfterMs / 1000)) },
      });
    }
    if (value.outcome === "not_modified") return new Response(null, { status: 304, headers: { etag: value.etag ?? "" } });
    return new Response(JSON.stringify({ tag_name: value.release.tag }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(value.etag === null ? {} : { etag: value.etag }),
      },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

interface MakeAppOptions {
  enabled?: boolean | null;
  locked?: boolean;
  guard?: "off" | "lan";
  fetch?: typeof globalThis.fetch;
  seed?: Parameters<SqliteUpdateStateStore["save"]>[0];
  logLevel?: typeof config.logLevel;
}

async function makeApp(options: MakeAppOptions = {}) {
  config.update = {
    enabled: options.enabled === undefined ? true : options.enabled,
    locked: options.locked ?? false,
  };
  config.networkGuard = options.guard ?? "off";
  config.logLevel = options.logLevel ?? "info";
  const db = openDb(":memory:");
  if (options.seed !== undefined) new SqliteUpdateStateStore(db).save(options.seed);
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  const { app } = await buildApp(db, { stream }, undefined, undefined, {
    update: {
      fetch: options.fetch ?? fakeFetch(ok()).fetch,
      currentVersion: "2.4.0",
    },
  });
  await app.ready();
  apps.push({ app, db });
  return { app, db, logs };
}

const fresh = (): NonNullable<MakeAppOptions["seed"]> => ({
  latestTag: "v2.5.0",
  etag: 'W/"one"',
  checkedAt: Date.now(),
  nextAttemptAt: null,
  failures: 0,
});

const call = (
  app: FastifyInstance,
  method: "GET" | "PUT" | "POST",
  url: string,
  options: {
    payload?: unknown;
    remoteAddress?: string;
    host?: string;
    forwarded?: string;
    authenticated?: boolean;
  } = {},
) => app.inject({
  method,
  url,
  ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
  headers: {
    ...(options.authenticated === false ? {} : auth),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.forwarded === undefined ? {} : { "x-forwarded-for": options.forwarded }),
  },
  ...(options.payload === undefined ? {} : { payload: options.payload as object }),
});

describe("GET /api/update", () => {
  it("requires Basic auth", async () => {
    const { app } = await makeApp();
    for (const [method, url] of [
      ["GET", "/api/update"],
      ["POST", "/api/update/check"],
      ["GET", "/api/settings/update"],
      ["PUT", "/api/settings/update"],
    ] as const) {
      const response = await call(app, method, url, {
        authenticated: false,
        ...(method === "PUT" ? { payload: { enabled: true } } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("returns the exact contract from a fresh cache and never blocks", async () => {
    const checkedAt = Date.now();
    const { app, logs } = await makeApp({ seed: { ...fresh(), checkedAt } });
    const response = await call(app, "GET", "/api/update");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      enabled: true,
      locked: false,
      canManage: true,
      current: "2.4.0",
      latest: {
        version: "2.5.0",
        url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0",
      },
      available: true,
      checkedAt: new Date(checkedAt).toISOString(),
    });
    expect(logs.join("")).not.toContain("v2.5.0");
  });

  it("serves an empty cache and fills it lazily on a later read", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ fetch: source.fetch });
    const first = await call(app, "GET", "/api/update");
    expect(first.json()).toMatchObject({ latest: null, available: false, checkedAt: null });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await call(app, "GET", "/api/update");
    expect(second.json()).toMatchObject({ latest: { version: "2.5.0" }, available: true });
    expect(source.calls).toHaveLength(1);
  });

  it("discards the cache and makes no call when disabled", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ enabled: false, seed: fresh(), fetch: source.fetch });
    const response = await call(app, "GET", "/api/update");
    expect(response.json()).toEqual({
      enabled: false,
      locked: false,
      canManage: true,
      current: "2.4.0",
      latest: null,
      available: false,
      checkedAt: null,
    });
    const check = await call(app, "POST", "/api/update/check");
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ enabled: false, latest: null });
    expect(source.calls).toHaveLength(0);
  });

  it("never announces when the cached release is not newer than the running version", async () => {
    const { app } = await makeApp({ seed: { ...fresh(), latestTag: "v2.4.0" } });
    const response = await call(app, "GET", "/api/update");
    expect(response.json()).toMatchObject({
      current: "2.4.0",
      latest: { version: "2.4.0" },
      available: false,
    });
  });

  it("hides the banner from a remote LAN peer under the guard", async () => {
    const { app } = await makeApp({ guard: "lan", seed: fresh() });
    const remote = await call(app, "GET", "/api/update", {
      remoteAddress: "192.168.1.20",
      host: "192.168.1.20:47870",
    });
    expect(remote.statusCode).toBe(200);
    expect(remote.json()).toMatchObject({ canManage: false });
    const local = await call(app, "GET", "/api/update", {
      remoteAddress: "127.0.0.1",
      host: "localhost:47870",
    });
    expect(local.json()).toMatchObject({ canManage: true });
  });

  it("does not start a lazy check for a remote LAN peer", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ guard: "lan", fetch: source.fetch });
    const remote = await call(app, "GET", "/api/update", {
      remoteAddress: "192.168.1.20",
      host: "192.168.1.20:47870",
      // A forged forwarding header must not turn the remote peer into loopback.
      forwarded: "127.0.0.1",
    });
    expect(remote.statusCode).toBe(200);
    expect(remote.json()).toMatchObject({ canManage: false, latest: null, checkedAt: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.calls).toHaveLength(0);

    const local = await call(app, "GET", "/api/update", {
      remoteAddress: "127.0.0.1",
      host: "localhost:47870",
    });
    expect(local.json()).toMatchObject({ canManage: true, latest: null, checkedAt: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.calls).toHaveLength(1);
  });

  it("keeps /api/about unchanged", async () => {
    const { app } = await makeApp();
    const response = await call(app, "GET", "/api/about");
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json() as object).sort()).toEqual(["builtAt", "commit", "node", "sourceUrl", "version"]);
  });
});

describe("POST /api/update/check", () => {
  it("returns the cache when disabled and awaits a real check otherwise", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ fetch: source.fetch });
    const enabled = await call(app, "POST", "/api/update/check");
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ latest: { version: "2.5.0" }, available: true });
    expect(source.calls).toHaveLength(1);
  });

  it("limits explicit checks to 6 per minute", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ fetch: source.fetch });
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await call(app, "POST", "/api/update/check");
      expect(response.statusCode, `attempt ${attempt}`).toBe(200);
    }
    const limited = await call(app, "POST", "/api/update/check");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({ code: "rate_limited" });
    expect(source.calls).toHaveLength(1);
  });

  it("rejects a remote LAN peer with local_only, without fetching or consuming the limit", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ guard: "lan", fetch: source.fetch });
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const response = await call(app, "POST", "/api/update/check", {
        remoteAddress: "192.168.1.20",
        host: "192.168.1.20:47870",
        // Forged forwarding headers never widen the peer check.
        forwarded: "127.0.0.1",
      });
      expect(response.statusCode, `attempt ${attempt}`).toBe(403);
      expect(response.json()).toEqual({ message: "Forbidden", code: "local_only" });
    }
    expect(source.calls).toHaveLength(0);

    // The rejected calls never reached the route, so the loopback peer still has a
    // full 6/min window and performs the first real check.
    const local = await call(app, "POST", "/api/update/check", {
      remoteAddress: "127.0.0.1",
      host: "localhost:47870",
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ canManage: true, latest: { version: "2.5.0" } });
    expect(source.calls).toHaveLength(1);
  });

  it("keeps a remote POST unchanged when the guard is off", async () => {
    const source = fakeFetch(ok());
    const { app } = await makeApp({ guard: "off", fetch: source.fetch });
    const remote = await call(app, "POST", "/api/update/check", {
      remoteAddress: "192.168.1.20",
      host: "192.168.1.20:47870",
      forwarded: "127.0.0.1",
    });
    expect(remote.statusCode).toBe(200);
    expect(remote.json()).toMatchObject({ canManage: true, latest: { version: "2.5.0" } });
    expect(source.calls).toHaveLength(1);
  });
});

describe("GET/PUT /api/settings/update", () => {
  it("reports the default, environment and database sources", async () => {
    const unset = await makeApp({ enabled: null });
    expect((await call(unset.app, "GET", "/api/settings/update")).json()).toEqual({
      enabled: true,
      locked: false,
      source: "default",
    });

    const env = await makeApp({ enabled: false });
    expect((await call(env.app, "GET", "/api/settings/update")).json()).toEqual({
      enabled: false,
      locked: false,
      source: "env",
    });

    const stored = await makeApp({ enabled: true });
    const put = await call(stored.app, "PUT", "/api/settings/update", { payload: { enabled: false } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ enabled: false, locked: false, source: "db" });
    expect((await call(stored.app, "GET", "/api/settings/update")).json()).toEqual(put.json());
    expect(new SqliteUpdateConfigStore(stored.db).load()).toBe(false);
    expect((await call(stored.app, "GET", "/api/update")).json()).toMatchObject({ enabled: false, latest: null });
  });

  it("rejects invalid bodies with a stable code", async () => {
    const { app } = await makeApp();
    for (const payload of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, extra: true }, []]) {
      const response = await call(app, "PUT", "/api/settings/update", { payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_body" });
    }
  });

  it("locks the toggle to the environment", async () => {
    const { app } = await makeApp({ enabled: false, locked: true });
    expect((await call(app, "GET", "/api/settings/update")).json()).toEqual({
      enabled: false,
      locked: true,
      source: "env",
    });
    const put = await call(app, "PUT", "/api/settings/update", { payload: { enabled: true } });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: "update_locked" });
  });

  it("answers local_only to a remote LAN peer", async () => {
    const { app } = await makeApp({ guard: "lan" });
    const remote = await call(app, "PUT", "/api/settings/update", {
      payload: { enabled: false },
      remoteAddress: "192.168.1.20",
      host: "192.168.1.20:47870",
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ code: "local_only" });
    const local = await call(app, "PUT", "/api/settings/update", {
      payload: { enabled: false },
      remoteAddress: "127.0.0.1",
      host: "localhost:47870",
    });
    expect(local.statusCode).toBe(200);
  });
});
