import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { IngestError } from "../src/adapters/indexing/errors.js";
import { ThreadIngestionRunner } from "../src/adapters/indexing/ThreadIngestionRunner.js";
import type { IngestBatch, IngestJob, IngestSink } from "../src/ports/knowledge.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-worker-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

async function writeEpub(name: string, body: string): Promise<string> {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    "OEBPS/content.opf",
    Buffer.from(
      '<package><metadata><title>Worker fixture</title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
    ),
  );
  zip.addFile("OEBPS/c1.xhtml", Buffer.from(`<html><body>${body}</body></html>`));
  const path = join(root, name);
  await writeFile(path, zip.toBuffer());
  return path;
}

async function writeLargePdf(name: string, pages: number, lines: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const word = (): string => Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(random() * 26)]).join("");
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    const page = pdf.addPage([595, 842]);
    for (let line = 0; line < lines; line += 1) {
      const sentence = Array.from({ length: 9 }, word).join(" ");
      page.drawText(`${pageIndex}.${line} ${sentence}.`, { x: 36, y: 810 - line * 17, size: 9, font });
    }
  }
  const path = join(root, name);
  await writeFile(path, await pdf.save());
  return path;
}

function recordingSink() {
  const batches: IngestBatch[] = [];
  let started = false;
  let progress = 0;
  const sink: IngestSink = {
    onStart: () => {
      started = true;
    },
    onBatch: async (batch) => {
      batches.push(batch);
    },
    onProgress: (fraction) => {
      progress = fraction;
    },
  };
  return { sink, batches, isStarted: () => started, progress: () => progress };
}

const jobFor = (path: string, format: "pdf" | "epub"): IngestJob => ({
  bookId: "worker-book",
  path,
  format,
  knownHash: null,
  indexVersion: "1|lexical",
});

interface FakeProvider {
  url: string;
  requests: string[][];
  close(): Promise<void>;
}

