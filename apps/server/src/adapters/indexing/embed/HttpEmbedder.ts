import type { EmbeddingsStatus } from "../../../ports/knowledge.js";
import { EMBED_BATCH_SIZE, chunked, normalize, type Embedder } from "./Embedder.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETRY_COOLDOWN_MS = 60_000;
const MAX_RETRY_COOLDOWN_MS = 10 * 60_000;

export interface HttpEmbedderOptions {
  /** Base URL of an OpenAI-compatible API, e.g. http://localhost:11434/v1 */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** First retry delay; doubles on every failed probe up to 10 minutes. */
  retryCooldownMs?: number;
  /** Test seam; production uses `Date.now`. */
  now?: () => number;
  /** Test seam; production uses the global fetch. */
  fetch?: typeof globalThis.fetch;
  log?: (message: string, error?: unknown) => void;
}

export interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index?: number }>;
}

function isEmbeddingResponse(value: unknown): value is EmbeddingResponse {
  if (typeof value !== "object" || value === null) return false;
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) && data.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const embedding = (entry as { embedding?: unknown }).embedding;
    return Array.isArray(embedding) && embedding.every((component) => typeof component === "number");
  });
}

/**
 * Maps response entries back to the request order. Providers may omit `index`
 * (response order is then authoritative) or return a partially/duplicated set
 * of indexes; the latter cannot be assigned safely and is rejected.
 */
function orderEmbeddings(data: EmbeddingResponse["data"], expectedCount: number): EmbeddingResponse["data"] {
  if (data.every((entry) => entry.index === undefined)) return data;
  const ordered: EmbeddingResponse["data"] = new Array(expectedCount);
  const seen = new Set<number>();
  for (const entry of data) {
    const index = entry.index;
    if (index === undefined) throw new Error("Unexpected embedding response");
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new Error("Unexpected embedding response index");
    }
    if (seen.has(index)) throw new Error("Duplicate embedding response index");
    seen.add(index);
    ordered[index] = entry;
  }
  return ordered;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Embedding response is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * OpenAI-compatible embeddings over HTTP. The URL and key belong to the
 * operator (environment only): private addresses are allowed here on purpose,
 * while redirects, oversized bodies and slow servers are refused.
 */
export class HttpEmbedder implements Embedder {
  readonly id: string;
  private state: EmbeddingsStatus["state"] = "ready";
  private dimension: number | null = null;
  private unavailableUntil = 0;
  private endpoint: string | null = null;
  private probe: Promise<boolean> | null = null;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly baseCooldownMs: number;
  private cooldownMs: number;
  private readonly now: () => number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly log: (message: string, error?: unknown) => void;

  constructor(private readonly options: HttpEmbedderOptions) {
    this.id = `http:${options.model}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.baseCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    this.cooldownMs = this.baseCooldownMs;
    this.now = options.now ?? Date.now;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.log = options.log ?? (() => {});
    this.endpoint = this.parseEndpoint();
  }

  status(): EmbeddingsStatus {
    return { mode: "http", model: this.options.model, state: this.state };
  }

  async prepare(): Promise<boolean> {
    if (!this.endpoint) {
      this.degrade("Invalid embeddings URL", undefined);
      return false;
    }
    if (this.state === "ready") return true;
    if (this.state !== "unavailable") return false;
    if (this.probe) return this.probe;
    if (this.now() < this.unavailableUntil) return false;
    this.probe = this.probeProvider();
    try {
      return await this.probe;
    } finally {
      this.probe = null;
    }
  }

  retryInMs(): number | null {
    if (this.state !== "unavailable") return null;
    return Math.max(0, this.unavailableUntil - this.now());
  }

  async embedPassages(texts: string[]): Promise<Float32Array[] | null> {
    if (!(await this.prepare())) return null;
    try {
      const vectors: Float32Array[] = [];
      for (const batch of chunked(texts, EMBED_BATCH_SIZE)) {
        vectors.push(...(await this.request(batch)));
      }
      return vectors;
    } catch (error) {
      this.degrade("Embedding request failed, falling back to lexical search", error);
      return null;
    }
  }

  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!(await this.prepare())) return null;
    try {
      return (await this.request([text]))[0] ?? null;
    } catch (error) {
      this.degrade("Embedding request failed", error);
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.state = "off";
  }

  private parseEndpoint(): string | null {
    try {
      const url = new URL(this.options.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.username || url.password) return null;
      url.hash = "";
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/embeddings`;
      return url.toString();
    } catch {
      return null;
    }
  }

  private async request(texts: string[]): Promise<Float32Array[]> {
    if (!this.endpoint) throw new Error("Invalid embeddings URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.options.model, input: texts }),
      });
      if (!response.ok) throw new Error(`Embedding provider returned status ${response.status}`);
      const body = await readLimited(response, this.maxResponseBytes);
      const parsed: unknown = JSON.parse(body);
      if (!isEmbeddingResponse(parsed) || parsed.data.length !== texts.length) {
        throw new Error("Unexpected embedding response");
      }
      const ordered = orderEmbeddings(parsed.data, texts.length);
      const vectors = ordered.map((entry) => {
        if (!entry.embedding.length) throw new Error("Empty embedding vector");
        const vector = new Float32Array(entry.embedding.length);
        for (let index = 0; index < entry.embedding.length; index += 1) {
          const value = entry.embedding[index];
          if (!Number.isFinite(value)) throw new Error("Invalid embedding vector");
          vector[index] = value;
        }
        return normalize(vector);
      });
      const dimension = vectors[0].length;
      if (vectors.some((vector) => vector.length !== dimension)) {
        throw new Error("Embedding vectors have inconsistent dimensions");
      }
      if (this.dimension !== null && this.dimension !== dimension) throw new Error("Embedding dimension changed");
      this.dimension = dimension;
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Real probe after the cooldown. Marking the provider ready optimistically
   * would reindex the library against a provider that is still down.
   */
  private async probeProvider(): Promise<boolean> {
    try {
      await this.request(["ping"]);
      this.state = "ready";
      this.cooldownMs = this.baseCooldownMs;
      this.unavailableUntil = 0;
      return true;
    } catch (error) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_RETRY_COOLDOWN_MS);
      this.state = "unavailable";
      this.unavailableUntil = this.now() + this.cooldownMs;
      this.log("Embedding provider is still unavailable", error);
      return false;
    }
  }

  private degrade(message: string, error: unknown): void {
    this.state = "unavailable";
    this.unavailableUntil = this.now() + this.cooldownMs;
    this.log(message, error);
  }
}
