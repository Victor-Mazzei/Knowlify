import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { SqliteBlobVectorStore } from "../src/adapters/storage/SqliteBlobVectorStore.js";
import { SqlitePassageRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqlitePassageQueryStore } from "../src/adapters/storage/SqlitePassageQueryStore.js";
import { SearchTimeoutError, SearchWorkerStore } from "../src/adapters/search/SearchWorkerStore.js";

const roots: string[] = [];
const databases: Db[] = [];
const stores: SearchWorkerStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface SeedChunk {
  text: string;
  page: number | null;
  section: string | null;
  vector: number[] | null;
}

function addBook(db: Db, id: string, chunks: SeedChunk[]): void {
  db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES (?,?,'A','pdf',?,1,1,'src',1,'ready')`).run(id, `Title ${id}`, `/${id}.pdf`);
  db.prepare(`INSERT INTO book_index (book_id,state,priority,chunk_count,requested_at,index_version)
    VALUES (?,'ready',0,?,1,'1|lexical')`).run(id, chunks.length);
  const insertChunk = db.prepare(
    "INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES (?,?,?,?,?)",
  );
  const insertVector = db.prepare("INSERT INTO chunk_vectors (chunk_id,book_id,vec) VALUES (?,?,?)");
  chunks.forEach((chunk, ordinal) => {
    const result = insertChunk.run(id, ordinal, chunk.text, chunk.page, chunk.section);
    if (chunk.vector) {
      insertVector.run(Number(result.lastInsertRowid), id, Buffer.from(new Float32Array(chunk.vector).buffer));
    }
  });
}

/** A real database file both the in-process store and the worker can open. */
function seedDb(): Db {
  const root = tempRoot("knowlify-search-worker-");
  const db = openDb(join(root, "knowlify.db"));
  databases.push(db);
  addBook(db, "book-a", [
    { text: "deep work and attention", page: 1, section: "One", vector: [1, 0] },
    { text: "shallow notes about habits", page: 2, section: "Two", vector: [0.6, 0.8] },
  ]);
  addBook(db, "book-b", [
    { text: "deep focus practice", page: 3, section: null, vector: [0, 1] },
  ]);
  addBook(db, "book-c", [
    { text: "unrelated material", page: null, section: null, vector: [1, 0] },
  ]);
  return db;
}

function inProcessStore(db: Db): SqlitePassageQueryStore {
  return new SqlitePassageQueryStore(new SqlitePassageRepository(db), new SqliteBlobVectorStore(db));
}

function workerStore(db: Db, timeoutMs = 5_000): SearchWorkerStore {
  const store = new SearchWorkerStore({ file: db.name, timeoutMs });
  stores.push(store);
  return store;
}

describe("SearchWorkerStore", () => {
  it("serves lexical search, hydration, exact vectors and the vector count from a file database", async () => {
    const db = seedDb();
    const store = workerStore(db);

    const lexical = await store.searchLexical("deep work", 4);
    // "work" is rare (1 row) and "deep" is common: the AND+rare rule returns the passage
    // with both, not the deep-only passage.
    expect(lexical).toHaveLength(1);

    const views = await store.hydrate(lexical.map((hit) => hit.passageId));
    expect(views.map((view) => view.text)).toEqual(["deep work and attention"]);
    const top = views[0]!;
    expect(top).toMatchObject({ page: 1, section: "One", bookTitle: "Title book-a" });

    const nearest = await store.nearest(new Float32Array([1, 0]), 4);
    expect(nearest[0]!.score).toBeCloseTo(1, 6);
    expect(nearest.map((hit) => hit.passageId)).toContain(top.passageId);
    expect(await store.vectorCount()).toBe(4);
  });

  it("matches the in-process store on ranking, book filters, hydration order and vectors", async () => {
    const db = seedDb();
    const memory = inProcessStore(db);
    const worker = workerStore(db);

    const [memoryLexical, workerLexical] = await Promise.all([
      memory.searchLexical("deep", 4),
      worker.searchLexical("deep", 4),
    ]);
    expect(workerLexical).toEqual(memoryLexical);
    expect(workerLexical).toHaveLength(2);
    expect(workerLexical[0]!.rank).toBeLessThanOrEqual(workerLexical[1]!.rank);

    const [memoryFiltered, workerFiltered] = await Promise.all([
      memory.searchLexical("deep", 4, "book-b"),
      worker.searchLexical("deep", 4, "book-b"),
    ]);
    expect(workerFiltered).toEqual(memoryFiltered);
    expect(workerFiltered).toHaveLength(1);

    const ids = [memoryLexical[1]!.passageId, memoryLexical[0]!.passageId];
    const [memoryViews, workerViews] = await Promise.all([memory.hydrate(ids), worker.hydrate(ids)]);
    expect(workerViews).toEqual(memoryViews);
    // Hydration keeps the requested order, not the chunk order.
    expect(workerViews.map((view) => view.passageId)).toEqual(ids);

    const query = new Float32Array([1, 0]);
    const memoryNearest = await memory.nearest(query, 3, { bookIds: ["book-a", "book-c"] });
    const workerNearest = await worker.nearest(query, 3, { bookIds: ["book-a", "book-c"] });
    expect(workerNearest.map((hit) => hit.passageId)).toEqual(memoryNearest.map((hit) => hit.passageId));
    workerNearest.forEach((hit, index) => expect(hit.score).toBeCloseTo(memoryNearest[index]!.score, 10));

    const sampled = await worker.nearest(query, 3, { maxVectors: 2 });
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled.length).toBeLessThanOrEqual(2);
    const memorySampled = await memory.nearest(query, 3, { maxVectors: 2 });
    expect(sampled).toEqual(memorySampled);
  });

  it("correlates concurrent requests on the same worker", async () => {
    const db = seedDb();
    const memory = inProcessStore(db);
    const worker = workerStore(db);
    const query = new Float32Array([1, 0]);
    const lexicalIds = (await memory.searchLexical("deep", 4)).map((hit) => hit.passageId);

    const [deep, focus, unrelated, hydrated, nearest, sampled, count] = await Promise.all([
      worker.searchLexical("deep", 4),
      worker.searchLexical("focus", 4, "book-b"),
      worker.searchLexical("unrelated", 4),
      worker.hydrate(lexicalIds),
      worker.nearest(query, 3),
      worker.nearest(query, 3, { bookIds: ["book-c"] }),
      worker.vectorCount(),
    ]);

    expect(deep).toEqual(await memory.searchLexical("deep", 4));
    expect(focus).toEqual(await memory.searchLexical("focus", 4, "book-b"));
    expect(unrelated).toEqual(await memory.searchLexical("unrelated", 4));
    expect(hydrated).toEqual(await memory.hydrate(lexicalIds));
    expect(nearest).toEqual(await memory.nearest(query, 3));
    expect(sampled.map((hit) => hit.passageId)).toEqual(
      (await memory.nearest(query, 3, { bookIds: ["book-c"] })).map((hit) => hit.passageId),
    );
    expect(count).toBe(4);
  });

  it("invalidates the df cache after a writer commit", async () => {
    const db = seedDb();
    const worker = workerStore(db);
    expect(await worker.searchLexical("rareword", 4)).toEqual([]);

    db.prepare(
      "INSERT INTO chunks (book_id, ordinal, text, page, section) VALUES ('book-a', 99, 'rareword attention', NULL, NULL)",
    ).run();
    const hits = await worker.searchLexical("rareword", 4);
    expect(hits).toHaveLength(1);
  });

  it("degrades a stuck worker with a timeout instead of waiting forever", async () => {
    const root = tempRoot("knowlify-search-stuck-");
    const workerPath = join(root, "stuck.worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      "parentPort.on(\"message\", () => {});",
    ].join("\n"));
    const log = { messages: [] as string[] };
    const store = new SearchWorkerStore({
      file: join(root, "unused.db"),
      workerPath,
      timeoutMs: 25,
      log: (message) => log.messages.push(message),
    });
    stores.push(store);

    await expect(store.searchLexical("secretneedle question", 4)).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(log.messages).toContain("search worker timed out after 25 ms (lexical); discarding the worker");
    // One fixed line: the operation and the ceiling, never the question.
    expect(JSON.stringify(log.messages)).not.toContain("secretneedle");
  });

  it("recovers after a timed-out request by discarding and recreating the worker", async () => {
    const root = tempRoot("knowlify-search-recovery-");
    const marker = join(root, "first-request.marker");
    const workerPath = join(root, "recover.worker.mjs");
    await writeFile(workerPath, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { parentPort } from "node:worker_threads";',
      "const marker = process.env.KNOWLIFY_SEARCH_RECOVERY_MARKER;",
      'parentPort.on("message", (message) => {',
      '  if (message.type === "close") process.exit(0);',
      '  if (message.type !== "lexical") return;',
      '  if (marker && !existsSync(marker)) { writeFileSync(marker, "1"); return; }',
      '  parentPort.postMessage({ type: "lexical", id: message.id, hits: [{ passageId: 7, rank: -1 }] });',
      "});",
    ].join("\n"));
    process.env.KNOWLIFY_SEARCH_RECOVERY_MARKER = marker;
    const store = new SearchWorkerStore({ file: join(root, "unused.db"), workerPath, timeoutMs: 1_000 });
    stores.push(store);
    try {
      await expect(store.searchLexical("anything", 4)).rejects.toBeInstanceOf(SearchTimeoutError);
      // The timed-out worker is terminated; the next call starts a fresh one and succeeds.
      await expect(store.searchLexical("anything", 4)).resolves.toEqual([{ passageId: 7, rank: -1 }]);
    } finally {
      delete process.env.KNOWLIFY_SEARCH_RECOVERY_MARKER;
    }
  });
});
