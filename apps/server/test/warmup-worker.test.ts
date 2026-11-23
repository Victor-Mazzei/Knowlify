import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import type { WarmupRequest, WarmupResponse } from "../src/adapters/search/warmup.worker.js";

const roots: string[] = [];
const databases: Db[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate().catch(() => {});
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const workerPath = fileURLToPath(new URL("../src/adapters/search/warmup.worker.ts", import.meta.url));

function seedDb(chunks: number): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-warmup-worker-"));
  roots.push(root);
  const file = join(root, "knowlify.db");
  const db = openDb(file);
  databases.push(db);
  db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES ('b','Title','A','pdf','/b.pdf',1,1,'s',1,'ready')`).run();
  db.prepare("DROP TRIGGER chunks_ai").run();
  const insert = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES ('b',?,?,NULL,NULL)");
  const words = "deep work attention focus memory habit reading system process learning practice".split(" ");
  db.transaction(() => {
    for (let ordinal = 0; ordinal < chunks; ordinal += 1) {
      insert.run(ordinal, Array.from({ length: 40 }, (_, index) => words[(ordinal + index) % words.length]).join(" "));
    }
  })();
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  return file;
}

function spawn(): Worker {
  const worker = new Worker(workerPath, { execArgv: ["--import", "tsx"] });
  workers.push(worker);
  return worker;
}

function ask(worker: Worker, request: WarmupRequest): Promise<WarmupResponse> {
  return new Promise<WarmupResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not answer")), 10_000);
    timer.unref();
    const onMessage = (message: WarmupResponse): void => {
      if (request.type === "slice" && message.type === "slice" && message.id !== request.id) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(message);
    };
    worker.on("message", onMessage);
    worker.postMessage(request);
  });
}

describe("warm-up worker", () => {
  it("reads the FTS shadow tables in order through dbstat", async () => {
    const file = seedDb(400);
    const worker = spawn();
    expect(await ask(worker, {
      type: "open",
      file,
      tables: ["chunks_fts_idx", "chunks_fts_docsize", "chunks_fts_data"],
    })).toEqual({ type: "opened", dbstat: true });

    let id = 0;
    let total = 0;
    const tables = new Set<string>();
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      id += 1;
      const reply = await ask(worker, { type: "slice", id, budgetBytes: 4096 });
      expect(reply.type).toBe("slice");
      if (reply.type !== "slice") return;
      total += reply.bytes;
      if (reply.table) tables.add(reply.table);
      if (reply.done) break;
    }
    expect(total).toBeGreaterThan(0);
    expect(tables).toContain("chunks_fts_data");
    expect(tables).toContain("chunks_fts_docsize");
    await worker.terminate();
  });

  it("stops a slice at the budget and can be aborted", async () => {
    const file = seedDb(400);
    const worker = spawn();
    await ask(worker, { type: "open", file, tables: ["chunks_fts_idx", "chunks_fts_docsize", "chunks_fts_data"] });
    const first = await ask(worker, { type: "slice", id: 1, budgetBytes: 4096 });
    expect(first).toMatchObject({ type: "slice", id: 1, done: false });
    expect(first.type === "slice" ? first.bytes : 0).toBeGreaterThanOrEqual(4096);
    expect(await ask(worker, { type: "abort" })).toEqual({ type: "aborted" });
    // A new pass always starts from the first table again.
    const restarted = await ask(worker, { type: "slice", id: 2, budgetBytes: 4096 });
    expect(restarted).toMatchObject({ type: "slice", id: 2, table: "chunks_fts_idx" });
    await worker.terminate();
  });

  it("falls back to reading the index blocks without dbstat", async () => {
    const file = seedDb(400);
    const worker = spawn();
    expect(await ask(worker, {
      type: "open",
      file,
      tables: ["chunks_fts_idx", "chunks_fts_docsize", "chunks_fts_data"],
      fallback: true,
    })).toEqual({ type: "opened", dbstat: false });

    let id = 0;
    let total = 0;
    let sawData = false;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      id += 1;
      const reply = await ask(worker, { type: "slice", id, budgetBytes: 32 * 1024 });
      if (reply.type !== "slice") throw new Error(`unexpected reply ${reply.type}`);
      total += reply.bytes;
      if (reply.table === "chunks_fts_data") sawData = true;
      if (reply.done) break;
    }
    expect(total).toBeGreaterThan(0);
    expect(sawData).toBe(true);
    await worker.terminate();
  });

  it("reports a missing database without echoing the path", async () => {
    const worker = spawn();
    const reply = await ask(worker, { type: "open", file: "/nonexistent/secret-path.db", tables: ["chunks_fts_data"] });
    expect(reply).toMatchObject({ type: "error", errorType: expect.any(String) });
    expect(JSON.stringify(reply)).not.toContain("secret-path");
    await worker.terminate();
  });
});
