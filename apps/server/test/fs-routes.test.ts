import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import type { Scanner } from "../src/use-cases/Scanner.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "knowlify-fs-routes-")));
const library = join(root, "library");
const nested = join(library, "nested");
const sibling = join(root, "library2");
const other = join(root, "other");
await mkdir(nested, { recursive: true });
await mkdir(sibling, { recursive: true });
await mkdir(other, { recursive: true });
await writeFile(join(library, "book.pdf"), "");
if (process.platform !== "win32") await symlink(other, join(library, "escape"), "dir");

config.dataDir = join(root, "data");
config.booksDir = join(config.dataDir, "books");
config.coversDir = join(config.dataDir, "covers");
config.libraryPaths = [];

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const apps: Array<{ app: FastifyInstance; db: Db; scanner: Scanner }> = [];

async function build(browseRoots: string[]): Promise<FastifyInstance> {
  config.browseRoots = browseRoots;
  const db = openDb(":memory:");
  const { app, scanner } = await buildApp(db);
  await app.ready();
  apps.push({ app, db, scanner });
  return app;
}

async function waitForScanner(scanner: Scanner): Promise<void> {
  for (let attempt = 0; attempt < 200 && scanner.status().scanning; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await scanner.processPending();
}

afterAll(async () => {
  for (const { app, db, scanner } of apps.reverse()) {
    await waitForScanner(scanner);
    await app.close();
    db.close();
  }
  await rm(root, { recursive: true, force: true });
});

const request = (app: FastifyInstance, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth, payload });

describe("GET /api/fs with browse roots", () => {
  it("requires authentication", async () => {
    const app = await build([library]);
    expect((await app.inject("/api/fs")).statusCode).toBe(401);
  });

  it("enters the single configured root and flags the listing", async () => {
    const app = await build([library]);
    const listing = await request(app, "GET", "/api/fs");
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ path: library, parent: null, books: 1, restricted: true });
    expect(listing.json().entries).toContainEqual({ name: "nested", path: nested });
  });

  it("returns the roots when several are configured", async () => {
    const app = await build([library, other]);
    expect((await request(app, "GET", "/api/fs")).json()).toEqual({
      path: "",
      parent: null,
      books: 0,
      restricted: true,
      entries: [
        { name: "library", path: library },
        { name: "other", path: other },
      ],
    });
  });

  it("browses inside the root and stops at the root boundary", async () => {
    const app = await build([library]);
    expect((await request(app, "GET", `/api/fs?path=${encodeURIComponent(nested)}`)).json()).toMatchObject({
      path: nested,
      parent: library,
      restricted: true,
    });
  });

  it("rejects sibling prefixes, traversal and paths outside the roots", async () => {
    const app = await build([library]);
    for (const path of [sibling, other, join(library, "..", "other"), join(library, "..", "library2")]) {
      const response = await request(app, "GET", `/api/fs?path=${encodeURIComponent(path)}`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: "This folder is outside the folders Knowlify may browse" });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlink that escapes the roots", async () => {
    const app = await build([library]);
    const response = await request(app, "GET", `/api/fs?path=${encodeURIComponent(join(library, "escape"))}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "This folder is outside the folders Knowlify may browse" });
  });

  it("keeps the unrestricted behaviour without roots", async () => {
    const app = await build([]);
    expect((await request(app, "GET", `/api/fs?path=${encodeURIComponent(sibling)}`)).json()).toMatchObject({
      path: sibling,
      restricted: false,
    });
  });
});

describe("POST /api/sources with browse roots", () => {
  it("rejects a folder outside the roots", async () => {
    const app = await build([library]);
    const response = await request(app, "POST", "/api/sources", { path: sibling });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "This folder is outside the folders Knowlify may browse" });
  });

  it("adds and lists a folder inside the root", async () => {
    const app = await build([library]);
    const created = await request(app, "POST", "/api/sources", { path: nested });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: nested });
    expect((await request(app, "GET", "/api/sources")).json()).toContainEqual({
      ...created.json(),
      accessible: true,
      books: 0,
    });
  });

  it("keeps accepting any readable folder without roots", async () => {
    const app = await build([]);
    expect((await request(app, "POST", "/api/sources", { path: other })).statusCode).toBe(201);
  });
});
