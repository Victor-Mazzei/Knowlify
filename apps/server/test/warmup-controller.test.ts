import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/adapters/storage/db.js";
import { WarmupController, type WarmupControllerOptions } from "../src/adapters/search/WarmupController.js";
import type { MemoryProfile } from "../src/adapters/runtime/memoryProfile.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const roots: string[] = [];
const databases: Db[] = [];
const controllers: WarmupController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedDb(chunks = 300): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-warmup-controller-"));
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

function missingWorkerPath(): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-warmup-missing-"));
  roots.push(root);
  return join(root, "warmup.worker.js");
}

interface MemoryState {
  limit: number;
  budget: number;
  rss: number;
  cgroup: number | null;
}

function fakeProfile(initial: Partial<MemoryState> = {}): { state: MemoryState; profile: MemoryProfile } {
  const state: MemoryState = { limit: 4 * GB, budget: 3 * GB, rss: 100 * MB, cgroup: 4 * GB, ...initial };
  const profile = {
    limitBytes: () => state.limit,
    cacheableBytes: () => state.budget,
    ownRssBytes: () => state.rss,
    effectiveCgroupLimitBytes: () => state.cgroup,
    totalBytes: () => state.limit,
    freeBytes: () => state.budget * 2,
    cgroupVersion: () => (state.cgroup === null ? null : 2),
    snapshot: () => ({ ...state }),
  } as unknown as MemoryProfile;
  return { state, profile };
}

