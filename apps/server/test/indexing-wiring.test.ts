import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ThreadIngestionRunner } from "../src/adapters/indexing/ThreadIngestionRunner.js";
import { SqliteBookIndexRepository } from "../src/adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBookRepository } from "../src/adapters/storage/repositories.js";
import { openDb } from "../src/adapters/storage/db.js";
import { config } from "../src/config.js";
import { buildApp, createIngestionRunner, indexingWorkers, toEmbedderConfig, type IndexingSettings } from "../src/index.js";
import type { Book } from "../src/ports/index.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-indexing-wiring-"));
const modelsDir = join(root, "models");
config.dataDir = root;
config.booksDir = join(root, "books");
config.coversDir = join(root, "covers");
config.indexing.enabled = true;
config.indexing.backfill = "auto";
await mkdir(config.booksDir, { recursive: true });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

type EmbeddingSettings = IndexingSettings["embeddings"];

const embeddings = (overrides: Partial<EmbeddingSettings> = {}): EmbeddingSettings => ({
  mode: "none",
  model: null,
  url: null,
  apiKey: null,
  offline: false,
  modelsDir,
  threads: 1,
  ...overrides,
});

const settings = (overrides: Partial<IndexingSettings> = {}): IndexingSettings => ({
  enabled: true,
  concurrency: 1,
  maxMb: 200,
  maxBytes: 200 * 1024 * 1024,
  backfill: "auto",
  workers: 1,
  vectorsMaxBooks: 1000,
  vectorScanMax: 300_000,
  embeddings: embeddings(),
  ...overrides,
});

