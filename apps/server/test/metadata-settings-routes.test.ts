import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AesGcmSecretBox } from "../src/adapters/security/SecretBox.js";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { MetadataSettingsView } from "../src/use-cases/MetadataSettings.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-metadata-settings-"));
const USER_KEY = "AIza-user-key-sentinel-0123456789";
const OTHER_SECRET = "t".repeat(32);

config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.secret.value = null;
config.secret.file = join(root, "secret.key");
config.metadata.lookup = true;
config.metadata.googleBooksApiKey = null;
config.metadataLocked = false;

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

/** Mirrors `apps/web/src/modules/settings/metadataTypes.ts`; the two must stay assignable. */
type FrontMetadataSettingsView = {
  lookupEnabled: boolean;
  lookupSource: "env" | "user";
  googleBooks: {
    hasKey: boolean;
    keyState: "ok" | "unreadable" | "none";
    source: "env" | "user" | "none";
  };
  locked: boolean;
  providers: Array<"openlibrary" | "googlebooks">;
};
const asFrontContract = (view: MetadataSettingsView): FrontMetadataSettingsView => view;
const asServerContract = (view: FrontMetadataSettingsView): MetadataSettingsView => view;

const emptyView: MetadataSettingsView = {
  lookupEnabled: true,
  lookupSource: "env",
  googleBooks: { hasKey: false, keyState: "none", source: "none" },
  locked: false,
  providers: ["openlibrary", "googlebooks"],
};

async function open(file: string): Promise<{ db: Db; app: Awaited<ReturnType<typeof buildApp>>["app"] }> {
  const db = openDb(join(root, file));
  const { app } = await buildApp(db);
  await app.ready();
  return { db, app };
}

