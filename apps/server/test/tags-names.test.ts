import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { SqliteTagRepository } from "../src/adapters/storage/SqliteTagRepository.js";
import { SqliteBookListQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { SqliteUnitOfWork } from "../src/adapters/storage/SqliteBookDuplicateRepository.js";
import { Tags } from "../src/use-cases/Tags.js";
import { ConflictError, NotFoundError } from "../src/domain/errors.js";
import type { Book } from "../src/ports/index.js";

const databases: Db[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const book = (id: string): Book => ({
  id, title: `Book ${id}`, author: "", format: "epub", path: `/library/${id}.epub`, cover_path: null,
  size: 1, added_at: 1, source_id: null, mtime: 1, status: "ready",
});

const setup = () => {
  const db = openDb(":memory:");
  databases.push(db);
  const books = new SqliteBookRepository(db);
  books.save(book("b1"));
  books.save(book("b2"));
  let sequence = 0;
  const tags = new Tags(
    new SqliteTagRepository(db),
    new SqliteBookListQuery(db),
    new SqliteUnitOfWork(db),
    { now: () => 1_000 },
    { next: () => `tag-${++sequence}` },
  );
  return { db, books, tags };
};

describe("Tags by name (MCP bulk writes)", () => {
  it("resolves case-insensitive names, creates missing tags and applies in one transaction", () => {
    const x = setup();
    const result = x.tags.addByNames(["b1", "b2", "b1"], ["Focus", "focus", "New"]);
    expect(result).toEqual({ matched: 2, added: 4, createdTags: ["Focus", "New"] });
    const tags = x.tags.list();
    expect(tags.map((tag) => tag.name)).toEqual(["Focus", "New"]);
    expect(tags.every((tag) => tag.color === "gray")).toBe(true);
    expect(tags.map((tag) => tag.count)).toEqual([2, 2]);
  });

  it("accepts existing ids and leaves books untouched on a missing id", () => {
    const x = setup();
    const created = x.tags.addByNames(["b1"], ["Focus"]).createdTags[0]!;
    const tagId = x.tags.list().find((tag) => tag.name === created)!.id;
    expect(x.tags.addByNames(["b2"], [tagId])).toMatchObject({ matched: 1, added: 1, createdTags: [] });
    const count = x.tags.list().length;
    expect(() => x.tags.addByNames(["b1", "missing"], ["Rollback"])).toThrowError(NotFoundError);
    expect(x.tags.list()).toHaveLength(count);
  });

  it("removes only existing tags and names, keeping the tag itself", () => {
    const x = setup();
    x.tags.addByNames(["b1", "b2"], ["Focus", "Later"]);
    expect(x.tags.removeByNames(["b1"], ["focus"])).toEqual({ matched: 1, removed: 1 });
    expect(x.tags.list().find((tag) => tag.name === "Focus")?.count).toBe(1);
    expect(() => x.tags.removeByNames(["b1"], ["Missing"])).toThrowError(NotFoundError);
  });

  it("rolls back the whole batch when a book would exceed the per-book tag limit", () => {
    const x = setup();
    for (let batch = 0; batch < 3; batch++) {
      const names = Array.from({ length: batch === 2 ? 9 : 20 }, (_, index) => `Tag ${batch * 20 + index}`);
      x.tags.addByNames(["b1"], names);
    }
    expect(x.tags.list().filter((tag) => tag.count > 0)).toHaveLength(49);
    expect(() => x.tags.addByNames(["b1"], ["New One", "New Two"])).toThrowError(ConflictError);
    const names = x.tags.list().map((tag) => tag.name);
    expect(names).not.toContain("New One");
    expect(names).not.toContain("New Two");
    expect(x.tags.list().filter((tag) => tag.count > 0)).toHaveLength(49);
  });
});
