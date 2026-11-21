import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import {
  booksPageSql,
  readingSegmentSql,
  SqliteBookListQuery,
  type NormalizedQuery,
} from "../src/adapters/storage/SqliteBookListQuery.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";

const TOTAL = 11_000;
const SECRET = "reading-sort-test-secret";
const root = await mkdtemp(join(tmpdir(), "knowlify-reading-sort-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");

let db: Db;
let reader: SqliteBookListQuery;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

const idAt = (index: number): string => `book-${String(index).padStart(5, "0")}`;
const addedAtOf = (index: number): number => 10_000 - Math.floor(index / 10);
const updatedAtOf = (index: number): number => 20_000 - Math.floor(index / 7);
const percentageOf = (index: number): number | null => {
  const mod = index % 20;
  if (mod === 0) return 0.00499;
  if (mod === 1) return 0.005;
  if (mod === 2) return 0.9899;
  if (mod === 3) return 0.99;
  if (index % 4 === 0) return 0.5;
  return null;
};
const isReading = (index: number): boolean => {
  const percentage = percentageOf(index);
  return percentage !== null && percentage >= 0.005 && percentage < 0.99;
};

const referenceOrder = (): string[] => {
  const reading = Array.from({ length: TOTAL }, (_, index) => index).filter(isReading)
    .sort((a, b) => updatedAtOf(b) - updatedAtOf(a) || (idAt(a) < idAt(b) ? 1 : -1));
  const rest = Array.from({ length: TOTAL }, (_, index) => index).filter((index) => !isReading(index))
    .sort((a, b) => addedAtOf(b) - addedAtOf(a) || (idAt(a) < idAt(b) ? 1 : -1));
  return [...reading, ...rest].map(idAt);
};

function seed(database: Db): void {
  const insert = database.prepare(
    `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status)
     VALUES (?,?,?,?,?,NULL,?,?,?,NULL,'ready')`,
  );
  const progress = database.prepare("INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)");
  const note = database.prepare("INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',1,1)");
  const indexRow = database.prepare("INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at) VALUES (?, 'ready', 0, 0, 1)");
  database.transaction(() => {
    database.prepare("INSERT INTO sources (id,path) VALUES ('src','/library'),('src2','/library2')").run();
    database.prepare("INSERT INTO tags (id,name,name_key,color,created_at) VALUES ('tag-rare','Rare','rare','blue',1),('tag-common','Common','common','green',1)").run();
    const tag = database.prepare("INSERT INTO book_tags (book_id,tag_id,created_at) VALUES (?,?,1)");
    for (let index = 0; index < TOTAL; index += 1) {
      insert.run(
        idAt(index),
        index % 100 === 0 ? `Book ${index} História` : `Book ${index}`,
        `Author ${index % 50}`,
        index % 2 === 0 ? "pdf" : "epub",
        `/library/${idAt(index)}.pdf`,
        1_000 + index,
        addedAtOf(index),
        index % 4 === 1 ? "src2" : index % 4 === 2 ? null : "src",
      );
      const percentage = percentageOf(index);
      if (percentage !== null) progress.run(idAt(index), "epubcfi(/6)", percentage, updatedAtOf(index));
      if (index % 5 === 0) note.run(`note-${index}`, idAt(index));
      if (index % 7 === 3) indexRow.run(idAt(index));
      if (index % 10 === 0) tag.run(idAt(index), "tag-common");
      if (index === 4_999) tag.run(idAt(index), "tag-rare");
    }
  })();
}

beforeAll(async () => {
  db = openDb(join(root, "knowledge.db"));
  seed(db);
  reader = new SqliteBookListQuery(db, SECRET);
  ({ app } = await buildApp(db));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

const walk = (limit: number, query: Omit<NormalizedQuery, "limit"> = { sort: "reading", order: "desc" }): string[] => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = reader.page({ ...query, limit, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.rows.map((row) => row.book.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return ids;
};

const details = (query: NormalizedQuery, segment?: 0 | 1, anchor?: { sortValue: number | string; id: string; segment?: 0 | 1 }): string[] => {
  if (segment !== undefined) {
    const { sql, params } = readingSegmentSql(segment, query, anchor);
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params, query.limit + 1) as { detail: string }[])
      .map((row) => row.detail);
  }
  const { sql, params } = booksPageSql(query, anchor);
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params, query.limit + 1) as { detail: string }[])
    .map((row) => row.detail);
};

describe("sort=reading", () => {
  it("pages 11k rows in 1/2/60/200-sized pages without duplicates or omissions", () => {
    const reference = referenceOrder();
    for (const limit of [1, 2, 60, 200]) {
      expect(walk(limit)).toEqual(reference);
    }
  }, 30_000);

  it("orders in-progress first by last read, then the rest by added_at, with id tie-breaks", () => {
    const page = reader.page({ limit: 60, sort: "reading", order: "desc" });
    expect(page.rows.map((row) => row.book.id).slice(0, 5)).toEqual(referenceOrder().slice(0, 5));
    expect(page.rows.every((row) => row.segment === 0)).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("crosses the segment boundary and keeps a segment-0 cursor when the page ends there", () => {
    // Keep the page under the 200 limit by filtering to one author, whose reading subset
    // still has ties and a non-trivial size.
    const readingCount = Array.from({ length: TOTAL }, (_, index) => index)
      .filter((index) => index % 50 === 4 && isReading(index)).length;
    expect(readingCount).toBeGreaterThan(0);
    expect(readingCount).toBeLessThanOrEqual(200);
    const first = reader.page({ limit: readingCount, sort: "reading", order: "desc", author: "Author 4" });
    expect(first.rows).toHaveLength(readingCount);
    expect(first.rows.every((row) => row.segment === 0)).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    // The next page starts at segment 1 regardless of how many reading rows remain unseen.
    const second = reader.page({ limit: 5, sort: "reading", order: "desc", author: "Author 4", cursor: first.nextCursor! });
    expect(second.rows.length).toBeGreaterThan(0);
    expect(second.rows.every((row) => row.segment === 1)).toBe(true);
    expect(second.rows[0]!.book.id).not.toBe(first.rows[0]!.book.id);
  });

  it("handles an empty segment 0 and books without progress", () => {
    // read=finished excludes every reading row, so segment 0 is skipped entirely.
    const finished = reader.page({ limit: 200, sort: "reading", order: "desc", read: ["finished"] });
    expect(finished.rows.length).toBeGreaterThan(0);
    expect(finished.rows.every((row) => row.segment === 1)).toBe(true);
    const referenceFinished = Array.from({ length: TOTAL }, (_, index) => index)
      .filter((index) => percentageOf(index) !== null && percentageOf(index)! >= 0.99)
      .sort((a, b) => addedAtOf(b) - addedAtOf(a) || (idAt(a) < idAt(b) ? 1 : -1))
      .map(idAt);
    expect(finished.rows.map((row) => row.book.id)).toEqual(referenceFinished.slice(0, 200));
  });

  it("respects the percentage edges 0.00499/0.005/0.9899/0.99", () => {
    const ids = new Set(walk(200));
    expect(ids.size).toBe(TOTAL);
    for (let index = 0; index < 80; index += 1) {
      const percentage = percentageOf(index);
      const expected = percentage !== null && percentage >= 0.005 && percentage < 0.99;
      expect(ids.has(idAt(index))).toBe(true);
      expect(isReading(index)).toBe(expected);
    }
  });

  it("keeps total equal to the added total, with and without filters", async () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const reading = (await get("/api/books?limit=5&sort=reading")).json();
    const added = (await get("/api/books?limit=5")).json();
    expect(reading.total).toBe(TOTAL);
    expect(reading.total).toBe(added.total);
    const filteredReading = (await get("/api/books?limit=5&sort=reading&format=pdf&tag=tag-common")).json();
    const filteredAdded = (await get("/api/books?limit=5&format=pdf&tag=tag-common")).json();
    expect(filteredReading.total).toBe(filteredAdded.total);
  });

  it("combines sort=reading with every list filter", () => {
    const cases: Array<[Omit<NormalizedQuery, "limit">, (index: number) => boolean]> = [
      [{ sort: "reading", order: "desc", q: "História" }, (index) => index % 100 === 0],
      [{ sort: "reading", order: "desc", format: "pdf" }, (index) => index % 2 === 0],
      [{ sort: "reading", order: "desc", read: ["reading"] }, (index) => isReading(index)],
      [{ sort: "reading", order: "desc", read: ["unread"] }, (index) => percentageOf(index) === null || percentageOf(index)! < 0.005],
      [{ sort: "reading", order: "desc", read: ["finished"] }, (index) => percentageOf(index) !== null && percentageOf(index)! >= 0.99],
      [{ sort: "reading", order: "desc", source: ["src"] }, (index) => index % 4 !== 1 && index % 4 !== 2],
      [{ sort: "reading", order: "desc", index: ["ready"] }, (index) => index % 7 === 3],
      [{ sort: "reading", order: "desc", notes: true }, (index) => index % 5 === 0],
      [{ sort: "reading", order: "desc", author: "Author 7" }, (index) => index % 50 === 7],
      [{ sort: "reading", order: "desc", tag: ["tag-common"] }, (index) => index % 10 === 0],
      [{ sort: "reading", order: "desc", tag: ["tag-rare", "tag-common"] }, (index) => index % 10 === 0 || index === 4_999],
    ];
    for (const [query, predicate] of cases) {
      const expected: string[] = [];
      const reading = Array.from({ length: TOTAL }, (_, index) => index).filter((index) => isReading(index) && predicate(index))
        .sort((a, b) => updatedAtOf(b) - updatedAtOf(a) || (idAt(a) < idAt(b) ? 1 : -1));
      const rest = Array.from({ length: TOTAL }, (_, index) => index).filter((index) => !isReading(index) && predicate(index))
        .sort((a, b) => addedAtOf(b) - addedAtOf(a) || (idAt(a) < idAt(b) ? 1 : -1));
      expected.push(...reading.map(idAt), ...rest.map(idAt));
      expect(walk(200, query), JSON.stringify(query)).toEqual(expected);
    }
  });

  it("rejects cursors from another sort/filter, tampered signatures and order=asc", async () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
    const first = reader.page({ limit: 5, sort: "reading", order: "desc" });
    const cursor = first.nextCursor!;
    for (const url of [
      `/api/books?limit=5&sort=added&cursor=${encodeURIComponent(cursor)}`,
      `/api/books?limit=5&sort=reading&cursor=${encodeURIComponent(cursor)}&format=pdf`,
      `/api/books?limit=5&sort=reading&order=asc`,
      `/api/books?limit=5&sort=reading&cursor=not-a-cursor`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
    }
    const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;
    expect((await get(`/api/books?limit=5&sort=reading&cursor=${encodeURIComponent(tampered)}`)).statusCode).toBe(400);

    // A correctly signed v1 cursor is still rejected by the version check.
    const v1Raw = Buffer.from(cursor, "base64url");
    const v1Body = v1Raw.subarray(0, v1Raw.length - 12);
    v1Body[0] = 1;
    const v1Signature = createHmac("sha256", SECRET).update(v1Body).digest().subarray(0, 12);
    const v1 = Buffer.concat([v1Body, v1Signature]).toString("base64url");
    expect((await get(`/api/books?limit=5&sort=reading&cursor=${encodeURIComponent(v1)}`)).statusCode).toBe(400);

    // Forge a signed cursor with segment 2: the decoder must reject the segment byte.
    const raw = Buffer.from(cursor, "base64url");
    const body = raw.subarray(0, raw.length - 12);
    const segmentOffset = 3 + 8;
    body[segmentOffset] = 2;
    const signature = createHmac("sha256", SECRET).update(body).digest().subarray(0, 12);
    const forged = Buffer.concat([body, signature]).toString("base64url");
    const response = await get(`/api/books?limit=5&sort=reading&cursor=${encodeURIComponent(forged)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "cursor is invalid" });
  });

  it("walks a deep reading page without a temporary B-tree, with and without filters", () => {
    const plans: string[][] = [
      details({ limit: 60, sort: "reading", order: "desc" }, 0),
      details({ limit: 60, sort: "reading", order: "desc" }, 1),
      details({ limit: 60, sort: "reading", order: "desc" }, 0, { sortValue: updatedAtOf(500), id: idAt(500), segment: 0 }),
      details({ limit: 60, sort: "reading", order: "desc" }, 1, { sortValue: addedAtOf(500), id: idAt(500), segment: 1 }),
      details({ limit: 60, sort: "reading", order: "desc", tag: ["tag-rare"] }, 1),
      details({ limit: 60, sort: "reading", order: "desc", tag: ["tag-common"] }, 0),
      details({ limit: 60, sort: "reading", order: "desc", read: ["finished"] }, 1),
      details({ limit: 60, sort: "reading", order: "desc", q: "Book", format: "pdf", source: ["src"] }, 1),
    ];
    for (const plan of plans) {
      const text = plan.join(" ");
      expect(text).not.toMatch(/TEMP B-TREE/);
      expect(text).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/);
    }
  });

  it("keeps every other sort free of temporary B-trees when combined with a tag filter", () => {
    const sorts: Array<{ sort: NormalizedQuery["sort"]; order: "asc" | "desc" }> = [
      { sort: "added", order: "desc" },
      { sort: "title", order: "asc" },
      { sort: "author", order: "asc" },
      { sort: "lastRead", order: "desc" },
    ];
    for (const tag of [["tag-rare"], ["tag-common"]]) {
      for (const { sort, order } of sorts) {
        const plan = details({ limit: 60, sort, order, tag }).join(" ");
        expect(plan, `${sort} ${tag[0]}`).not.toMatch(/TEMP B-TREE/);
      }
    }
    // Tag combined with the remaining filter dimensions in the same page query.
    for (const query of [
      { limit: 60, sort: "added", order: "desc", tag: ["tag-common"], read: ["reading"] },
      { limit: 60, sort: "added", order: "desc", tag: ["tag-common"], index: ["ready"], source: ["src"], notes: true },
      { limit: 60, sort: "title", order: "asc", tag: ["tag-rare"], read: ["finished"], index: ["error"] },
      { limit: 60, sort: "reading", order: "desc", tag: ["tag-common"], read: ["reading"], index: ["ready"], source: ["src"] },
    ] as NormalizedQuery[]) {
      expect(details(query).join(" "), JSON.stringify(query)).not.toMatch(/TEMP B-TREE/);
      if (query.sort === "reading") {
        expect(details(query, 0).join(" ")).not.toMatch(/TEMP B-TREE/);
        expect(details(query, 1).join(" ")).not.toMatch(/TEMP B-TREE/);
      }
    }
  });
});
