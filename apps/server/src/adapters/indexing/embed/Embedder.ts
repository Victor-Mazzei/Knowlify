import type { EmbeddingsStatus } from "../../../ports/knowledge.js";

/** Hard cap for one embedding request, shared by every provider. */
export const EMBED_BATCH_SIZE = 32;

export interface Embedder {
  /** Stable identifier used in the index version, e.g. `none` or `local:model`. */
  readonly id: string;
  status(): EmbeddingsStatus;
  /**
   * Loads or validates the provider. Resolves false when the provider cannot
   * be used, in which case ingestion continues with lexical search only.
   */
  prepare(): Promise<boolean>;
  embedPassages(texts: string[]): Promise<Float32Array[] | null>;
  embedQuery(text: string): Promise<Float32Array | null>;
  /**
   * Milliseconds until the next recovery probe, or null when no probe is due.
   * Only providers that can recover on their own implement it.
   */
  retryInMs?(): number | null;
  dispose(): Promise<void>;
}

export function chunked<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/** L2-normalizes a vector so a dot product is a cosine similarity. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!Number.isFinite(length) || length === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / length;
  return out;
}
