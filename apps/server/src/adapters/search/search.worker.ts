import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import type { Db } from "../storage/db.js";
import { SqliteBlobVectorStore } from "../storage/SqliteBlobVectorStore.js";
import { SqlitePassageRepository } from "../storage/SqliteKnowledgeRepositories.js";
import { safeErrorType } from "../logging/safeError.js";
import type { SearchWorkerRequest, SearchWorkerResponse } from "./protocol.js";

/**
 * Read-only retrieval worker: FTS5 ranking and the exact vector scan are CPU and page
 * heavy, so they run here with their own connection and the API event loop only waits
 * for messages. The connection never writes; the main process keeps ownership of the
 * database schema, migrations and WAL checkpointing.
 */
function openReadOnly(file: string): Db {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  // WAL readers are not blocked by writers (measured with an open write transaction), so
  // this only covers exclusive/schema locks; it stays below the 8 s request ceiling.
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
  // No cache_size/mmap_size: a 200k-chunk lab measured no gain up to 256 MiB of cache and
  // a bounded mmap was slower than pread on cold scans; the OS page cache serves the index.
  return db;
}

const port = requireParentPort(parentPort);

function requireParentPort(value: typeof parentPort): NonNullable<typeof parentPort> {
  if (!value) throw new Error("The search worker must run inside a worker thread");
  return value;
}

const { file } = workerData as { file: string };
const db = openReadOnly(file);
const passages = new SqlitePassageRepository(db);
// This connection never writes, so `data_version` invalidates the count on every commit
// by the API process; the per-search COUNT(*) disappears from the hot path.
const vectors = new SqliteBlobVectorStore(db, { cacheCount: true });

function post(message: SearchWorkerResponse): void {
  port.postMessage(message);
}

function handle(message: SearchWorkerRequest): void {
  switch (message.type) {
    case "lexical":
      post({ type: "lexical", id: message.id, hits: passages.searchLexical(message.q, message.limit, message.bookId) });
      return;
    case "hydrate":
      post({ type: "hydrate", id: message.id, views: passages.hydrate(message.ids) });
      return;
    case "nearest":
      void vectors.nearest(message.vector, message.limit, message.filter).then(
        (hits) => post({ type: "nearest", id: message.id, hits }),
        (error: unknown) => post({ type: "error", id: message.id, errorType: safeErrorType(error) }),
      );
      return;
    case "vector-count":
      post({ type: "vector-count", id: message.id, count: vectors.count() });
      return;
    case "close":
      db.close();
      process.exit(0);
  }
}

port.on("message", (message: SearchWorkerRequest) => {
  try {
    handle(message);
  } catch (error) {
    post({ type: "error", id: message.type === "close" ? -1 : message.id, errorType: safeErrorType(error) });
  }
});
