import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import {
  UNKNOWN_VERSION,
  loadBuildInfo,
  parseBuildCommit,
  parseBuildDate,
  parseSourceUrl,
  readVersion,
} from "../src/adapters/runtime/buildInfo.js";

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };
const serverPackageJson = new URL("../package.json", import.meta.url);
const savedBuildEnv = {
  commit: process.env.KNOWLIFY_BUILD_COMMIT,
  date: process.env.KNOWLIFY_BUILD_DATE,
  source: process.env.KNOWLIFY_SOURCE_URL,
};
const apps: { app: FastifyInstance; db: Db }[] = [];

function clearBuildEnv(): void {
  delete process.env.KNOWLIFY_BUILD_COMMIT;
  delete process.env.KNOWLIFY_BUILD_DATE;
  delete process.env.KNOWLIFY_SOURCE_URL;
}

async function makeApp(): Promise<FastifyInstance> {
  const db = openDb(":memory:");
  const { app } = await buildApp(db, false);
  await app.ready();
  apps.push({ app, db });
  return app;
}

beforeEach(clearBuildEnv);

afterEach(async () => {
  clearBuildEnv();
  for (const { app, db } of apps.splice(0)) {
    await app.close();
    db.close();
  }
});

afterAll(() => {
  if (savedBuildEnv.commit !== undefined) process.env.KNOWLIFY_BUILD_COMMIT = savedBuildEnv.commit;
  if (savedBuildEnv.date !== undefined) process.env.KNOWLIFY_BUILD_DATE = savedBuildEnv.date;
  if (savedBuildEnv.source !== undefined) process.env.KNOWLIFY_SOURCE_URL = savedBuildEnv.source;
});

describe("GET /api/about", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/about" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized" });
  });

  it("returns the packaged version, build metadata and Node version", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    process.env.KNOWLIFY_BUILD_COMMIT = sha;
    process.env.KNOWLIFY_BUILD_DATE = "2026-11-07T12:00:00Z";
    process.env.KNOWLIFY_SOURCE_URL = "https://github.com/example-org/library-app/";
    const manifest: unknown = JSON.parse(await readFile(serverPackageJson, "utf8"));
    const version = typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "";

    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/about", headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      version,
      commit: sha.slice(0, 7),
      builtAt: "2026-11-07T12:00:00.000Z",
      sourceUrl: "https://github.com/example-org/library-app",
      node: process.versions.node,
    });
    expect(response.body).not.toMatch(/KNOWLIFY|package\.json|\/home\/|secret/i);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });

  it("falls back to no commit and no build date when the build variables are absent", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/about", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ commit: null, builtAt: null, sourceUrl: null });
  });

  it("ignores malformed build variables instead of failing the request", async () => {
    process.env.KNOWLIFY_BUILD_COMMIT = "not-a-sha";
    process.env.KNOWLIFY_BUILD_DATE = "yesterday";
    process.env.KNOWLIFY_SOURCE_URL = "ftp://git.example.com/example-org";
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/about", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ commit: null, builtAt: null, sourceUrl: null });
  });
});

describe("buildInfo", () => {
  it("shortens a full SHA and rejects values outside lowercase hex 7-40", () => {
    expect(parseBuildCommit("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
    expect(parseBuildCommit("a3e1c7f")).toBe("a3e1c7f");
    expect(parseBuildCommit("A3E1C7F")).toBeNull();
    expect(parseBuildCommit("a3e1c7")).toBeNull();
    expect(parseBuildCommit("0123456789abcdef0123456789abcdef012345678")).toBeNull();
    expect(parseBuildCommit("g3e1c7f")).toBeNull();
    expect(parseBuildCommit("")).toBeNull();
    expect(parseBuildCommit(undefined)).toBeNull();
  });

  it("accepts ISO timestamps and rejects date-only or invalid dates", () => {
    expect(parseBuildDate("2026-11-07T12:00:00Z")).toBe("2026-11-07T12:00:00.000Z");
    expect(parseBuildDate("2026-11-07T12:00:00.123+02:00")).toBe("2026-11-07T10:00:00.123Z");
    expect(parseBuildDate("2026-11-07")).toBeNull();
    expect(parseBuildDate("2026-13-01T00:00:00Z")).toBeNull();
    expect(parseBuildDate("not-a-date")).toBeNull();
    expect(parseBuildDate(undefined)).toBeNull();
  });

  it("accepts only plain HTTP(S) source URLs without credentials", () => {
    expect(parseSourceUrl("https://github.com/example-org/knowlify/")).toBe("https://github.com/example-org/knowlify");
    expect(parseSourceUrl(" http://git.example.com/example-org/knowlify ")).toBe("http://git.example.com/example-org/knowlify");
    expect(parseSourceUrl("ftp://git.example.com/example-org/knowlify")).toBeNull();
    expect(parseSourceUrl("https://token@git.example.com/example-org/knowlify")).toBeNull();
    expect(parseSourceUrl("not a url")).toBeNull();
    expect(parseSourceUrl("")).toBeNull();
    expect(parseSourceUrl(undefined)).toBeNull();
  });

  it("reads the version from the packaged manifest and warns when it is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knowlify-buildinfo-"));
    try {
      const valid = join(dir, "valid.json");
      await writeFile(valid, JSON.stringify({ version: "1.2.3" }));
      expect(readVersion(pathToFileURL(valid))).toBe("1.2.3");

      const warnings: string[] = [];
      expect(readVersion(pathToFileURL(join(dir, "missing.json")), (message) => warnings.push(message))).toBe(UNKNOWN_VERSION);
      expect(warnings).toHaveLength(1);

      const invalid = join(dir, "invalid.json");
      await writeFile(invalid, JSON.stringify({ name: "no-version" }));
      expect(readVersion(pathToFileURL(invalid))).toBe(UNKNOWN_VERSION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("combines the manifest, injected env and Node version without touching response-only data", async () => {
    const info = loadBuildInfo({
      env: {
        KNOWLIFY_BUILD_COMMIT: "0123456789abcdef",
        KNOWLIFY_BUILD_DATE: "2026-11-07T12:00:00Z",
      },
      nodeVersion: "22.11.0",
    });
    expect(info).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      commit: "0123456",
      builtAt: "2026-11-07T12:00:00.000Z",
      sourceUrl: null,
      node: "22.11.0",
    });
    expect(Object.keys(info).sort()).toEqual(["builtAt", "commit", "node", "sourceUrl", "version"]);
  });
});