function makeController(overrides: Partial<WarmupControllerOptions> = {}): {
  controller: WarmupController;
  memory: MemoryState;
  advance: (ms: number) => void;
  now: () => number;
} {
  const memory = fakeProfile();
  let clock = 0;
  const controller = new WarmupController({
    mode: "auto",
    file: seedDb(),
    enabled: true,
    profile: memory.profile,
    now: () => clock,
    sliceBytes: 4096,
    rateBytesPerSec: () => 64 * 1024,
    plan: () => ({ start: true, scope: "full", targetBytes: 1_000_000 }),
    ...overrides,
  });
  controllers.push(controller);
  return {
    controller,
    memory: memory.state,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("WarmupController", () => {
  it("stays off when the operator turns warming off or the index is disabled", async () => {
    const off = makeController({ mode: "off" });
    off.controller.start();
    off.advance(120_000);
    off.controller.tick();
    expect(off.controller.status()).toMatchObject({ mode: "off", state: "off" });

    const disabled = makeController({ enabled: false });
    disabled.controller.start();
    disabled.controller.tick();
    expect(disabled.controller.status()).toMatchObject({ state: "off", reason: "disabled" });
  });

  it("treats a zero budget ceiling as off and caps the reported budget", () => {
    const off = makeController({ mode: "on", maxMb: 0 });
    off.controller.start();
    off.advance(61_000);
    off.controller.tick();
    expect(off.controller.status()).toMatchObject({ mode: "off", state: "off" });
    expect(off.controller.memoryStatus().budgetMB).toBe(0);

    const capped = makeController({ mode: "on", maxMb: 512 });
    expect(capped.controller.memoryStatus()).toEqual({ limitMB: 4 * 1024, budgetMB: 512 });
  });

  it("uses the real policy to stay off on a small index", () => {
    const { controller } = makeController({ plan: undefined, fileBytes: () => 50 * MB });
    controller.start();
    controller.tick();
    expect(controller.status()).toMatchObject({ state: "off", reason: "small-index", targetMB: 0 });
  });

  it("never starts a worker on 512 MB or 1 GiB machines, even in `on` mode", () => {
    const budgetMB = (limitMB: number, rssMB: number): number =>
      limitMB - rssMB - Math.max(256, limitMB * 0.25);
    const machines = [
      { limitMB: 512, rssMB: 100, fileMB: 160 },
      { limitMB: 1_024, rssMB: 150, fileMB: 500 },
    ];
    for (const mode of ["auto", "on"] as const) {
      for (const machine of machines) {
        const logs: string[] = [];
        const memory = fakeProfile({
          limit: machine.limitMB * MB,
          budget: budgetMB(machine.limitMB, machine.rssMB) * MB,
          rss: machine.rssMB * MB,
          cgroup: machine.limitMB * MB,
        });
        const { controller, advance } = makeController({
          mode,
          plan: undefined,
          profile: memory.profile,
          fileBytes: () => machine.fileMB * MB,
          // If the policy let the pass start, resolving this path would fail and log.
          workerPath: missingWorkerPath(),
          log: {
            info: (message) => logs.push(message),
            warn: (message) => logs.push(message),
            error: (_error, message) => logs.push(message),
          },
        });
        controller.start();
        controller.noteSearchEnd();
        advance(61_000);
        controller.tick();
        expect(controller.status()).toMatchObject({ state: "off", reason: "low-memory", warmedMB: 0, targetMB: 0 });
        advance(10 * 60_000);
        controller.tick();
        expect(controller.status()).toMatchObject({ state: "off", reason: "low-memory", warmedMB: 0, targetMB: 0 });
        expect(logs).toEqual([]);
      }
    }
  });

  it("starts the pass one byte above the 1 GiB small-machine limit", async () => {
    const limit = 1_024 * MB + 1;
    const budget = limit - 150 * MB - 256 * MB;
    const { controller, advance } = makeController({
      mode: "on",
      plan: undefined,
      profile: fakeProfile({ limit, budget, rss: 150 * MB, cgroup: limit }).profile,
      fileBytes: () => 500 * MB,
    });
    controller.start();
    advance(61_000);
    controller.tick();
    expect(controller.status()).toMatchObject({ state: "warming", scope: "full" });
    await waitFor(() => controller.status().state === "warm");
    expect(controller.status()).toMatchObject({ state: "warm", scope: "full" });
  });

  it("never warms before the first completed query, then waits for quiet", async () => {
    const { controller, advance } = makeController();
    controller.start();
    advance(10_000);
    controller.tick();
    expect(controller.status().state).toBe("idle");

    controller.noteSearchEnd();
    advance(1_000);
    controller.tick();
    expect(controller.status().state).toBe("idle");
    advance(2_500);
    controller.tick();
    // Triggered after two seconds but still inside the five-second quiet window.
    expect(controller.status()).toMatchObject({ state: "waiting", reason: "activity" });
    advance(3_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
    await waitFor(() => controller.status().state === "warm");
    expect(controller.status().finishedAt).toBeDefined();
  });

  it("warms sixty seconds after listening in `on` mode", () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    advance(59_000);
    controller.tick();
    expect(controller.status().state).toBe("idle");
    advance(2_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
  });

  it("pauses within one slice when a search starts and resumes after quiet", async () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    advance(61_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");

    controller.noteSearchStart();
    expect(controller.status()).toMatchObject({ state: "paused", reason: "activity" });

    // Still inside the quiet window: no new pass.
    controller.noteSearchEnd();
    advance(1_000);
    controller.tick();
    expect(controller.status().state).toBe("paused");

    advance(6_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
    await waitFor(() => controller.status().state === "warm");
  });

  it("is idempotent: starting twice and ticking after warm does not redo the pass", async () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    controller.start();
    advance(61_000);
    controller.tick();
    await waitFor(() => controller.status().state === "warm");
    advance(60_000);
    controller.tick();
    expect(controller.status().state).toBe("warm");
  });

  it("stops on memory pressure and retries after ten minutes", () => {
    const { controller, memory, advance } = makeController({ mode: "on" });
    controller.start();
    advance(61_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");

    memory.rss = 4 * GB * 0.9;
    controller.tick();
    expect(controller.status()).toMatchObject({ state: "paused", reason: "memory-pressure" });

    memory.rss = 100 * MB;
    advance(5 * 60_000);
    controller.tick();
    expect(controller.status().state).toBe("paused");
    advance(6 * 60_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
  });

  it("backs off five minutes after the query worker is discarded", () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    advance(61_000);
    controller.tick();
    controller.noteDiscard();
    expect(controller.status()).toMatchObject({ state: "paused", reason: "cooldown" });

    advance(4 * 60_000);
    controller.tick();
    expect(controller.status().state).toBe("paused");
    advance(2 * 60_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
  });

  it("gives up after three restarts until the next opportunity", () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    advance(61_000);
    controller.tick();
    for (let restart = 0; restart < 3; restart += 1) {
      controller.noteSearchStart();
      expect(controller.status().state).toBe("paused");
      controller.noteSearchEnd();
      advance(6_000);
      controller.tick();
    }
    // Third restart: no new pass until the ten-minute cooldown.
    expect(controller.status().state).toBe("paused");
    advance(6_000);
    controller.tick();
    expect(controller.status().state).toBe("paused");
    advance(11 * 60_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
  });

  it("cancels the pass on close and is safe to call twice", async () => {
    const { controller, advance } = makeController({ mode: "on" });
    controller.start();
    advance(61_000);
    controller.tick();
    expect(controller.status().state).toBe("warming");
    await controller.close();
    expect(controller.status().state).toBe("off");
    await controller.close();
    advance(120_000);
    controller.tick();
    expect(controller.status().state).toBe("off");
  });

  it("logs a failure without echoing the database path", async () => {
    const messages: string[] = [];
    let clock = 0;
    const controller = new WarmupController({
      mode: "on",
      file: "/nonexistent/secret-warmup-path/knowlify.db",
      enabled: true,
      profile: fakeProfile().profile,
      now: () => clock,
      fileBytes: () => 200 * MB,
      plan: () => ({ start: true, scope: "full", targetBytes: 1_000_000 }),
      log: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
        error: (_error, message) => messages.push(message),
      },
    });
    controllers.push(controller);
    controller.start();
    clock += 61_000;
    controller.tick();
    await waitFor(() => controller.status().state === "paused", 5_000);
    const joined = messages.join("\n");
    expect(joined).toContain("search warm-up");
    expect(joined).not.toContain("secret-warmup-path");
    expect(JSON.stringify(controller.status())).not.toContain("secret-warmup-path");
  });

  it("reports memory and progress from memory only", async () => {
    const { controller, advance } = makeController({ mode: "on" });
    expect(controller.memoryStatus()).toEqual({ limitMB: 4 * 1024, budgetMB: 3 * 1024 });
    controller.start();
    advance(61_000);
    controller.tick();
    await waitFor(() => controller.status().state === "warm");
    const status = controller.status();
    expect(status).toMatchObject({ mode: "on", state: "warm", scope: "full" });
    expect(status.finishedAt).toBeDefined();
    expect(status.targetMB).toBeGreaterThanOrEqual(status.warmedMB);
  });
});
