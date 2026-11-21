import type { Embedder } from "./Embedder.js";
import { NoEmbedder } from "./NoEmbedder.js";
import { LocalEmbedder, type TransformersLoader } from "./LocalEmbedder.js";
import { HttpEmbedder } from "./HttpEmbedder.js";

export type EmbedderConfig =
  | { kind: "none" }
  | {
      kind: "local";
      model: string;
      modelsDir: string;
      offline: boolean;
      /** Explicit ORT thread count; LocalEmbedder applies its default when absent. */
      threads?: number;
    }
  | {
      kind: "http";
      url: string;
      model: string;
      apiKey?: string;
      timeoutMs?: number;
      maxResponseBytes?: number;
      retryCooldownMs?: number;
    };

export interface CreateEmbedderOptions {
  log?: (message: string, error?: unknown) => void;
  /** Test seam; production loads the optional package inside the worker. */
  loadModule?: TransformersLoader;
}

export function createEmbedder(settings: EmbedderConfig, options: CreateEmbedderOptions = {}): Embedder {
  const log = options.log ?? (() => {});
  switch (settings.kind) {
    case "local":
      return new LocalEmbedder({
        model: settings.model,
        modelsDir: settings.modelsDir,
        offline: settings.offline,
        threads: settings.threads,
        log,
        ...(options.loadModule ? { loadModule: options.loadModule } : {}),
      });
    case "http":
      return new HttpEmbedder({
        url: settings.url,
        model: settings.model,
        apiKey: settings.apiKey,
        timeoutMs: settings.timeoutMs,
        maxResponseBytes: settings.maxResponseBytes,
        retryCooldownMs: settings.retryCooldownMs,
        log,
      });
    default:
      return new NoEmbedder();
  }
}

export type { Embedder } from "./Embedder.js";