const auth = { authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}` };

function epubWithText(title: string, text: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    "OEBPS/content.opf",
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
        + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        + `<dc:title>${title}</dc:title></metadata>`
        + '<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>'
        + '<spine><itemref idref="chapter"/></spine></package>',
    ),
  );
  zip.addFile("OEBPS/chapter.xhtml", Buffer.from(`<html><body><p>${text}</p></body></html>`));
  return zip.toBuffer();
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface FakeProvider {
  url: string;
  requests: string[][];
  setHealthy(value: boolean): void;
  close(): Promise<void>;
}

/** OpenAI-compatible provider on an ephemeral loopback port. */
async function serveEmbeddings(): Promise<FakeProvider> {
  let healthy = false;
  const requests: string[][] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: string[] };
      requests.push(payload.input);
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(
        healthy ? { data: payload.input.map((_, index) => ({ embedding: [1, 0], index })) } : {},
      ));
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
    setHealthy: (value) => { healthy = value; },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function upload(app: FastifyInstance, bytes: Buffer) {
  const boundary = "knowlify-indexing-wiring";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wiring.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/api/books",
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

describe("toEmbedderConfig", () => {
  it("maps none, local and complete http settings", () => {
    expect(toEmbedderConfig(embeddings())).toEqual({ kind: "none" });
    expect(toEmbedderConfig(embeddings({ mode: "local", model: null }))).toEqual({
      kind: "local",
      model: "Xenova/multilingual-e5-small",
      modelsDir,
      offline: false,
      threads: 1,
    });
    expect(toEmbedderConfig(embeddings({ mode: "local", model: "custom/model", offline: true, threads: 3 }))).toEqual({
      kind: "local",
      model: "custom/model",
      modelsDir,
      offline: true,
      threads: 3,
    });
    expect(toEmbedderConfig(embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "fake" }))).toEqual({
      kind: "http",
      url: "http://127.0.0.1:9/v1",
      model: "fake",
    });
    expect(toEmbedderConfig(embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "fake", apiKey: "top-secret" })))
      .toEqual({ kind: "http", url: "http://127.0.0.1:9/v1", model: "fake", apiKey: "top-secret" });
  });

  it("does not create an empty apiKey property", () => {
    const config = toEmbedderConfig(embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "fake" }));
    expect(config).not.toHaveProperty("apiKey");
  });

  it("falls back to none with a warning when http lacks URL or model", () => {
    const warn = vi.fn();
    expect(toEmbedderConfig(embeddings({ mode: "http", model: "fake" }), warn)).toEqual({ kind: "none" });
    expect(toEmbedderConfig(embeddings({ mode: "http", url: "http://127.0.0.1:9/v1" }), warn)).toEqual({ kind: "none" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatch(/KNOWLIFY_EMBEDDINGS_URL/);
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/127\.0\.0\.1|top-secret/);
  });
});

describe("createIngestionRunner", () => {
  it("returns undefined when indexing is off", async () => {
    await expect(createIngestionRunner(settings({ enabled: false }))).resolves.toBeUndefined();
  });

  it("builds the real runner from config without spawning its worker", async () => {
    const runner = await createIngestionRunner(settings({ embeddings: embeddings({ mode: "local", model: "local/model" }) }));
    expect(runner).toBeDefined();
    expect(runner?.indexVersion()).toBe("1|local:local/model");
    expect(runner?.embeddings()).toEqual({ mode: "local", model: "local/model", state: "off" });
    await runner?.close();
  });

  it("reports the lexical version when no embedder is configured", async () => {
    const runner = await createIngestionRunner(settings());
    expect(runner?.indexVersion()).toBe("1|lexical");
    await runner?.close();
  });

  it("maps http settings without exposing the key in the status", async () => {
    const runner = await createIngestionRunner(settings({
      embeddings: embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "fake", apiKey: "top-secret" }),
    }));
    expect(runner?.indexVersion()).toBe("1|http:fake");
    expect(runner?.embeddings()).toEqual({ mode: "http", model: "fake", state: "ready" });
    expect(JSON.stringify(runner?.embeddings())).not.toContain("top-secret");
    await runner?.close();
  });
});

describe("indexingWorkers", () => {
  it("keeps local embeddings at one worker and caps HTTP at two", () => {
    expect(indexingWorkers(settings({ workers: 4 }))).toBe(4);
    expect(indexingWorkers(settings({ workers: 4, embeddings: embeddings({ mode: "local", model: null }) }))).toBe(1);
    expect(indexingWorkers(settings({ workers: 4, embeddings: embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "m" }) }))).toBe(2);
    expect(indexingWorkers(settings({ workers: 1, embeddings: embeddings({ mode: "http", url: "http://127.0.0.1:9/v1", model: "m" }) }))).toBe(1);
  });
});

describe("buildApp wiring", () => {
  it("never starts the queue or the worker on its own", async () => {
    const marker = join(root, "worker-started.marker");
    const workerPath = join(root, "marker.worker.mjs");
    await writeFile(
      workerPath,
      [
        'import { writeFileSync } from "node:fs";',
        'import { parentPort } from "node:worker_threads";',
        `writeFileSync(${JSON.stringify(marker)}, "1");`,
        'parentPort.on("message", (message) => {',
        '  if (message.type === "close") process.exit(0);',
        '  if (message.type === "run") parentPort.postMessage({ type: "failed", code: "unreadable", message: "fixture" });',
        "});",
      ].join("\n"),
    );
    const db = openDb(":memory:");
    const book: Book = {
      id: "queued-book", title: "Queued", author: "", format: "epub", path: join(root, "queued.epub"),
      cover_path: null, size: 10, added_at: 1, source_id: null, mtime: 1, status: "ready",
    };
    new SqliteBookRepository(db).save(book);
    new SqliteBookIndexRepository(db).upsertPending({
      bookId: book.id, priority: 1, fingerprint: "10:1", now: Date.now(), resetAttempts: false,
    });
    const runner = new ThreadIngestionRunner({ embedder: { kind: "none" }, workerPath });
    const { app, indexing } = await buildApp(db, false, undefined, runner);
    try {
      await app.ready();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(indexing.status().counts).toEqual({ pending: 1, indexing: 0, ready: 0, error: 0 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await app.close();
      db.close();
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("real runner integration", () => {
  it("falls back to lexical and recovers the HTTP provider while the queue is idle", async () => {
    const provider = await serveEmbeddings();
    const db = openDb(":memory:");
    const runner = new ThreadIngestionRunner({
      embedder: {
        kind: "http",
        url: provider.url,
        model: "fake",
        apiKey: "super-secret-key",
        retryCooldownMs: 25,
      },
    });
    const { app, indexing } = await buildApp(db, false, undefined, runner);
    await app.ready();
    indexing.start();
    const indexes = new SqliteBookIndexRepository(db);
    try {
      const body = epubWithText(
        "Wiring fixture",
        "A needle sits in this passage together with enough surrounding words for a search hit.",
      );
      const response = await upload(app, body);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ index: { state: "pending", error: null } });
      const id = response.json().id as string;

      await waitFor(() => indexes.get(id)?.state === "ready", 20_000);
      expect(indexes.get(id)).toMatchObject({ state: "ready", indexVersion: "1|none" });

      const lexical = await app.inject({ method: "GET", url: "/api/passages/search?q=needle", headers: auth });
      expect(lexical.statusCode).toBe(200);
      expect(lexical.json()).toMatchObject({ mode: "lexical", coverage: { indexed: 1, total: 1 } });
      expect(lexical.json().hits[0].text).toContain("needle");
      await waitFor(async () => {
        const status = await app.inject({ method: "GET", url: "/api/index/status", headers: auth });
        return status.json().search.state === "unavailable";
      });

      provider.setHealthy(true);
      await waitFor(() => indexes.get(id)?.indexVersion === "1|http:fake" && indexes.get(id)?.state === "ready", 20_000);
      expect(indexes.get(id)).toMatchObject({ state: "ready", indexVersion: "1|http:fake" });

      const hybrid = await app.inject({ method: "GET", url: "/api/passages/search?q=needle", headers: auth });
      expect(hybrid.json()).toMatchObject({ mode: "hybrid" });
      expect(hybrid.json().hits[0].text).toContain("needle");

      const status = await app.inject({ method: "GET", url: "/api/index/status", headers: auth });
      expect(status.json().search).toMatchObject({
        semantic: true, embeddings: "http", model: "fake", state: "ready",
      });
      expect(status.body).not.toContain(provider.url);
      expect(status.body).not.toContain("super-secret-key");
      expect(provider.requests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await app.close();
      db.close();
      await provider.close();
    }
  }, 30_000);

  it("reindexes every book uploaded while the HTTP provider was already unavailable", async () => {
    const provider = await serveEmbeddings();
    const db = openDb(":memory:");
    const runner = new ThreadIngestionRunner({
      embedder: {
        kind: "http",
        url: provider.url,
        model: "fake",
        retryCooldownMs: 25,
      },
    });
    const { app, indexing } = await buildApp(db, false, undefined, runner);
    await app.ready();
    indexing.start();
    const indexes = new SqliteBookIndexRepository(db);
    try {
      const first = await upload(app, epubWithText("First fixture", "Alpha passage with enough words for a lexical hit."));
      const second = await upload(app, epubWithText("Second fixture", "Beta passage with enough words for a lexical hit."));
      const firstId = first.json().id as string;
      const secondId = second.json().id as string;

      await waitFor(() => indexes.get(firstId)?.state === "ready" && indexes.get(secondId)?.state === "ready", 20_000);
      expect(indexes.get(firstId)?.indexVersion).toBe("1|none");
      expect(indexes.get(secondId)?.indexVersion).toBe("1|none");

      provider.setHealthy(true);
      await waitFor(
        () => indexes.get(firstId)?.indexVersion === "1|http:fake" && indexes.get(secondId)?.indexVersion === "1|http:fake",
        20_000,
      );
      expect(indexes.get(firstId)?.state).toBe("ready");
      expect(indexes.get(secondId)?.state).toBe("ready");
    } finally {
      await app.close();
      db.close();
      await provider.close();
    }
  }, 30_000);
});