/** OpenAI-compatible fake provider on an ephemeral loopback port. */
async function serveEmbeddings(
  respond: (inputs: string[], call: number) => { status: number; body?: unknown },
): Promise<FakeProvider> {
  const sockets = new Set<import("node:net").Socket>();
  const requests: string[][] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      requests.push(payload.input);
      const result = respond(payload.input, requests.length);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body ?? {}));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function embeddingsReply(inputs: string[]): { status: number; body: unknown } {
  return {
    status: 200,
    body: { data: inputs.map((_, index) => ({ embedding: [1, 0], index })) },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("threaded ingestion runner", () => {
  it(
    "ingests an EPUB in a real worker thread and reports the same index version",
    async () => {
      const path = await writeEpub("worker.epub", "<p>Hello from the worker.</p><p>Segundo parágrafo.</p>");
      const runner = new ThreadIngestionRunner({ embedder: { kind: "none" } });
      try {
        expect(runner.indexVersion()).toBe("1|lexical");
        expect(runner.embeddings()).toEqual({ mode: "none", model: null, state: "off" });
        const { sink, batches, isStarted, progress } = recordingSink();
        const outcome = await runner.run(jobFor(path, "epub"), sink);
        expect(outcome).toMatchObject({ kind: "done", chunkCount: expect.any(Number), indexVersion: "1|lexical" });
        expect(isStarted()).toBe(true);
        expect(progress()).toBe(1);
        expect(batches.length).toBeGreaterThan(0);
        expect(batches[0].passages[0].ordinal).toBe(0);
        expect(await runner.embedQuery("anything")).toBeNull();
      } finally {
        await runner.close();
      }
    },
    60_000,
  );

  it(
    "replaces a crashed worker instead of hanging the queue",
    async () => {
      const marker = join(root, "crash.marker");
      const workerPath = join(root, "crash.worker.mjs");
      await writeFile(
        workerPath,
        [
          'import { parentPort } from "node:worker_threads";',
          'import { existsSync, writeFileSync } from "node:fs";',
          'parentPort.on("message", (message) => {',
          '  if (message.type !== "run") return;',
          '  const marker = process.env.KNOWLIFY_TEST_CRASH_MARKER;',
          '  if (marker && !existsSync(marker)) { writeFileSync(marker, "1"); process.exit(23); }',
          '  parentPort.postMessage({ type: "done", contentHash: "fixture", chunkCount: 1, indexVersion: "1|none" });',
          '});',
        ].join("\n"),
      );
      process.env.KNOWLIFY_TEST_CRASH_MARKER = marker;
      const runner = new ThreadIngestionRunner({ embedder: { kind: "none" }, workerPath });
      try {
        const first = await runner.run(jobFor(join(root, "missing.epub"), "epub"), recordingSink().sink).catch((error: unknown) => error);
        expect(first).toBeInstanceOf(IngestError);
        expect((first as IngestError).code).toBe("unknown");
        const second = await runner.run(jobFor(join(root, "missing.epub"), "epub"), recordingSink().sink);
        expect(second).toEqual({ kind: "done", contentHash: "fixture", chunkCount: 1, indexVersion: "1|none" });
      } finally {
        delete process.env.KNOWLIFY_TEST_CRASH_MARKER;
        await runner.close();
      }
    },
    60_000,
  );

  it(
    "surfaces sink failures and keeps the worker usable",
    async () => {
      const path = await writeEpub("sink.epub", "<p>First batch.</p><p>Second batch.</p>");
      const runner = new ThreadIngestionRunner({ embedder: { kind: "none" } });
      try {
        const failing: IngestSink = {
          onStart: () => {},
          onProgress: () => {},
          onBatch: async () => {
            throw new Error("database is locked");
          },
        };
        await expect(runner.run(jobFor(path, "epub"), failing)).rejects.toThrow("database is locked");
        const outcome = await runner.run(jobFor(path, "epub"), recordingSink().sink);
        expect(outcome).toMatchObject({ kind: "done" });
      } finally {
        await runner.close();
      }
    },
    60_000,
  );

  it(
    "keeps the main event loop responsive while a large PDF is indexed",
    async () => {
      const warmup = await writeEpub("warmup.epub", "<p>Warm up the worker.</p>");
      const largePdf = await writeLargePdf("large.pdf", 160, 45);
      expect((await stat(largePdf)).size).toBeGreaterThan(300_000);
      const runner = new ThreadIngestionRunner({ embedder: { kind: "none" } });
      try {
        await runner.run(jobFor(warmup, "epub"), recordingSink().sink);

        const monitor = monitorEventLoopDelay({ resolution: 10 });
        monitor.enable();
        const { sink, batches } = recordingSink();
        const outcome = await runner.run(jobFor(largePdf, "pdf"), sink);
        monitor.disable();
        const p99 = monitor.percentile(99) / 1e6;

        expect(outcome).toMatchObject({ kind: "done" });
        expect((outcome as { chunkCount: number }).chunkCount).toBeGreaterThan(200);
        expect(batches.reduce((total, batch) => total + batch.passages.length, 0)).toBe((outcome as { chunkCount: number }).chunkCount);
        expect(p99).toBeLessThan(100);
      } finally {
        await runner.close();
      }
    },
    120_000,
  );

  it(
    "runs two jobs concurrently when the pool has two workers",
    async () => {
      const workerPath = join(root, "slow.worker.mjs");
      // Wall-clock limits are flaky on a loaded CI. Record when each job actually starts
      // and ends instead: interleaved intervals prove the jobs ran concurrently, which a
      // serialized pool can never produce, no matter how slow the machine is.
      const timings = join(root, "slow.worker.timings");
      await writeFile(
        workerPath,
        [
          'import { appendFileSync } from "node:fs";',
          'import { parentPort } from "node:worker_threads";',
          `const timings = ${JSON.stringify(timings)};`,
          'parentPort.on("message", (message) => {',
          '  if (message.type === "close") process.exit(0);',
          '  if (message.type !== "run") return;',
          '  appendFileSync(timings, `start ${Date.now()}\\n`);',
          '  setTimeout(() => {',
          '    appendFileSync(timings, `end ${Date.now()}\\n`);',
          '    parentPort.postMessage({ type: "done", contentHash: "fixture", chunkCount: 1, indexVersion: message.job.indexVersion });',
          '  }, 120);',
          '});',
        ].join("\n"),
      );
      const runner = new ThreadIngestionRunner({ embedder: { kind: "none" }, workerPath, workers: 2 });
      try {
        const outcomes = await Promise.all([
          runner.run(jobFor(join(root, "a.epub"), "epub"), recordingSink().sink),
          runner.run(jobFor(join(root, "b.epub"), "epub"), recordingSink().sink),
        ]);
        expect(outcomes).toHaveLength(2);
        const lines = (await readFile(timings, "utf8")).trim().split("\n");
        const starts = lines.filter((line) => line.startsWith("start ")).map((line) => Number(line.slice(6)));
        const ends = lines.filter((line) => line.startsWith("end ")).map((line) => Number(line.slice(4)));
        expect(starts).toHaveLength(2);
        expect(ends).toHaveLength(2);
        // Both jobs were in flight at the same time.
        expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
        // The pool still works after a full round.
        const third = await runner.run(jobFor(join(root, "c.epub"), "epub"), recordingSink().sink);
        expect(third).toMatchObject({ kind: "done" });
      } finally {
        await runner.close();
      }
    },
    30_000,
  );

  it(
    "reports a degraded index version when the HTTP provider fails mid-book",
    async () => {
      const provider = await serveEmbeddings((inputs, call) =>
        call === 1 ? embeddingsReply(inputs) : { status: 500 },
      );
      const paragraphs = Array.from(
        { length: 40 },
        (_, index) => `paragraph${index} ${"word ".repeat(190)}`,
      ).join("</p><p>");
      const path = await writeEpub("http-failure.epub", `<p>${paragraphs}</p>`);
      const runner = new ThreadIngestionRunner({
        embedder: { kind: "http", url: provider.url, model: "fake" },
      });
      try {
        const { sink, batches } = recordingSink();
        const outcome = (await runner.run(jobFor(path, "epub"), sink)) as {
          kind: "done";
          chunkCount: number;
          indexVersion: string;
        };

        expect(outcome.kind).toBe("done");
        expect(outcome.indexVersion).toBe("1|none");
        expect(outcome.chunkCount).toBeGreaterThan(32);
        expect(batches.map((batch) => batch.passages.length)).toEqual([32, outcome.chunkCount - 32]);
        expect(batches[0].vectors).not.toBeNull();
        expect(batches[1].vectors).toBeNull();
        expect(provider.requests).toHaveLength(2);
        expect(provider.requests[0]).toHaveLength(32);

        await waitFor(() => runner.embeddings().state === "unavailable");
        expect(runner.embeddings()).toEqual({ mode: "http", model: "fake", state: "unavailable" });
        expect(runner.indexVersion()).toBe("1|none");
      } finally {
        await runner.close();
        await provider.close();
      }
    },
    60_000,
  );

  it(
    "recovers the HTTP provider with an idle queue and reports readiness once",
    async () => {
      let healthy = false;
      const provider = await serveEmbeddings((inputs) => (healthy ? embeddingsReply(inputs) : { status: 503 }));
      const path = await writeEpub("recovery.epub", "<p>Short book for the recovery probe.</p>");
      const runner = new ThreadIngestionRunner({
        embedder: { kind: "http", url: provider.url, model: "fake", retryCooldownMs: 20 },
      });
      let readyCount = 0;
      runner.onEmbeddingsReady(() => {
        readyCount += 1;
      });
      try {
        const outcome = await runner.run(jobFor(path, "epub"), recordingSink().sink);
        expect(outcome).toMatchObject({ kind: "done", indexVersion: "1|none" });

        await waitFor(() => runner.embeddings().state === "unavailable");
        healthy = true;
        await waitFor(() => readyCount === 1);

        expect(runner.embeddings()).toEqual({ mode: "http", model: "fake", state: "ready" });
        expect(runner.indexVersion()).toBe("1|http:fake");
        expect(provider.requests.length).toBeGreaterThanOrEqual(2);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(readyCount).toBe(1);
      } finally {
        await runner.close();
        await provider.close();
      }
    },
    60_000,
  );
});
