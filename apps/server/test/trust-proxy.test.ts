import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";
import { config, parseTrustProxy } from "../src/config.js";
import { buildApp } from "../src/index.js";

type TestApp = Awaited<ReturnType<typeof buildApp>>["app"];
type TrustProxy = typeof config.trustProxy;

const original = { ...config, mcp: { ...config.mcp } };
afterEach(() => {
  Object.assign(config, original);
  vi.unstubAllEnvs();
});

const withApp = async (trustProxy: TrustProxy, run: (app: TestApp) => Promise<void>): Promise<void> => {
  config.trustProxy = trustProxy;
  const db = openDb(":memory:");
  const { app } = await buildApp(db);
  try {
    await run(app);
  } finally {
    await app.close();
    db.close();
  }
};

const basic = () => ({
  authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
});

describe("KNOWLIFY_TRUST_PROXY", () => {
  it("parses off, on, hop counts and IP/CIDR lists, and rejects anything else at boot", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy(" off ")).toBe(false);
    expect(parseTrustProxy("ON")).toBe(true);
    expect(parseTrustProxy("0")).toBe(0);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("127.0.0.1, 10.0.0.0/8")).toBe("127.0.0.1,10.0.0.0/8");
    expect(parseTrustProxy("::1,fd00::/8")).toBe("::1,fd00::/8");
    for (const invalid of ["proxy.local", "10.0.0.0/33", "::1/129", "10.0.0.1,", "1.5", "on,127.0.0.1"]) {
      expect(() => parseTrustProxy(invalid)).toThrow(/KNOWLIFY_TRUST_PROXY/);
    }
  });

  it("fails the config load with a clear message on an invalid value", async () => {
    vi.stubEnv("KNOWLIFY_TRUST_PROXY", "not-an-ip");
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow("KNOWLIFY_TRUST_PROXY must be off, on, a hop count");
  });

  it("resolves req.ip from X-Forwarded-For only through trusted proxies", async () => {
    const ipOf = async (trustProxy: TrustProxy, remoteAddress: string, forwarded?: string): Promise<string> => {
      let ip = "";
      await withApp(trustProxy, async (app) => {
        app.get("/test/ip", async (req) => ({ ip: req.ip }));
        const response = await app.inject({
          url: "/test/ip",
          remoteAddress,
          headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
        });
        ip = response.json().ip;
      });
      return ip;
    };

    expect(await ipOf(false, "127.0.0.1", "203.0.113.9")).toBe("127.0.0.1");
    expect(await ipOf(true, "127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    // One trusted hop: the rightmost X-Forwarded-For entry is the client-facing proxy.
    expect(await ipOf(1, "127.0.0.1", "198.51.100.7, 203.0.113.9")).toBe("203.0.113.9");
    const trustedList: TrustProxy = "127.0.0.1,10.0.0.0/8";
    expect(await ipOf(trustedList, "127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
    // An untrusted peer address is used as-is even when it sends the header.
    expect(await ipOf(trustedList, "198.51.100.9", "203.0.113.9")).toBe("198.51.100.9");
  });

  it("keys the MCP failure limit on the resolved IP", async () => {
    const failure = (app: TestApp, forwarded: string) => app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer invalid", "content-type": "application/json", "x-forwarded-for": forwarded },
      payload: {},
    });
    await withApp(true, async (app) => {
      for (let i = 0; i < 10; i++) expect((await failure(app, "203.0.113.9")).statusCode).toBe(401);
      expect((await failure(app, "203.0.113.9")).statusCode).toBe(429);
      expect((await failure(app, "203.0.113.10")).statusCode).toBe(401);
    });
    await withApp(false, async (app) => {
      // Spoofing a fresh client address per request does not evade the shared bucket.
      for (let i = 0; i < 10; i++) expect((await failure(app, `203.0.113.${i + 1}`)).statusCode).toBe(401);
      expect((await failure(app, "198.51.100.7")).statusCode).toBe(429);
    });
  });

  it("keys the password-change limit on the resolved IP", async () => {
    const change = (app: TestApp, forwarded: string) => app.inject({
      method: "PUT",
      url: "/api/account/password",
      headers: { ...basic(), "x-forwarded-for": forwarded },
      payload: { current: "wrong", next: "replacement-password" },
    });
    await withApp(true, async (app) => {
      for (let i = 0; i < 5; i++) expect((await change(app, "203.0.113.9")).statusCode).toBe(403);
      expect((await change(app, "203.0.113.9")).statusCode).toBe(429);
      expect((await change(app, "203.0.113.10")).statusCode).toBe(403);
    });
    await withApp(false, async (app) => {
      for (let i = 0; i < 5; i++) expect((await change(app, `203.0.113.${i + 1}`)).statusCode).toBe(403);
      expect((await change(app, "198.51.100.7")).statusCode).toBe(429);
    });
  });
});
