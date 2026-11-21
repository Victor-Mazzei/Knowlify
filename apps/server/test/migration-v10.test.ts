import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/adapters/storage/db.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-migration-v10-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const seedV9 = (file: string) => {
  const db = openDb(file);
  // Rewind to a populated v9 database: the v10 index and table did not exist in that version.
  db.exec("DROP TABLE mcp_tokens; DROP INDEX notes_book_updated; PRAGMA user_version = 9;");
  db.prepare(`INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
    VALUES ('old-book','Old book','Author','epub','/library/old.epub',NULL,10,1,'source',1,'ready')`).run();
  db.prepare(`INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at)
    VALUES ('old-note','old-book','','','','body',1,1)`).run();
  db.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('old-tag','Old','old','gray',1)").run();
  db.close();
};

describe("v10 migration", () => {
  it("upgrades a populated v9 database additively and remains idempotent", () => {
    const file = join(root, "v9.db");
    seedV9(file);

    const migrated = openDb(file);
    expect(migrated.pragma("user_version", { simple: true })).toBe(11);
    expect(migrated.prepare("SELECT id, title FROM books").all()).toEqual([{ id: "old-book", title: "Old book" }]);
    expect(migrated.prepare("SELECT id FROM notes").all()).toEqual([{ id: "old-note" }]);
    expect(migrated.prepare("SELECT id FROM tags").all()).toEqual([{ id: "old-tag" }]);
    const objects = (migrated.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[])
      .map((row) => row.name);
    expect(objects).toEqual(expect.arrayContaining(["mcp_tokens", "notes_book_updated", "mcp_tokens_prefix"]));
    expect((migrated.prepare("PRAGMA table_info(mcp_tokens)").all() as { name: string }[]).map((column) => column.name))
      .toEqual(["id", "name", "token_prefix", "token_hash", "scope", "created_at", "last_used_at", "revoked_at"]);

    migrated.prepare(`INSERT INTO mcp_tokens (id,name,token_prefix,token_hash,scope,created_at)
      VALUES ('token','Agent','knw_mcp_abc','${"a".repeat(64)}','read',1)`).run();
    expect(() => migrated.prepare(`INSERT INTO mcp_tokens (id,name,token_prefix,token_hash,scope,created_at)
      VALUES ('bad','Agent','knw_mcp_def','${"b".repeat(64)}','delete',1)`).run()).toThrow();
    migrated.close();

    // Reopening an already migrated database runs no migration and keeps the data.
    const reopened = openDb(file);
    expect(reopened.pragma("user_version", { simple: true })).toBe(11);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM mcp_tokens").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
