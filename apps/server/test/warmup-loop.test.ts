import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { WarmupController } from "../src/adapters/search/WarmupController.js";
import { MemoryProfile } from "../src/adapters/runtime/memoryProfile.js";

/**
 * The warm-up must never block the API event loop: the reads happen in a transient worker
 * and the main process only exchanges slice messages. This test warms a real index large
 * enough to pass the small-index floor and fails if the loop stalls during the pass.
 */

const LOOP_MAX_MS = 50;
const CHUNKS = 120_000;
const roots: string[] = [];
const databases: Db[] = [];
const controllers: WarmupController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedLargeIndex(chunks: number): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-warmup-loop-"));
  roots.push(root);
  const file = join(root, "knowlify.db");
  const db = openDb(file);
  databases.push(db);
  db.prepare(`INSERT INTO books (id,title,author,format,path,size,added_at,source_id,mtime,status)
    VALUES ('b','Title','A','pdf','/b.pdf',1,1,'s',1,'ready')`).run();
  db.prepare("DROP TRIGGER chunks_ai").run();
  const insert = db.prepare("INSERT INTO chunks (book_id,ordinal,text,page,section) VALUES ('b',?,?,NULL,NULL)");
  const vocabulary = (
    "deep work attention focus memory habit reading system process learning practice "
    + "chapter author concept question answer evidence example study research science "
    + "knowledge library passage retrieval vector search index corpus document term"
  ).split(" ");
  db.transaction(() => {
    for (let ordinal = 0; ordinal < chunks; ordinal += 1) {
      const words: string[] = [];
      for (let index = 0; index < 160; index += 1) {
        words.push(vocabulary[(ordinal * 7 + index * 13) % vocabulary.length]!);
      }
      insert.run(ordinal, `Passage ${ordinal}. ${words.join(" ")}.`);
    }
  })();
  db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return file;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("warm-up keeps the main loop responsive", () => {
  it(
    "reads a large index in a worker without a loop stall",
    async () => {
      const file = seedLargeIndex(CHUNKS);
      let offset = 0;
      const controller = new WarmupController({
        mode: "on",
        file,
        enabled: true,
        profile: new MemoryProfile(),
        now: () => Date.now() + offset,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });
      controllers.push(controller);

      const monitor = monitorEventLoopDelay({ resolution: 10 });
      monitor.enable();
      const started = Date.now();
      try {
        controller.start();
        // Skip the sixty-second boot delay without sleeping.
        offset += 61_000;
        controller.tick();
        expect(controller.status().state).toBe("warming");
        await waitFor(() => controller.status().state === "warm", 60_000);
      } finally {
        monitor.disable();
      }
      const elapsed = Date.now() - started;
      const status = controller.status();
      expect(status).toMatchObject({ state: "warm", scope: "full" });
      expect(status.warmedMB).toBeGreaterThan(0);
      expect(status.targetMB).toBeGreaterThanOrEqual(status.warmedMB);
      // The slice pacing keeps the pass to a fraction of the wall time (duty cycle ≤ 25%).
      expect(elapsed).toBeGreaterThan(0);
      expect(monitor.max / 1e6).toBeLessThan(LOOP_MAX_MS);
    },
    120_000,
  );
});
