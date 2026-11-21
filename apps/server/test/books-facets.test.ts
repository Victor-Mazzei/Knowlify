import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBookFacets } from "../src/adapters/storage/SqliteBookFacets.js";
import { SqliteBookListQuery } from "../src/adapters/storage/SqliteBookListQuery.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import type { BookFilters, BookIndexStatus } from "../src/ports/index.js";
import type { IngestionRunner } from "../src/ports/knowledge.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-books-facets-"));
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.indexing.enabled = true;

type Status = "ready" | "error";
type IndexState = "ready" | "pending" | "error" | null;

interface Seed {
  id: string;
  format: "pdf" | "epub";
  addedAt: number;
  percentage: number | null;
  sourceId: string | null;
  status: Status;
  indexState: IndexState;
  notes: number;
  favorite: boolean;
}

const ROWS = 120;
const seeds: Seed[] = [];
for (let index = 0; index < ROWS; index += 1) {
  seeds.push({
    id: `book-${String(index).padStart(3, "0")}`,
    format: index % 3 === 0 ? "epub" : "pdf",
    addedAt: 1_000 + index,
    percentage: index % 5 === 0 ? 0.5 : index % 5 === 1 ? 0.99 : index % 5 === 2 ? 0.001 : null,
    sourceId: ["src-a", "src-b", null, "src-c"][index % 4]!,
    status: "ready",
    indexState: index % 7 === 0 ? "error" : index % 7 === 1 ? "pending" : index % 7 === 2 ? null : "ready",
    notes: index % 6 === 0 ? 1 : 0,
    favorite: index % 4 === 0,
  });
}

const statusOf = (seed: Seed): "unread" | "reading" | "finished" => {
  if (seed.percentage === null || seed.percentage < 0.005) return "unread";
  return seed.percentage >= 0.99 ? "finished" : "reading";
};

const indexStatusOf = (seed: Seed): BookIndexStatus | "none" => {
  if (seed.indexState === "ready") return "ready";
  if (seed.indexState === "error") return "error";
  if (seed.status === "error") return "none";
  return "pending";
};

const matches = (seed: Seed, filter: BookFilters): boolean => {
  if (filter.format && seed.format !== filter.format) return false;
  if (filter.read && !filter.read.includes(statusOf(seed))) return false;
  if (filter.index && !filter.index.includes(indexStatusOf(seed) as BookIndexStatus)) return false;
  if (filter.source && !filter.source.includes(seed.sourceId ?? "upload")) return false;
  if (filter.notes && seed.notes === 0) return false;
  if (filter.favorite === true && !seed.favorite) return false;
  return true;
};

const expectedCount = (filter: BookFilters): number => seeds.filter((seed) => matches(seed, filter)).length;

function seedDb(database: Db): void {
  const insertBook = database.prepare(
    `INSERT INTO books (id,title,author,format,path,cover_path,size,added_at,source_id,mtime,status,favorite)
     VALUES (?,?,?,?,?,NULL,?,?,?,NULL,?,?)`,
  );
  const insertIndex = database.prepare(
    "INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version) VALUES (?,?,0,0,?, '1|none')",
  );
  const insertProgress = database.prepare(
    "INSERT INTO web_progress (book_id,position,percentage,updated_at) VALUES (?,?,?,?)",
  );
  const insertNote = database.prepare(
    "INSERT INTO notes (id,book_id,location,label,quote,body,created_at,updated_at) VALUES (?,?,'','','','body',0,0)",
  );
  database.transaction(() => {
    for (const seed of seeds) {
      insertBook.run(
        seed.id, `Title ${seed.id}`, "Author", seed.format, `/library/${seed.id}.${seed.format}`,
        10, seed.addedAt, seed.sourceId, seed.status, seed.favorite ? 1 : 0,
      );
      if (seed.indexState !== null) insertIndex.run(seed.id, seed.indexState, seed.addedAt);
      if (seed.percentage !== null) insertProgress.run(seed.id, "pos", seed.percentage, seed.addedAt);
      for (let note = 0; note < seed.notes; note += 1) insertNote.run(`note-${seed.id}`, seed.id);
    }
    // src-empty never has a matching book; it must still appear with count 0.
    database.prepare(
      "INSERT INTO sources (id,path) VALUES ('src-a','/a'),('src-b','/b'),('src-c','/c'),('src-empty','/empty')",
    ).run();
  })();
}

