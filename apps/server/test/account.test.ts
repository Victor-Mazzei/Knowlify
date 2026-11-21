import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { validatePassword } from "../src/domain/account/Password.js";
import { ScryptPasswordHasher, EffectiveCredentials } from "../src/adapters/security/credentials.js";
import { SqliteSettingsRepository } from "../src/adapters/storage/SqliteSettingsRepository.js";
import { openDb } from "../src/adapters/storage/db.js";
import { Account } from "../src/use-cases/Account.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { CredentialVerifier } from "../src/ports/account.js";

const original = { ...config };
afterEach(() => Object.assign(config, original));
const next = "replacement-password";
const basic = (password: string) => ({ authorization: `Basic ${Buffer.from(`${config.user}:${password}`).toString("base64")}` });
const md5 = (password: string) => createHash("md5").update(password).digest("hex");

describe("account domain and use case", () => {
  it.each(["short", "x".repeat(201), "control\npassword", "control\u007fpassword", "control\u0085password", next])("rejects invalid new password %#", value => {
    expect(() => validatePassword(value, value === next)).toThrow();
  });
  it("accepts the boundaries, including Unicode characters", () => {
    validatePassword("x".repeat(8), false);
    validatePassword("😀".repeat(200), false);
  });
  it("uses typed failures, locks changes and expires limits per IP", () => {
    let now = 0;
    const credentials: CredentialVerifier = {
      verify: vi.fn((_user: string, password: string) => password === "correct"),
      verifyKosync: () => false, passwordSource: () => "env", replace: vi.fn(),
    };
    const account = new Account(credentials, { now: () => now }, { user: "user", accountLocked: false });
    for (let i = 0; i < 5; i++) expect(() => account.change("wrong", next, "ip")).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => account.change("correct", next, "ip")).toThrowError(expect.objectContaining({ status: 429 }));
    account.change("correct", next, "other");
    now = 60_000;
    account.change("correct", next, "ip");
    expect(credentials.replace).toHaveBeenCalledWith(next);
    const locked = new Account(credentials, { now: () => now }, { user: "user", accountLocked: true });
    expect(() => locked.change("correct", next, "ip")).toThrow("Password is managed by the app");
  });
});

describe("credential adapters", () => {
  it("creates salted self-describing hashes and rejects wrong/malformed values", () => {
    const hasher = new ScryptPasswordHasher();
    const hash = hasher.hash(next);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(hasher.hash(next)).not.toBe(hash);
    expect(hasher.verify(next, hash)).toBe(true);
    expect(hasher.verify("incorrect", hash)).toBe(false);
    expect(hasher.verify(next, "scrypt$invalid")).toBe(false);
  });
  it("persists settings atomically, caches successful verification and invalidates it", () => {
    const db = openDb(":memory:");
    try {
      const settings = new SqliteSettingsRepository(db);
      expect(db.pragma("user_version", { simple: true })).toBe(11);
      expect(settings.get("missing")).toBeUndefined();
      settings.set({ example: "one" }); settings.set({ example: "two" });
      expect(settings.get("example")).toBe("two");
      const hasher = new ScryptPasswordHasher();
      const verify = vi.spyOn(hasher, "verify");
      const credentials = new EffectiveCredentials(settings, hasher, { user: "user", password: "initial", forceEnvPassword: false });
      credentials.replace(next);
      expect(credentials.verify("user", next)).toBe(true);
      expect(credentials.verify("user", next)).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
      credentials.replace("another-password");
      expect(credentials.verify("user", next)).toBe(false);
      expect(credentials.verify("wrong", "another-password")).toBe(false);
      expect(settings.get("password_hash")).not.toContain(next);
      expect(settings.get("kosync_key")).toBe(md5("another-password"));
      expect(() => settings.set({ example: "rollback", invalid: null as unknown as string })).toThrow();
      expect(settings.get("example")).toBe("two");
    } finally { db.close(); }
  });
});

describe("account HTTP contract", () => {
  it("rotates Basic and KOSync credentials, survives restart, and supports environment recovery", async () => {
    const db = openDb(":memory:");
    let { app } = await buildApp(db);
    const old = config.password;
    const request = (password: string, url: string) => app.inject({ url, headers: basic(password) });
    try {
      expect((await request(old, "/api/account")).json()).toEqual({ user: config.user, canChangePassword: true, passwordSource: "env" });
      for (const url of ["/api/books", "/opds"]) expect((await request(old, url)).statusCode).toBe(200);
      const change = await app.inject({ method: "PUT", url: "/api/account/password", headers: basic(old), payload: { current: old, next } });
      expect(change.statusCode).toBe(204); expect(change.body).toBe("");
      for (const url of ["/api/books", "/opds"]) {
        expect((await request(old, url)).statusCode).toBe(401);
        expect((await request(next, url)).statusCode).toBe(200);
      }
      expect((await request(next, "/api/account")).json().passwordSource).toBe("user");
      for (const [password, status] of [[old, 401], [next, 200]] as const) {
        expect((await app.inject({ url: "/kosync/users/auth", headers: { "x-auth-user": config.user, "x-auth-key": md5(password) } })).statusCode).toBe(status);
      }
      await app.close();
      app = (await buildApp(db)).app;
      expect((await request(next, "/api/books")).statusCode).toBe(200);
      await app.close();
      config.forceEnvPassword = true;
      app = (await buildApp(db)).app;
      expect((await request(old, "/api/account")).json().passwordSource).toBe("env");
      expect((await request(next, "/api/books")).statusCode).toBe(401);
      expect((await app.inject({ url: "/kosync/users/auth", headers: { "x-auth-user": config.user, "x-auth-key": md5(old) } })).statusCode).toBe(200);
    } finally { await app.close(); db.close(); }
  });
  it("returns 400/403/429 without echoing secrets, and respects account locking", async () => {
    const db = openDb(":memory:");
    let { app } = await buildApp(db);
    const change = (payload: object) => app.inject({ method: "PUT", url: "/api/account/password", headers: basic(config.password), payload });
    try {
      for (const payload of [{ current: config.password, next: "short" }, { current: config.password, next: config.password }, { current: config.password, next: "bad\npassword" }, { current: 1, next }, {}]) {
        expect((await change(payload)).statusCode).toBe(400);
      }
      for (let i = 0; i < 5; i++) {
        const result = await change({ current: "secret-wrong", next });
        expect(result.statusCode).toBe(403);
        expect(result.json()).toEqual({ message: "Current password is incorrect" });
        expect(result.headers["www-authenticate"]).toBeUndefined();
        expect(result.body).not.toContain("secret-wrong");
      }
      expect((await change({ current: "secret-wrong", next })).statusCode).toBe(429);
      await app.close(); config.accountLocked = true;
      app = (await buildApp(db)).app;
      expect((await app.inject({ url: "/api/account", headers: basic(config.password) })).json().canChangePassword).toBe(false);
      const locked = await change({ current: config.password, next });
      expect(locked.statusCode).toBe(403);
      expect(locked.json()).toEqual({ message: "Password is managed by the app" });
    } finally { await app.close(); db.close(); }
  });
});
