import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { extractEpub, extractPdf } from "../src/adapters/files/metadata.js";
import { WorkerPoolMetadataExtractor } from "../src/adapters/files/WorkerPoolMetadataExtractor.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-metadata-pool-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function writeEpub(name: string): Promise<string> {
  const zip = new AdmZip();
  zip.addFile("META-INF/container.xml", Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'));
  zip.addFile("book.opf", Buffer.from('<package><metadata><title>Pool title</title><creator>Pool author</creator></metadata><manifest><item id="cover" href="cover.png" properties="cover-image" media-type="image/png"/></manifest></package>'));
  zip.addFile("cover.png", Buffer.from("cover bytes"));
  const path = join(root, name);
  await writeFile(path, zip.toBuffer());
  return path;
}

async function writePdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.addPage([120, 180]);
  pdf.setTitle("PDF pool title");
  pdf.setAuthor("PDF pool author");
  const path = join(root, name);
  await writeFile(path, await pdf.save());
  return path;
}

const pool = (options: Partial<ConstructorParameters<typeof WorkerPoolMetadataExtractor>[0]> = {}) =>
  new WorkerPoolMetadataExtractor({ workers: 2, ...options });

describe("WorkerPoolMetadataExtractor", () => {
  it("returns the same metadata as the in-process extractors", async () => {
    const epubPath = await writeEpub("same.epub");
    const pdfPath = await writePdf("same.pdf");
    const extractor = pool({ workers: 2 });
    try {
      const expectedEpub = await extractEpub(epubPath);
      const expectedPdf = await extractPdf(pdfPath);
      expect(await extractor.extract(epubPath, "epub")).toEqual(expectedEpub);
      const pdf = await extractor.extract(pdfPath, "pdf");
      expect(pdf).toMatchObject({ title: expectedPdf.title, author: expectedPdf.author, cover: { ext: "jpg" } });
      expect(pdf.cover?.data.length).toBeGreaterThan(0);
    } finally {
      await extractor.close();
    }
  }, 30_000);

  it("runs in the caller thread when inline mode is requested", async () => {
    const path = await writeEpub("inline.epub");
    const extractor = pool({ inline: true });
    try {
      await expect(extractor.extract(path, "epub")).resolves.toMatchObject({ title: "Pool title", author: "Pool author" });
    } finally {
      await extractor.close();
    }
  });

  it("rejects a timed-out task and uses a fresh worker for the next one", async () => {
    const workerPath = join(root, "hang.worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort.on("message", (message) => {',
      '  if (message.type !== "extract") return;',
      '  if (message.path.endsWith("hang.pdf")) return;',
      '  parentPort.postMessage({ type: "result", id: message.id, metadata: { title: "after timeout" } });',
      "});",
    ].join("\n"));
    // The recovery task pays for a fresh worker thread. Measured at ~125 ms on a
    // deliberately starved host (eight busy loops on three cores), so 100 ms rejected
    // the healthy task too. 1 s keeps a >5x margin; the hung task never answers, so
    // any finite timeout still proves the rejection and the worker replacement.
    const extractor = pool({ workers: 1, workerPath, timeoutMs: 1_000 });
    try {
      await expect(extractor.extract(join(root, "hang.pdf"), "pdf")).rejects.toThrow(/timed out/);
      await expect(extractor.extract(join(root, "ok.pdf"), "pdf")).resolves.toEqual({ title: "after timeout" });
    } finally {
      await extractor.close();
    }
  }, 30_000);

  it("replaces a crashed worker instead of hanging the queue", async () => {
    const workerPath = join(root, "crash.worker.mjs");
    await writeFile(workerPath, [
      'import { parentPort } from "node:worker_threads";',
      'parentPort.on("message", (message) => {',
      '  if (message.type !== "extract") return;',
      '  if (message.path.endsWith("crash.pdf")) process.exit(9);',
      '  parentPort.postMessage({ type: "result", id: message.id, metadata: { title: "after crash" } });',
      "});",
    ].join("\n"));
    const extractor = pool({ workers: 1, workerPath });
    try {
      await expect(extractor.extract(join(root, "crash.pdf"), "pdf")).rejects.toThrow(/exited/);
      await expect(extractor.extract(join(root, "ok.pdf"), "pdf")).resolves.toEqual({ title: "after crash" });
    } finally {
      await extractor.close();
    }
  }, 30_000);

  it("recycles a worker after the configured number of tasks", async () => {
    const pids = join(root, "pids.txt");
    await writeFile(pids, "");
    process.env.KNOWLIFY_TEST_METADATA_PIDS = pids;
    const workerPath = join(root, "pid.worker.mjs");
    await writeFile(workerPath, [
      'import { appendFileSync } from "node:fs";',
      'import { parentPort, threadId } from "node:worker_threads";',
      'appendFileSync(process.env.KNOWLIFY_TEST_METADATA_PIDS, process.pid + ":" + threadId + "\\n");',
      'parentPort.on("message", (message) => {',
      '  if (message.type !== "extract") return;',
      '  parentPort.postMessage({ type: "result", id: message.id, metadata: { title: "task" } });',
      "});",
    ].join("\n"));
    const extractor = pool({ workers: 1, workerPath, maxTasksPerWorker: 1 });
    try {
      await extractor.extract(join(root, "one.pdf"), "pdf");
      await extractor.extract(join(root, "two.pdf"), "pdf");
      const started = readFileSync(pids, "utf8").trim().split("\n").filter(Boolean);
      expect(new Set(started).size).toBe(2);
    } finally {
      delete process.env.KNOWLIFY_TEST_METADATA_PIDS;
      await extractor.close();
    }
  }, 30_000);

  it("keeps the worker across EPUB tasks and recycles only after PDF tasks", async () => {
    // EPUB extraction is pure JavaScript; counting it toward the native-memory
    // recycling threshold made a 11k backfill restart every worker repeatedly.
    const pids = join(root, "pids-epub.txt");
    await writeFile(pids, "");
    process.env.KNOWLIFY_TEST_METADATA_PIDS = pids;
    const workerPath = join(root, "pid-epub.worker.mjs");
    await writeFile(workerPath, [
      'import { appendFileSync } from "node:fs";',
      'import { parentPort, threadId } from "node:worker_threads";',
      'appendFileSync(process.env.KNOWLIFY_TEST_METADATA_PIDS, process.pid + ":" + threadId + "\\n");',
      'parentPort.on("message", (message) => {',
      '  if (message.type !== "extract") return;',
      '  parentPort.postMessage({ type: "result", id: message.id, metadata: { title: "task" } });',
      "});",
    ].join("\n"));
    const ids = () => new Set(readFileSync(pids, "utf8").trim().split("\n").filter(Boolean));
    const extractor = pool({ workers: 1, workerPath, maxTasksPerWorker: 1 });
    try {
      await extractor.extract(join(root, "one.epub"), "epub");
      await extractor.extract(join(root, "two.epub"), "epub");
      expect(ids().size).toBe(1);
      await extractor.extract(join(root, "three.pdf"), "pdf");
      await extractor.extract(join(root, "four.pdf"), "pdf");
      expect(ids().size).toBe(2);
    } finally {
      delete process.env.KNOWLIFY_TEST_METADATA_PIDS;
      await extractor.close();
    }
  }, 30_000);
});
