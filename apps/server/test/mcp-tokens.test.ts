import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { NotFoundError, ValidationError } from "../src/domain/errors.js";
import { SqliteMcpTokenRepository } from "../src/adapters/storage/SqliteMcpTokenRepository.js";
import { McpTokenCodec } from "../src/adapters/security/McpTokenCodec.js";
import { McpAccess } from "../src/use-cases/McpAccess.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { MCP_TOKEN_PREFIX } from "../src/domain/access/McpToken.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const setup = () => {
  const db = openDb(":memory:");
  databases.push(db);
  const repo = new SqliteMcpTokenRepository(db);
  const codec = new McpTokenCodec();
  let now = 1_000_000;
  let sequence = 0;
  const access = new McpAccess(repo, codec, { now: () => now }, { next: () => `token-${++sequence}` });
  return {
    db, repo, codec, access,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
};

describe("MCP token lifecycle", () => {
  it("generates a 256-bit token, stores only its hash and shows the prefix", () => {
    const x = setup();
    const created = x.access.create({ name: "  Laptop  ", scope: "read" });
    expect(created.token).toMatch(new RegExp(`^${MCP_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, "u"));
    expect(created.view).toMatchObject({ name: "Laptop", scope: "read", lastUsedAt: null });
    expect(created.view.prefix).toBe(created.token.slice(0, MCP_TOKEN_PREFIX.length + 8));

    const row = x.db.prepare("SELECT * FROM mcp_tokens WHERE id = ?").get(created.view.id) as {
      token_hash: string; token_prefix: string;
    };
    expect(row.token_hash).toBe(x.codec.hash(created.token));
    expect(row.token_hash).not.toContain(created.token);
    expect(row.token_prefix).toBe(created.view.prefix);
    expect(JSON.stringify(x.access.list())).not.toContain(created.token);
  });

  it("authenticates by full hash, never by prefix, and throttles last_used_at", () => {
    const x = setup();
    const created = x.access.create({ name: "Reader", scope: "read" });
    const first = x.access.authenticate(created.token);
    expect(first).toMatchObject({ tokenId: created.view.id, name: "Reader", scope: "read" });
    expect(x.repo.get(created.view.id)?.lastUsedAt).toBe(x.now());

    x.advance(30_000);
    expect(x.access.authenticate(created.token)).not.toBeNull();
    expect(x.repo.get(created.view.id)?.lastUsedAt).toBe(x.now() - 30_000);

    x.advance(31_000);
    expect(x.access.authenticate(created.token)).not.toBeNull();
    expect(x.repo.get(created.view.id)?.lastUsedAt).toBe(x.now());

    // Same prefix, different last character: only the full hash comparison can reject it.
    const forged = `${created.token.slice(0, -1)}${created.token.endsWith("A") ? "B" : "A"}`;
    expect(x.access.authenticate(forged)).toBeNull();
    expect(x.access.authenticate("not-a-token")).toBeNull();
    expect(x.access.authenticate(`${created.token}x`)).toBeNull();
  });

  it("revokes immediately, idempotently and keeps the audit row", () => {
    const x = setup();
    const created = x.access.create({ name: "Old", scope: "write_notes" });
    expect(x.access.authenticate(created.token)).not.toBeNull();
    x.access.revoke(created.view.id);
    expect(x.access.authenticate(created.token)).toBeNull();
    expect(x.access.list()).toEqual([]);
    expect(x.repo.get(created.view.id)?.revokedAt).toBe(x.now());
    expect(() => x.access.revoke(created.view.id)).not.toThrow();
    expect(() => x.access.revoke("missing")).toThrowError(NotFoundError);
  });

  it("caps active tokens at 20 and validates name/scope", () => {
    const x = setup();
    for (let index = 0; index < 20; index++) x.access.create({ name: `Token ${index}`, scope: "read" });
    expect(() => x.access.create({ name: "One more", scope: "read" }))
      .toThrowError(expect.objectContaining({ code: "token_limit_reached" }));
    expect(x.repo.countActive()).toBe(20);

    expect(() => x.access.create({ name: "", scope: "read" })).toThrowError(ValidationError);
    expect(() => x.access.create({ name: "x".repeat(61), scope: "read" })).toThrow();
    expect(() => x.access.create({ name: "bad\u0007name", scope: "read" })).toThrow();
    expect(() => x.access.create({ name: "ok", scope: "admin" as never })).toThrow();
  });
});

const root = await mkdtemp(join(tmpdir(), "knowlify-mcp-tokens-"));
const originalConfig = { ...config, mcp: { ...config.mcp } };
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.mcp.allowedHosts = null;

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

beforeAll(async () => {
  db = openDb(join(root, "tokens.db"));
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  Object.assign(config, originalConfig);
  await rm(root, { recursive: true, force: true });
});

const request = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });

const createToken = async (name: string, scope = "read") => {
  const response = await request("POST", "/api/mcp/tokens", { name, scope });
  expect(response.statusCode).toBe(201);
  return response.json();
};

describe("MCP token HTTP contract", () => {
  it("returns the enabled flag and an empty active list", async () => {
    const response = await request("GET", "/api/mcp/tokens");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, path: "/mcp", items: [] });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns the clear token exactly once and never in the list", async () => {
    const created = await createToken("Claude Desktop", "write_notes");
    expect(created).toEqual({
      id: expect.any(String), name: "Claude Desktop", prefix: expect.any(String),
      scope: "write_notes", createdAt: expect.any(Number), lastUsedAt: null, token: expect.any(String),
    });
    expect(created.token).toMatch(new RegExp(`^${MCP_TOKEN_PREFIX}`, "u"));
    const post = await request("POST", "/api/mcp/tokens", { name: "Another", scope: "read" });
    expect(post.headers["cache-control"]).toBe("no-store");
    const list = await request("GET", "/api/mcp/tokens");
    expect(list.body).not.toContain(created.token);
    expect(list.json().items.find((item: { id: string }) => item.id === created.id)).toEqual({
      id: created.id, name: "Claude Desktop", prefix: created.prefix, scope: "write_notes",
      createdAt: created.createdAt, lastUsedAt: null,
    });
    await request("DELETE", `/api/mcp/tokens/${created.id}`);
  });

  it("rejects a closed body and invalid fields", async () => {
    const invalid = [
      {},
      { name: "x" },
      { name: "x", scope: "admin" },
      { name: "", scope: "read" },
      { name: "x".repeat(61), scope: "read" },
      { name: "bad\nname", scope: "read" },
      { name: "x", scope: "read", extra: true },
      [],
    ];
    for (const payload of invalid) {
      const response = await request("POST", "/api/mcp/tokens", payload as object);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ message: expect.any(String) });
    }
  });

  it("revokes idempotently and reports an unknown id", async () => {
    const created = await createToken("Short lived");
    expect((await request("DELETE", `/api/mcp/tokens/${created.id}`)).statusCode).toBe(204);
    expect((await request("DELETE", `/api/mcp/tokens/${created.id}`)).statusCode).toBe(204);
    expect((await request("DELETE", "/api/mcp/tokens/missing")).statusCode).toBe(404);
    const list = await request("GET", "/api/mcp/tokens");
    expect(list.json().items.find((item: { id: string }) => item.id === created.id)).toBeUndefined();
  });

  it("enforces the 20-active-token limit", async () => {
    const active = (await request("GET", "/api/mcp/tokens")).json().items as { id: string }[];
    for (const item of active) await request("DELETE", `/api/mcp/tokens/${item.id}`);
    for (let index = 0; index < 20; index++) await createToken(`Bulk ${index}`);
    const overflow = await request("POST", "/api/mcp/tokens", { name: "Overflow", scope: "read" });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json()).toMatchObject({ code: "token_limit_reached" });
  });
});
