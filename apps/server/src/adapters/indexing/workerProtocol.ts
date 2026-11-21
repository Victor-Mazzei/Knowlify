import type { IndexErrorCode, Passage } from "../../domain/knowledge/BookIndex.js";
import type { EmbeddingsStatus, IngestJob } from "../../ports/knowledge.js";
import type { EmbedderConfig } from "./embed/create.js";

export interface RunLimits {
  maxBytes: number;
}

/** Messages sent by the main thread to the ingestion worker. */
export type WorkerRequest =
  | { type: "run"; job: IngestJob; embedder: EmbedderConfig; limits: RunLimits; chunking: "domain" | "paragraph" }
  | { type: "query"; id: number; text: string; embedder: EmbedderConfig }
  | { type: "batch-ack"; id: number }
  | { type: "cancel" }
  | { type: "close" };

/** Messages sent by the ingestion worker to the main thread. */
export type WorkerResponse =
  | { type: "started"; contentHash: string | null }
  | { type: "batch"; id: number; passages: Passage[]; vectors: Float32Array[] | null }
  | { type: "progress"; fraction: number }
  | { type: "done"; contentHash: string; chunkCount: number; indexVersion: string }
  | { type: "unchanged"; contentHash: string; indexVersion: string }
  | { type: "failed"; code: IndexErrorCode; message: string }
  | { type: "query-result"; id: number; vector: Float32Array | null }
  | { type: "embeddings"; status: EmbeddingsStatus };
