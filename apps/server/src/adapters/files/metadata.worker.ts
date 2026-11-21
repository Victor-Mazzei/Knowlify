import { parentPort, type MessagePort } from "node:worker_threads";

import type { Extracted } from "../../ports/index.js";
import { extractEpub, extractPdf } from "./metadata.js";
import type { MetadataWorkerRequest, MetadataWorkerResponse, WorkerMetadata } from "./WorkerPoolMetadataExtractor.js";

const port = requirePort(parentPort);

function requirePort(value: typeof parentPort): MessagePort {
  if (!value) throw new Error("The metadata worker must run inside a worker thread");
  return value;
}

function post(message: MetadataWorkerResponse, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

function serialize(metadata: Extracted): { metadata: WorkerMetadata; transfer: ArrayBuffer[] } {
  const out: WorkerMetadata = {};
  if (metadata.title) out.title = metadata.title;
  if (metadata.author) out.author = metadata.author;
  const transfer: ArrayBuffer[] = [];
  if (metadata.cover) {
    // A copy gives the transfer an exact, non-shared ArrayBuffer and keeps the
    // original Buffer owned by this worker.
    const data = Uint8Array.from(metadata.cover.data);
    out.cover = { data, ext: metadata.cover.ext };
    transfer.push(data.buffer);
  }
  return { metadata: out, transfer };
}

port.on("message", (message: MetadataWorkerRequest) => {
  if (message.type !== "extract") return;
  const run = message.format === "epub" ? extractEpub(message.path) : extractPdf(message.path);
  void run.then(
    (metadata) => {
      const { metadata: payload, transfer } = serialize(metadata);
      post({ type: "result", id: message.id, metadata: payload }, transfer);
    },
    (error: unknown) => {
      post({ type: "failed", id: message.id, message: error instanceof Error ? error.message : String(error) });
    },
  );
});
