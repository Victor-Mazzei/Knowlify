import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadIngestionRunner } from "../src/adapters/indexing/ThreadIngestionRunner.js";
import type { IngestJob, IngestSink } from "../src/ports/knowledge.js";

const roots: string[] = [];
const runners: ThreadIngestionRunner[] = [];
const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
  for (const close of servers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "knowlify-query-embedding-"));
  roots.push(root);
  return root;
}

/** The worker may not have written its first line yet. */
function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const jobFor = (root: string, bookId = "query-book"): IngestJob => ({
  bookId,
  path: join(root, "fixture.epub"),
  format: "epub",
  knownHash: null,
  indexVersion: "1|http:fake",
});

const sink: IngestSink = {
  onStart: () => {},
  onBatch: async () => {},
  onProgress: () => {},
};

function tracks(runner: ThreadIngestionRunner): ThreadIngestionRunner {
  runners.push(runner);
  return runner;
}

interface FakeProvider {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/** OpenAI-compatible embeddings provider on an ephemeral loopback port. */
async function serveEmbeddings(
  respond: (input: string) => { delayMs: number; vector: number[] },
): Promise<FakeProvider> {
  const sockets = new Set<import("node:net").Socket>();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      const result = respond(payload.input[0] ?? "");
      requests.push(payload.input[0] ?? "");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ embedding: result.vector, index: 0 }] }));
      }, result.delayMs);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  servers.push(close);
  return { url: `http://127.0.0.1:${port}/v1`, requests, close };
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for the expected state"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("query embedding cancellation", () => {
  it(
    "drops aborted queries, bounds the backlog and never interrupts active ingestion",
    async () => {
      const root = tempRoot();
      const logFile = join(root, "worker.log");
      const workerPath = join(root, "query.worker.mjs");
      await writeFile(workerPath, [
        'import { appendFileSync } from "node:fs";',
        'import { parentPort } from "node:worker_threads";',
        "const log = process.env.KNOWLIFY_QUERY_TEST_LOG;",
        "const inflight = new Set();",
        "const record = (line) => { if (log) appendFileSync(log, line + '\\n'); };",
        'parentPort.on("message", (message) => {',
        '  if (message.type === "close") process.exit(0);',
        '  if (message.type === "run") {',
        '    record("run:start");',
        '    setTimeout(() => {',
        '      record("run:done");',
        '      parentPort.postMessage({ type: "done", contentHash: "fixture", chunkCount: 1, indexVersion: message.job.indexVersion });',
        "    }, 200);",
        "    return;",
        "  }",
        '  if (message.type === "query") {',
        "    inflight.add(message.id);",
        '    record(`query:${message.id}:inflight=${inflight.size}`);',
        "    return;",
        "  }",
        '  if (message.type === "query-cancel") {',
        "    inflight.delete(message.id);",
        '    record(`cancel:${message.id}`);',
        "  }",
        "});",
      ].join("\n"));
      process.env.KNOWLIFY_QUERY_TEST_LOG = logFile;
      const messages: string[] = [];
      const runner = tracks(new ThreadIngestionRunner({
        embedder: { kind: "http", url: "http://127.0.0.1:9/v1", model: "fake" },
        workerPath,
        maxQueryBacklog: 2,
        log: (message) => messages.push(message),
      }));
      try {
        const run = runner.run(jobFor(root), sink);
        const controllers = Array.from({ length: 5 }, () => new AbortController());
        const pending = controllers.map((controller) =>
          runner.embedQuery("sensitive-question", { signal: controller.signal }));

        // Only the configured backlog reaches the worker; the rest falls back immediately.
        await expect(Promise.all(pending.slice(2))).resolves.toEqual([null, null, null]);
        expect(messages).toContain("Query embedding skipped; the ingestion worker is busy");

        for (const controller of controllers.slice(0, 2)) controller.abort();
        await expect(Promise.all(pending.slice(0, 2))).resolves.toEqual([null, null]);
        await waitFor(() => readLog(logFile).includes("cancel:2"));
        expect(await run).toMatchObject({ kind: "done" });

        const lines = readLog(logFile).trim().split("\n");
        const sent = lines.filter((line) => line.startsWith("query:"));
        expect(sent).toHaveLength(2);
        expect(lines.filter((line) => line.startsWith("cancel:"))).toHaveLength(2);
        const maxInflight = Math.max(...sent.map((line) => Number(line.split("inflight=")[1])));
        expect(maxInflight).toBeLessThanOrEqual(2);
        expect(lines).toContain("run:done");
        // Diagnostics never carry the question text.
        expect(messages.join("\n")).not.toContain("sensitive-question");
      } finally {
        delete process.env.KNOWLIFY_QUERY_TEST_LOG;
      }
    },
    30_000,
  );

  it(
    "recovers after an aborted query with the real worker and the next query's vector",
    async () => {
      const provider = await serveEmbeddings((input) => ({
        delayMs: 80,
        vector: input === "first-question" ? [1, 0] : [0, 1],
      }));
      const runner = tracks(new ThreadIngestionRunner({
        embedder: { kind: "http", url: provider.url, model: "fake" },
      }));
      const controller = new AbortController();
      const first = runner.embedQuery("first-question", { signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      await expect(first).resolves.toBeNull();

      // A cancelled request never blocks or spoils the next one.
      const second = await runner.embedQuery("second-question");
      expect(second).not.toBeNull();
      expect(Array.from(second ?? [])).toEqual([0, 1]);
      expect(provider.requests).toEqual(["first-question", "second-question"]);
      expect(runner.embeddings()).toEqual({ mode: "http", model: "fake", state: "ready" });
    },
    30_000,
  );

  it("does not post work when the signal is already aborted", async () => {
    const root = tempRoot();
    const logFile = join(root, "worker.log");
    const workerPath = join(root, "quiet.worker.mjs");
    await writeFile(workerPath, [
      'import { appendFileSync } from "node:fs";',
      'import { parentPort } from "node:worker_threads";',
      "const log = process.env.KNOWLIFY_QUERY_TEST_LOG;",
      'parentPort.on("message", (message) => {',
      '  if (message.type === "close") process.exit(0);',
      `  if (log) appendFileSync(log, message.type + "\\n");`,
      "});",
    ].join("\n"));
    process.env.KNOWLIFY_QUERY_TEST_LOG = logFile;
    const runner = tracks(new ThreadIngestionRunner({
      embedder: { kind: "http", url: "http://127.0.0.1:9/v1", model: "fake" },
      workerPath,
    }));
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(runner.embedQuery("never-sent", { signal: controller.signal })).resolves.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readLog(logFile)).not.toContain("query");
    } finally {
      delete process.env.KNOWLIFY_QUERY_TEST_LOG;
    }
  });
});
