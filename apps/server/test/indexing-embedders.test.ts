import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { availableParallelism } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { createEmbedder } from "../src/adapters/indexing/embed/create.js";
import { HttpEmbedder } from "../src/adapters/indexing/embed/HttpEmbedder.js";
import { DEFAULT_EMBEDDING_THREADS, LocalEmbedder } from "../src/adapters/indexing/embed/LocalEmbedder.js";
import { NoEmbedder } from "../src/adapters/indexing/embed/NoEmbedder.js";
import { EMBED_BATCH_SIZE } from "../src/adapters/indexing/embed/Embedder.js";

const servers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of servers.reverse()) await close();
});

interface Request {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

async function serve(handler: (request: Request, response: ServerResponse) => void): Promise<{ url: string; requests: Request[] }> {
  const requests: Request[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const record = { url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(record);
      handler(record, response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${port}/v1`, requests };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const embeddings = (inputs: string[], dimension = 2) => ({
  data: inputs.map((_, index) => ({ embedding: Array.from({ length: dimension }, () => index + 1), index })),
});

describe("HTTP embeddings", () => {
  it("sends batches of at most 32 inputs and L2-normalizes the vectors", async () => {
    const server = await serve((request, response) => {
      const payload = JSON.parse(request.body) as { input: string[] };
      json(response, 200, { data: payload.input.map((_, index) => ({ embedding: [3, 4], index })) });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "fake-model", apiKey: "top-secret" });
    const vectors = await embedder.embedPassages(Array.from({ length: EMBED_BATCH_SIZE + 4 }, (_, index) => `text ${index}`));

    expect(vectors).toHaveLength(EMBED_BATCH_SIZE + 4);
    expect(vectors?.[0][0]).toBeCloseTo(0.6);
    expect(vectors?.[0][1]).toBeCloseTo(0.8);
    expect(server.requests.map((request) => (JSON.parse(request.body) as { input: string[] }).input.length)).toEqual([
      EMBED_BATCH_SIZE,
      4,
    ]);
    expect(server.requests[0].headers.authorization).toBe("Bearer top-secret");
    expect((JSON.parse(server.requests[0].body) as { model: string }).model).toBe("fake-model");
    expect(embedder.status()).toEqual({ mode: "http", model: "fake-model", state: "ready" });
  });

  it("uses the query path for single inputs", async () => {
    const server = await serve((request, response) => {
      const payload = JSON.parse(request.body) as { input: string[] };
      json(response, 200, embeddings(payload.input));
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedQuery("hello")).toHaveLength(2);
    expect((JSON.parse(server.requests[0].body) as { input: string[] }).input).toEqual(["hello"]);
  });

  it("keeps response order when the provider omits indexes", async () => {
    const server = await serve((_, response) => {
      json(response, 200, { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    const vectors = await embedder.embedPassages(["first", "second"]);
    expect(vectors?.map((vector) => Array.from(vector))).toEqual([[1, 0], [0, 1]]);
  });

  it("reorders indexed vectors before matching them to inputs", async () => {
    const server = await serve((_, response) => {
      json(response, 200, {
        data: [
          { embedding: [0, 1], index: 1 },
          { embedding: [1, 0], index: 0 },
        ],
      });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    const vectors = await embedder.embedPassages(["first", "second"]);
    expect(vectors?.map((vector) => Array.from(vector))).toEqual([[1, 0], [0, 1]]);
  });

  it("rejects a batch whose vectors have inconsistent dimensions", async () => {
    const server = await serve((_, response) => {
      json(response, 200, {
        data: [
          { embedding: [1, 0], index: 0 },
          { embedding: [1, 0, 0], index: 1 },
        ],
      });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["first", "second"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
  });

  it.each([
    { name: "duplicate", indexes: [0, 0] },
    { name: "out-of-range", indexes: [0, 2] },
    { name: "negative", indexes: [0, -1] },
    { name: "fractional", indexes: [0, 0.5] },
  ])("rejects $name indexes", async ({ indexes }) => {
    const server = await serve((_, response) => {
      json(response, 200, { data: indexes.map((index) => ({ embedding: [1, 0], index })) });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["first", "second"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
  });

  it("rejects replies that mix indexed and unindexed entries", async () => {
    const server = await serve((_, response) => {
      json(response, 200, { data: [{ embedding: [1, 0] }, { embedding: [0, 1], index: 1 }] });
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["first", "second"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
  });

  it("degrades to lexical on 401 without leaking the key", async () => {
    const logs: string[] = [];
    const server = await serve((_, response) => json(response, 401, { error: "invalid api key" }));
    const embedder = new HttpEmbedder({ url: server.url, model: "m", apiKey: "super-secret", log: (message) => logs.push(message) });
    expect(await embedder.embedPassages(["secret"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
    expect(logs.join(" ")).not.toContain("super-secret");
    expect(logs.join(" ")).not.toContain("invalid api key");
  });

  it("gives up when the provider does not answer in time", async () => {
    const server = await serve(() => {
      /* never answers */
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m", timeoutMs: 50 });
    expect(await embedder.embedPassages(["slow"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
  });

  it("refuses oversized responses", async () => {
    const server = await serve((_, response) => json(response, 200, { data: [{ embedding: [1, 2] }], padding: "x".repeat(4_096) }));
    const embedder = new HttpEmbedder({ url: server.url, model: "m", maxResponseBytes: 64 });
    expect(await embedder.embedPassages(["big"])).toBeNull();
  });

  it("refuses redirects", async () => {
    const server = await serve((_, response) => {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["redirect"])).toBeNull();
  });

  it("rejects dimension changes and invalid configuration", async () => {
    let call = 0;
    const server = await serve((request, response) => {
      call += 1;
      const payload = JSON.parse(request.body) as { input: string[] };
      json(response, 200, call === 1 ? embeddings(payload.input, 2) : embeddings(payload.input, 3));
    });
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["one"])).toHaveLength(1);
    expect(await embedder.embedPassages(["two"])).toBeNull();
    for (const url of ["ftp://example.com", "http://user:pass@example.com", "not a url"]) {
      const invalid = new HttpEmbedder({ url, model: "m" });
      expect(await invalid.prepare()).toBe(false);
      expect(await invalid.embedPassages(["x"])).toBeNull();
    }
  });

  it("treats malformed replies as unavailable", async () => {
    const server = await serve((_, response) => json(response, 200, { data: [{ embedding: "nope" }] }));
    const embedder = new HttpEmbedder({ url: server.url, model: "m" });
    expect(await embedder.embedPassages(["x"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
  });

  it("probes the provider only after the cooldown and doubles the backoff while it stays down", async () => {
    let healthy = false;
    const server = await serve((request, response) => {
      if (!healthy) {
        json(response, 500, { error: "down" });
        return;
      }
      const payload = JSON.parse(request.body) as { input: string[] };
      json(response, 200, embeddings(payload.input));
    });
    let now = 1_000;
    const embedder = new HttpEmbedder({
      url: server.url,
      model: "m",
      retryCooldownMs: 1_000,
      now: () => now,
    });

    expect(await embedder.embedPassages(["first"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");
    const baseRequests = server.requests.length;

    now = 1_999;
    expect(await embedder.prepare()).toBe(false);
    expect(server.requests).toHaveLength(baseRequests);

    now = 2_000;
    expect(await embedder.prepare()).toBe(false);
    expect(server.requests).toHaveLength(baseRequests + 1);
    expect(embedder.status().state).toBe("unavailable");
    expect(embedder.retryInMs()).toBe(2_000);

    healthy = true;
    now = 3_999;
    expect(await embedder.prepare()).toBe(false);
    expect(server.requests).toHaveLength(baseRequests + 1);

    now = 4_000;
    expect(await embedder.prepare()).toBe(true);
    expect(embedder.status().state).toBe("ready");
    expect(embedder.retryInMs()).toBeNull();

    healthy = false;
    expect(await embedder.embedPassages(["second"])).toBeNull();
    expect(embedder.retryInMs()).toBe(1_000);
  });
});

describe("lexical embeddings", () => {
  it("never produces vectors", async () => {
    const embedder = new NoEmbedder();
    expect(embedder.status()).toEqual({ mode: "none", model: null, state: "off" });
    expect(await embedder.prepare()).toBe(false);
    expect(await embedder.embedPassages(["x"])).toBeNull();
    expect(await embedder.embedQuery("x")).toBeNull();
    expect(embedder.id).toBe("none");
  });
});

interface SessionOptions {
  intraOpNumThreads: number;
  interOpNumThreads: number;
  logSeverityLevel: number;
}

interface TransformersStub {
  cacheDir: string | null;
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  calls: Array<{ task: string; model: string; dtype: string; sessionOptions: SessionOptions }>;
  inputs: string[][];
  dispose(): void;
  module: unknown;
}

function transformersStub(options: { dimension?: number; fail?: boolean } = {}): TransformersStub {
  const stub: TransformersStub = {
    cacheDir: null,
    allowRemoteModels: true,
    allowLocalModels: false,
    calls: [],
    inputs: [],
    dispose() {},
    module: null,
  };
  let dimension = options.dimension ?? 3;
  stub.module = {
    env: stub,
    async pipeline(task: string, model: string, config: { dtype: string; session_options: SessionOptions }) {
      stub.calls.push({ task, model, dtype: config.dtype, sessionOptions: config.session_options });
      if (options.fail) throw new Error("model download failed");
      return async (texts: string[]) => {
        stub.inputs.push(texts);
        const data = new Float32Array(texts.length * dimension);
        for (let index = 0; index < data.length; index += 1) data[index] = (index % dimension) + 1;
        return { data, dims: [texts.length, dimension] };
      };
    },
  };
  stub.dispose = () => {
    dimension = 4;
  };
  return stub;
}

describe("local embeddings", () => {
  it("degrades when the optional runtime is missing instead of throwing", async () => {
    const embedder = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      modelsDir: "/tmp/models",
      offline: true,
      loadModule: async () => {
        throw new Error("Cannot find module '@huggingface/transformers'");
      },
    });
    expect(await embedder.prepare()).toBe(false);
    expect(embedder.status()).toEqual({ mode: "local", model: "Xenova/multilingual-e5-small", state: "unavailable" });
    expect(await embedder.embedPassages(["x"])).toBeNull();
  });

  it("loads the model with the operator cache, offline rules and E5 prefixes", async () => {
    const stub = transformersStub();
    const embedder = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      modelsDir: "/data/models",
      offline: true,
      loadModule: async () => stub.module,
    });
    await expect(embedder.prepare()).resolves.toBe(true);
    expect(stub.cacheDir).toBe("/data/models");
    expect(stub.allowRemoteModels).toBe(false);
    expect(stub.allowLocalModels).toBe(true);
    expect(stub.calls).toEqual([{
      task: "feature-extraction",
      model: "Xenova/multilingual-e5-small",
      dtype: "q8",
      sessionOptions: {
        intraOpNumThreads: DEFAULT_EMBEDDING_THREADS,
        interOpNumThreads: 1,
        logSeverityLevel: 3,
      },
    }]);

    const vectors = await embedder.embedPassages(["hello", "world"]);
    expect(vectors).toHaveLength(2);
    expect(stub.inputs[0]).toEqual(["passage: hello", "passage: world"]);
    await embedder.embedQuery("question");
    expect(stub.inputs[1]).toEqual(["query: question"]);
    expect(embedder.status().state).toBe("ready");
  });

  it("defaults to min(4, availableParallelism()) threads", () => {
    expect(DEFAULT_EMBEDDING_THREADS).toBe(Math.max(1, Math.min(4, availableParallelism())));
  });

  it.each([
    { threads: 1, expected: 1 },
    { threads: 6, expected: 6 },
    { threads: 0, expected: DEFAULT_EMBEDDING_THREADS },
    { threads: -2, expected: DEFAULT_EMBEDDING_THREADS },
    { threads: 1.5, expected: DEFAULT_EMBEDDING_THREADS },
    { threads: Number.NaN, expected: DEFAULT_EMBEDDING_THREADS },
  ])("uses $threads ORT threads and rejects invalid counts", async ({ threads, expected }) => {
    const stub = transformersStub();
    const embedder = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      modelsDir: "/tmp/models",
      offline: true,
      threads,
      loadModule: async () => stub.module,
    });
    await expect(embedder.prepare()).resolves.toBe(true);
    expect(stub.calls[0]?.sessionOptions).toEqual({
      intraOpNumThreads: expected,
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
  });

  it("forwards the thread count carried by the embedder config", async () => {
    const stub = transformersStub();
    const embedder = createEmbedder(
      {
        kind: "local",
        model: "Xenova/multilingual-e5-small",
        modelsDir: "/tmp/models",
        offline: true,
        threads: 2,
      },
      { loadModule: async () => stub.module },
    );
    await expect(embedder.prepare()).resolves.toBe(true);
    expect(stub.calls[0]?.sessionOptions.intraOpNumThreads).toBe(2);
    expect(stub.calls[0]?.sessionOptions.interOpNumThreads).toBe(1);
  });

  it("never sends a URL to the model loader", async () => {
    const stub = transformersStub();
    const embedder = new LocalEmbedder({
      model: "https://evil.example/model",
      modelsDir: "/tmp/models",
      offline: false,
      loadModule: async () => stub.module,
    });
    expect(await embedder.prepare()).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("degrades when inference fails or the dimension changes", async () => {
    const failing = transformersStub({ fail: true });
    const embedder = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      modelsDir: "/tmp/models",
      offline: true,
      loadModule: async () => failing.module,
    });
    expect(await embedder.embedPassages(["x"])).toBeNull();
    expect(embedder.status().state).toBe("unavailable");

    const stub = transformersStub({ dimension: 2 });
    const changing = new LocalEmbedder({
      model: "Xenova/multilingual-e5-small",
      modelsDir: "/tmp/models",
      offline: true,
      loadModule: async () => stub.module,
    });
    expect(await changing.embedPassages(["a"])).toHaveLength(1);
    stub.dispose();
    expect(await changing.embedPassages(["b"])).toBeNull();
    expect(changing.status().state).toBe("unavailable");
  });
});