const runner: IngestionRunner = {
  run: async () => ({ kind: "done", contentHash: "hash", chunkCount: 0, indexVersion: "1|none" }),
  embedQuery: async () => null,
  embeddings: () => ({ mode: "none", model: null, state: "off" }),
  indexVersion: () => "1|none",
  onEmbeddingsReady: () => {},
  close: async () => {},
};

let db: Db;
let reader: SqliteBookListQuery;
let facets: SqliteBookFacets;
let disabledApp: Awaited<ReturnType<typeof buildApp>>["app"];
let enabledApp: Awaited<ReturnType<typeof buildApp>>["app"];
const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

beforeAll(async () => {
  db = openDb(join(root, "knowledge.db"));
  seedDb(db);
  reader = new SqliteBookListQuery(db, "facets-test-secret");
  facets = new SqliteBookFacets(db);
  ({ app: disabledApp } = await buildApp(db));
  ({ app: enabledApp } = await buildApp(db, false, undefined, runner));
  await disabledApp.ready();
  await enabledApp.ready();
});

afterAll(async () => {
  await disabledApp.close();
  await enabledApp.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  disabledApp.inject({ method: "GET", url, headers: { ...auth, ...headers } });

const getEnabled = (url: string) =>
  enabledApp.inject({ method: "GET", url, headers: auth });

describe("GET /api/books/facets", () => {
  it("returns the disjunctive counts and an ETag", async () => {
    const response = await get("/api/books/facets");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-cache");
    expect(response.headers.vary).toBe("Authorization");
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    const body = response.json();
    expect(body).toEqual({
      total: ROWS,
      format: { pdf: seeds.filter((seed) => seed.format === "pdf").length, epub: seeds.filter((seed) => seed.format === "epub").length },
      read: {
        unread: seeds.filter((seed) => statusOf(seed) === "unread").length,
        reading: seeds.filter((seed) => statusOf(seed) === "reading").length,
        finished: seeds.filter((seed) => statusOf(seed) === "finished").length,
      },
      // buildApp without an ingestion runner reports indexing as disabled.
      index: null,
      source: [
        { id: "src-a", count: seeds.filter((seed) => seed.sourceId === "src-a").length },
        { id: "src-b", count: seeds.filter((seed) => seed.sourceId === "src-b").length },
        { id: "src-c", count: seeds.filter((seed) => seed.sourceId === "src-c").length },
        { id: "src-empty", count: 0 },
        { id: "upload", count: seeds.filter((seed) => seed.sourceId === null).length },
      ],
      // No tags exist in this seed; the facet still exposes an empty, stable list.
      tag: [],
      notes: { with: seeds.filter((seed) => seed.notes > 0).length },
      favorite: { with: seeds.filter((seed) => seed.favorite).length },
    });
  });

  it("ignores its own dimension and applies the other filters", async () => {
    const filters: BookFilters = {
      format: "pdf",
      read: ["reading", "finished"],
      index: ["ready", "error"],
      source: ["src-a", "src-b", "upload"],
    };
    const counts = facets.facets(filters, { indexingEnabled: true });
    expect(counts.total).toBe(expectedCount(filters));
    expect(counts.format.pdf).toBe(expectedCount({ ...filters, format: "pdf" }));
    expect(counts.format.epub).toBe(expectedCount({ ...filters, format: "epub" }));
    expect(counts.read.reading).toBe(expectedCount({ ...filters, read: ["reading"] }));
    expect(counts.read.unread).toBe(expectedCount({ ...filters, read: ["unread"] }));
    expect(counts.notes.with).toBe(expectedCount({ ...filters, notes: true }));
    expect(counts.favorite.with).toBe(expectedCount({ ...filters, favorite: true }));
    const sourceCount = (id: string) => counts.source.find((entry) => entry.id === id)?.count;
    expect(sourceCount("src-a")).toBe(expectedCount({ ...filters, source: ["src-a"] }));
    expect(sourceCount("src-b")).toBe(expectedCount({ ...filters, source: ["src-b"] }));
    expect(sourceCount("upload")).toBe(expectedCount({ ...filters, source: ["upload"] }));
    expect(sourceCount("src-empty")).toBe(0);
    expect(counts.index?.ready).toBe(expectedCount({ ...filters, index: ["ready"] }));
    expect(counts.index?.pending).toBe(expectedCount({ ...filters, index: ["pending"] }));
    expect(counts.index?.error).toBe(expectedCount({ ...filters, index: ["error"] }));
  });

  it("matches count() for the same filters", async () => {
    const cases: BookFilters[] = [
      {},
      { format: "epub" },
      { read: ["finished", "reading"] },
      { source: ["src-b", "src-c"] },
      { notes: true, format: "pdf" },
      { index: ["error"] },
    ];
    for (const filter of cases) {
      const counts = facets.facets(filter, { indexingEnabled: true });
      expect(counts.total).toBe(reader.count(filter));
      // Each bucket equals count() with the own filter replaced by that single value.
      expect(counts.format.pdf).toBe(reader.count({ ...filter, format: "pdf" }));
      expect(counts.read.finished).toBe(reader.count({ ...filter, read: ["finished"] }));
      expect(counts.index?.error).toBe(reader.count({ ...filter, index: ["error"] }));
      expect(counts.notes.with).toBe(reader.count({ ...filter, notes: true }));
      expect(counts.favorite.with).toBe(reader.count({ ...filter, favorite: true }));
    }
  });

  it("exposes index facets only when indexing is enabled", async () => {
    expect(facets.facets({}, { indexingEnabled: false }).index).toBeNull();
    const response = await get("/api/books/facets");
    expect(response.json().index).toBeNull();

    const enabled = await getEnabled("/api/books/facets");
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().index).toEqual({
      ready: expectedCount({ index: ["ready"] }),
      pending: expectedCount({ index: ["pending"] }),
      error: expectedCount({ index: ["error"] }),
    });
    const filtered = await getEnabled("/api/books/facets?index=error");
    expect(filtered.statusCode).toBe(200);
    // The index group ignores the index filter itself.
    expect(filtered.json().index).toEqual(enabled.json().index);
    expect(filtered.json().total).toBe(expectedCount({ index: ["error"] }));
    expect(filtered.json().format.pdf).toBe(expectedCount({ index: ["error"], format: "pdf" }));
    const page = await getEnabled("/api/books?limit=5&index=error");
    expect(page.statusCode).toBe(200);
    expect(page.json().items.every((book: { index: { state: string } }) => book.index.state === "error")).toBe(true);
  });

  it("answers 304 when the ETag matches", async () => {
    const first = await get("/api/books/facets?format=pdf");
    const etag = first.headers.etag as string;
    const notModified = await get("/api/books/facets?format=pdf", { "if-none-match": etag });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers.etag).toBe(etag);

    const weak = await get("/api/books/facets?format=pdf", { "if-none-match": `W/${etag}` });
    expect(weak.statusCode).toBe(304);
    const star = await get("/api/books/facets?format=pdf", { "if-none-match": "*" });
    expect(star.statusCode).toBe(304);
    const changed = await get("/api/books/facets?format=epub");
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it("validates input and authentication", async () => {
    const anonymous = await disabledApp.inject({ method: "GET", url: "/api/books/facets" });
    expect(anonymous.statusCode).toBe(401);
    for (const url of [
      "/api/books/facets?read=bogus",
      "/api/books/facets?source=bad!id",
      "/api/books/facets?notes=2",
      "/api/books/facets?favorite=0",
      "/api/books/facets?favorite=true",
      "/api/books/facets?format=cbz",
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
    }
    const disabled = await get("/api/books/facets?index=ready");
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({ message: "indexing is disabled" });
  });

  it("serves the static route instead of /books/:id", async () => {
    const response = await get("/api/books/facets");
    expect(response.statusCode).toBe(200);
    expect(response.json().total).toBe(ROWS);
    const detail = await get("/api/books/facets?limit=5");
    expect(detail.statusCode).toBe(200);
  });
});
