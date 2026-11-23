import { parentPort } from "node:worker_threads";

import Database from "better-sqlite3";

import { safeErrorType } from "../logging/safeError.js";

/**
 * Transient warm-up worker. It reads the FTS5 shadow tables page by page so the OS page
 * cache holds the retrieval working set before a query needs it, with a connection of its
 * own: an open iterator on the query worker would pin that worker's snapshot and make its
 * reads stale. The controller terminates this thread when the pass ends or pauses, so an
 * idle server pays nothing for it.
 *
 * Reads are sliced: the parent asks for a byte budget, the worker pulls rows until the
 * budget is spent and answers with the bytes read. That gives the parent a pause point at
 * every slice (a query, chat stream, scan or ingestion aborts within one slice) and keeps
 * the duty cycle under control. `dbstat` walks one named b-tree per pass; without it, the
 * FTS data blobs are read directly.
 */

export interface WarmupOpenRequest {
  type: "open";
  file: string;
  /** Shadow tables in priority order; the parent owns the policy. */
  tables: string[];
  /** Test seam: exercise the block-reading path even when `dbstat` exists. */
  fallback?: boolean;
}

export interface WarmupSliceRequest {
  type: "slice";
  id: number;
  budgetBytes: number;
}

export type WarmupRequest =
  | WarmupOpenRequest
  | WarmupSliceRequest
  | { type: "abort" }
  | { type: "close" };

export type WarmupResponse =
  | { type: "opened"; dbstat: boolean }
  | { type: "slice"; id: number; bytes: number; table: string | null; done: boolean }
  | { type: "aborted" }
  | { type: "error"; id: number; errorType: string };

let db: Database.Database | null = null;
let hasDbstat = false;
let tables: string[] = [];
let tableIndex = 0;
let currentTable: string | null = null;
let pages: Iterator<number> | null = null;

function openReadOnly(file: string): Database.Database {
  const handle = new Database(file, { readonly: true, fileMustExist: true });
  handle.pragma("busy_timeout = 5000");
  handle.pragma("temp_store = MEMORY");
  // The goal is the OS page cache; a large pager cache would only add RSS in a small
  // container and duplicate the same pages.
  handle.pragma("cache_size = -2048");
  handle.pragma("mmap_size = 0");
  return handle;
}

function supportsDbstat(handle: Database.Database): boolean {
  try {
    handle.prepare("SELECT 1 FROM dbstat LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/** One row per b-tree page; fetching it brings the page through the pager into the cache. */
function* pageBytes(table: string): Generator<number> {
  if (!db) return;
  const statement = db.prepare("SELECT pgsize AS bytes FROM dbstat WHERE name = ?");
  for (const row of statement.iterate(table) as Iterable<{ bytes: number }>) yield row.bytes;
}

/** Fallback without `dbstat`: read the inverted-index blocks, which are most of the index. */
function* blockBytes(): Generator<number> {
  if (!db) return;
  const statement = db.prepare("SELECT block FROM chunks_fts_data");
  for (const row of statement.iterate() as Iterable<{ block: Buffer }>) yield row.block.byteLength;
}

function openPages(table: string): Iterator<number> | null {
  if (!db) return null;
  if (hasDbstat) return pageBytes(table);
  if (table === "chunks_fts_data") return blockBytes();
  // idx/docsize are small and only addressable through dbstat; skipping them is harmless.
  return null;
}

function release(): void {
  // `return()` finalizes the prepared statement and the read transaction it holds.
  pages?.return?.();
  pages = null;
}

function readSlice(budgetBytes: number): { bytes: number; table: string | null; done: boolean } {
  let bytes = 0;
  while (bytes < budgetBytes) {
    if (!pages) {
      if (tableIndex >= tables.length) return { bytes, table: currentTable, done: true };
      currentTable = tables[tableIndex++] ?? null;
      if (currentTable === null) continue;
      pages = openPages(currentTable);
      if (!pages) continue;
    }
    const next = pages.next();
    if (next.done) {
      pages = null;
      continue;
    }
    bytes += next.value;
  }
  return { bytes, table: currentTable, done: tableIndex >= tables.length && pages === null };
}

const port = requireParentPort(parentPort);

function requireParentPort(value: typeof parentPort): NonNullable<typeof parentPort> {
  if (!value) throw new Error("The warm-up worker must run inside a worker thread");
  return value;
}

function post(message: WarmupResponse): void {
  port.postMessage(message);
}

function handle(message: WarmupRequest): void {
  switch (message.type) {
    case "open":
      release();
      db?.close();
      db = openReadOnly(message.file);
      hasDbstat = message.fallback === true ? false : supportsDbstat(db);
      tables = [...message.tables];
      tableIndex = 0;
      currentTable = null;
      post({ type: "opened", dbstat: hasDbstat });
      return;
    case "slice": {
      const result = readSlice(Math.max(1, message.budgetBytes));
      post({ type: "slice", id: message.id, bytes: result.bytes, table: result.table, done: result.done });
      return;
    }
    case "abort":
      release();
      // A new pass always starts from the first table.
      tableIndex = 0;
      currentTable = null;
      post({ type: "aborted" });
      return;
    case "close":
      release();
      db?.close();
      db = null;
      process.exit(0);
  }
}

port.on("message", (message: WarmupRequest) => {
  try {
    handle(message);
  } catch (error) {
    // One fixed shape: the error class only, never a path or SQL text.
    post({ type: "error", id: message.type === "slice" ? message.id : -1, errorType: safeErrorType(error) });
  }
});
