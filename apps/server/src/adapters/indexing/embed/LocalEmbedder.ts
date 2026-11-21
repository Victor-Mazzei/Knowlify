import { availableParallelism } from "node:os";
import type { EmbeddingsStatus } from "../../../ports/knowledge.js";
import { EMBED_BATCH_SIZE, chunked, normalize, type Embedder } from "./Embedder.js";

/** Hugging Face model ids only: a URL can never reach the downloader. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Mirrors the `KNOWLIFY_EMBEDDINGS_THREADS` default; the worker process is CPU-bound. */
export const DEFAULT_EMBEDDING_THREADS = Math.max(1, Math.min(4, availableParallelism()));

export function resolveEmbeddingThreads(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EMBEDDING_THREADS;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_EMBEDDING_THREADS;
}

interface SessionOptions {
  intraOpNumThreads: number;
  interOpNumThreads: number;
  /** ORT only prints errors: the affinity warning is noise once threads are explicit. */
  logSeverityLevel: number;
}

interface FeatureExtractionOutput {
  data: Float32Array | number[];
  dims: number[];
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<FeatureExtractionOutput>;

interface TransformersModule {
  env: { allowRemoteModels?: boolean; allowLocalModels?: boolean; cacheDir?: string | null };
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { dtype: "q8"; session_options: SessionOptions },
  ): Promise<FeatureExtractor>;
}

export type TransformersLoader = () => Promise<unknown>;

export interface LocalEmbedderOptions {
  model: string;
  modelsDir: string;
  offline: boolean;
  /** Explicit ORT thread count; disabling the automatic affinity probe is the point. */
  threads?: number;
  /** Test seam; production uses the optional `@huggingface/transformers` package. */
  loadModule?: TransformersLoader;
  log?: (message: string, error?: unknown) => void;
}

function isTransformersModule(value: unknown): value is TransformersModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { pipeline?: unknown; env?: unknown };
  return typeof candidate.pipeline === "function" && typeof candidate.env === "object" && candidate.env !== null;
}

function toVectors(output: FeatureExtractionOutput, count: number): Float32Array[] | null {
  if (!Array.isArray(output.dims) || output.dims.length !== 2 || output.dims[0] !== count) return null;
  const dimension = output.dims[1];
  if (!Number.isInteger(dimension) || dimension <= 0) return null;
  const data = output.data;
  if (!data || data.length !== count * dimension) return null;
  const vectors: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const vector = new Float32Array(dimension);
    for (let offset = 0; offset < dimension; offset += 1) {
      const value = data[index * dimension + offset];
      if (!Number.isFinite(value)) return null;
      vector[offset] = value;
    }
    vectors.push(normalize(vector));
  }
  return vectors;
}

/**
 * Multilingual sentence embeddings running on the CPU inside the worker.
 * The model is downloaded from Hugging Face only when the operator enabled
 * local embeddings; `offline` forbids every network access.
 */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  private state: EmbeddingsStatus["state"] = "off";
  private extractor: FeatureExtractor | null = null;
  private dimension: number | null = null;
  private readonly threads: number;
  private readonly loadModule: TransformersLoader;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: LocalEmbedderOptions) {
    this.id = `local:${options.model}`;
    this.threads = resolveEmbeddingThreads(options.threads);
    this.loadModule = options.loadModule ?? (async () => {
      const specifier = "@huggingface/transformers";
      const module: unknown = await import(specifier);
      return module;
    });
    this.log = options.log ?? (() => {});
  }

  status(): EmbeddingsStatus {
    return { mode: "local", model: this.options.model, state: this.state };
  }

  async prepare(): Promise<boolean> {
    if (this.state === "ready") return true;
    if (this.state === "unavailable") return false;
    this.state = "loading";
    try {
      if (!MODEL_ID.test(this.options.model)) throw new Error("Invalid embedding model id");
      const module = await this.loadModule();
      if (!isTransformersModule(module)) throw new Error("Embedding runtime is not installed");
      module.env.cacheDir = this.options.modelsDir;
      module.env.allowRemoteModels = !this.options.offline;
      module.env.allowLocalModels = true;
      this.extractor = await module.pipeline("feature-extraction", this.options.model, {
        dtype: "q8",
        session_options: {
          intraOpNumThreads: this.threads,
          interOpNumThreads: 1,
          logSeverityLevel: 3,
        },
      });
      this.state = "ready";
      return true;
    } catch (error) {
      this.degrade(error);
      return false;
    }
  }

  async embedPassages(texts: string[]): Promise<Float32Array[] | null> {
    if (!(await this.prepare()) || !this.extractor) return null;
    try {
      const vectors: Float32Array[] = [];
      for (const batch of chunked(texts, EMBED_BATCH_SIZE)) {
        const output = await this.extractor(batch.map((text) => `passage: ${text}`), { pooling: "mean", normalize: true });
        const parsed = this.accept(output, batch.length);
        if (!parsed) throw new Error("Unexpected embedding output");
        vectors.push(...parsed);
      }
      return vectors;
    } catch (error) {
      this.degrade(error);
      return null;
    }
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!(await this.prepare()) || !this.extractor) return null;
    try {
      const output = await this.extractor([`query: ${text}`], { pooling: "mean", normalize: true });
      return this.accept(output, 1)?.[0] ?? null;
    } catch (error) {
      this.degrade(error);
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.extractor = null;
    this.state = "off";
    this.dimension = null;
  }

  private accept(output: FeatureExtractionOutput, count: number): Float32Array[] | null {
    const vectors = toVectors(output, count);
    if (!vectors?.length) return null;
    const dimension = vectors[0].length;
    if (this.dimension !== null && this.dimension !== dimension) throw new Error("Embedding dimension changed");
    this.dimension = dimension;
    return vectors;
  }

  private degrade(error: unknown): void {
    this.state = "unavailable";
    this.extractor = null;
    this.log("Local embeddings unavailable, falling back to lexical search", error);
  }
}