const request = (
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  method: "GET" | "PUT",
  url: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const rows = (db: Db): { key: string; value: string }[] =>
  db.prepare("SELECT key, value FROM settings WHERE key LIKE 'metadata_%'").all() as { key: string; value: string }[];

describe("GET/PUT /api/settings/metadata", () => {
  it("requires Basic auth", async () => {
    const { db, app } = await open("auth.db");
    try {
      expect((await app.inject({ method: "GET", url: "/api/settings/metadata" })).statusCode).toBe(401);
      expect((await app.inject({
        method: "PUT",
        url: "/api/settings/metadata",
        headers: { "content-type": "application/json" },
        payload: { lookupEnabled: true },
      })).statusCode).toBe(401);
      expect((await request(app, "GET", "/api/settings/metadata")).statusCode).toBe(200);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("returns the exact contract and stores a sealed key when saved", async () => {
    const { db, app } = await open("contract.db");
    try {
      expect(asFrontContract).toBeTypeOf("function");
      expect(asServerContract).toBeTypeOf("function");

      const initial = await request(app, "GET", "/api/settings/metadata");
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual(emptyView);

      const saved = await request(app, "PUT", "/api/settings/metadata", {
        lookupEnabled: true,
        googleBooksKey: USER_KEY,
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({
        lookupEnabled: true,
        lookupSource: "user",
        googleBooks: { hasKey: true, keyState: "ok", source: "user" },
        locked: false,
        providers: ["openlibrary", "googlebooks"],
      });
      expect(saved.body).not.toContain(USER_KEY);

      const stored = rows(db);
      expect(stored).toHaveLength(2);
      expect(stored.find((row) => row.key === "metadata_lookup_enabled")?.value).toBe("on");
      const sealed = stored.find((row) => row.key === "metadata_google_books_key")?.value ?? "";
      expect(sealed).toMatch(/^v1:/);
      expect(sealed).not.toContain(USER_KEY);
      expect(stored.map((row) => row.value).join(" ")).not.toContain(USER_KEY);

      const fetched = await request(app, "GET", "/api/settings/metadata");
      expect(fetched.json()).toEqual(saved.json());
      expect(fetched.body).not.toContain(USER_KEY);
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({
        providers: [
          { id: "openlibrary", keyConfigured: false },
          { id: "googlebooks", keyConfigured: true },
        ],
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("removes only the saved key and reports the environment fallback", async () => {
    config.metadata.googleBooksApiKey = "env-key-sentinel";
    const { db, app } = await open("remove.db");
    try {
      await request(app, "PUT", "/api/settings/metadata", { googleBooksKey: USER_KEY });
      expect((await request(app, "GET", "/api/settings/metadata")).json()).toMatchObject({
        googleBooks: { hasKey: true, keyState: "ok", source: "user" },
      });

      const removed = await request(app, "PUT", "/api/settings/metadata", { googleBooksKey: null });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({
        lookupEnabled: true,
        lookupSource: "env",
        googleBooks: { hasKey: true, keyState: "ok", source: "env" },
        locked: false,
        providers: ["openlibrary", "googlebooks"],
      });
      expect(rows(db).some((row) => row.key === "metadata_google_books_key")).toBe(false);
    } finally {
      config.metadata.googleBooksApiKey = null;
      await app.close();
      db.close();
    }
  });

  it("validates bodies, unknown fields and key content with stable codes", async () => {
    const { db, app } = await open("invalid.db");
    try {
      const cases: Array<[unknown, string, string]> = [
        [{}, "invalid_settings", "body"],
        [{ unknown: true }, "invalid_settings", "unknown"],
        [{ lookupEnabled: "on" }, "invalid_settings", "lookupEnabled"],
        [{ googleBooksKey: 42 }, "invalid_google_books_key", "googleBooksKey"],
        [{ googleBooksKey: "" }, "invalid_google_books_key", "googleBooksKey"],
        [{ googleBooksKey: "key with space" }, "invalid_google_books_key", "googleBooksKey"],
        [{ googleBooksKey: "x".repeat(257) }, "invalid_google_books_key", "googleBooksKey"],
      ];
      for (const [payload, code, field] of cases) {
        const response = await request(app, "PUT", "/api/settings/metadata", payload);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code, field });
        expect(response.body).not.toContain(USER_KEY);
      }

      const emptyBody = await app.inject({
        method: "PUT",
        url: "/api/settings/metadata",
        headers: { ...auth, "content-type": "application/json" },
        payload: "",
      });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json()).toMatchObject({ code: "invalid_settings", field: "body" });

      expect((await request(app, "PUT", "/api/settings/metadata", { googleBooksKey: null })).statusCode).toBe(200);
      expect(rows(db)).toHaveLength(0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("persists the user settings across an application restart", async () => {
    const file = "restart.db";
    const first = await open(file);
    try {
      expect((await request(first.app, "PUT", "/api/settings/metadata", {
        lookupEnabled: false,
        googleBooksKey: USER_KEY,
      })).statusCode).toBe(200);
    } finally {
      await first.app.close();
      first.db.close();
    }

    const second = await open(file);
    try {
      expect((await request(second.app, "GET", "/api/settings/metadata")).json()).toEqual({
        lookupEnabled: false,
        lookupSource: "user",
        googleBooks: { hasKey: true, keyState: "ok", source: "user" },
        locked: false,
        providers: ["openlibrary", "googlebooks"],
      });
      expect((await request(second.app, "GET", "/api/metadata/status")).json()).toMatchObject({ enabled: false });
    } finally {
      await second.app.close();
      second.db.close();
    }
  });

  it("locks writes and ignores the stored settings when KNOWLIFY_METADATA_LOCKED is set", async () => {
    const file = "locked.db";
    const seeded = openDb(join(root, file));
    const sealed = new AesGcmSecretBox("s".repeat(32)).seal(USER_KEY);
    seeded.prepare("INSERT INTO settings(key, value) VALUES ('metadata_lookup_enabled', 'off'), ('metadata_google_books_key', ?)").run(sealed);
    seeded.close();

    config.metadataLocked = true;
    const { db, app } = await open(file);
    try {
      expect((await request(app, "GET", "/api/settings/metadata")).json()).toEqual({
        lookupEnabled: true,
        lookupSource: "env",
        googleBooks: { hasKey: false, keyState: "none", source: "none" },
        locked: true,
        providers: ["openlibrary", "googlebooks"],
      });
      const blocked = await request(app, "PUT", "/api/settings/metadata", { lookupEnabled: false });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ code: "metadata_locked" });
      expect(blocked.body).not.toContain(USER_KEY);
    } finally {
      config.metadataLocked = false;
      await app.close();
      db.close();
    }
  });

  it("applies the saved toggle over the environment without a restart", async () => {
    config.metadata.lookup = false;
    const { db, app } = await open("toggle.db");
    try {
      expect((await request(app, "GET", "/api/settings/metadata")).json()).toEqual({
        ...emptyView,
        lookupEnabled: false,
      });
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({ enabled: false });
      expect((await request(app, "GET", "/api/metadata/search?isbn=9780132350884")).json())
        .toMatchObject({ code: "lookup_disabled" });
      expect((await request(app, "POST", "/api/books/any/cover/from-url", {
        url: "https://covers.openlibrary.org/b/id/1-L.jpg",
      })).json()).toMatchObject({ code: "lookup_disabled" });

      expect((await request(app, "PUT", "/api/settings/metadata", { lookupEnabled: true })).statusCode).toBe(200);
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({ enabled: true });
      // Enabled: the request reaches validation instead of being rejected by the switch.
      expect((await request(app, "GET", "/api/metadata/search")).statusCode).toBe(400);
      expect((await request(app, "POST", "/api/books/any/cover/from-url", {
        url: "http://covers.openlibrary.org/b/id/1-L.jpg",
      })).statusCode).toBe(404);

      expect((await request(app, "PUT", "/api/settings/metadata", { lookupEnabled: false })).statusCode).toBe(200);
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({ enabled: false });
    } finally {
      config.metadata.lookup = true;
      await app.close();
      db.close();
    }
  });

  it("reports an undecryptable key as unreadable and repairs it on save", async () => {
    const file = "unreadable.db";
    const seeded = openDb(join(root, file));
    seeded.prepare("INSERT INTO settings(key, value) VALUES ('metadata_google_books_key', ?)")
      .run(new AesGcmSecretBox(OTHER_SECRET).seal(USER_KEY));
    seeded.close();

    config.secret.value = "s".repeat(32);
    const { db, app } = await open(file);
    try {
      expect((await request(app, "GET", "/api/settings/metadata")).json()).toEqual({
        lookupEnabled: true,
        lookupSource: "env",
        googleBooks: { hasKey: true, keyState: "unreadable", source: "user" },
        locked: false,
        providers: ["openlibrary", "googlebooks"],
      });
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({
        providers: [
          { id: "openlibrary", keyConfigured: false },
          { id: "googlebooks", keyConfigured: false },
        ],
      });

      const repaired = await request(app, "PUT", "/api/settings/metadata", { googleBooksKey: USER_KEY });
      expect(repaired.statusCode).toBe(200);
      expect(repaired.json()).toMatchObject({ googleBooks: { hasKey: true, keyState: "ok", source: "user" } });
      expect((await request(app, "GET", "/api/metadata/status")).json()).toMatchObject({
        providers: [
          { id: "openlibrary", keyConfigured: false },
          { id: "googlebooks", keyConfigured: true },
        ],
      });
    } finally {
      config.secret.value = null;
      await app.close();
      db.close();
    }
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
