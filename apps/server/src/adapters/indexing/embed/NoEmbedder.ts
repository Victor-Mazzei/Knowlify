import type { EmbeddingsStatus } from "../../../ports/knowledge.js";
import type { Embedder } from "./Embedder.js";

/** Lexical-only mode: no vectors are produced and no model is ever loaded. */
export class NoEmbedder implements Embedder {
  readonly id = "none";

  status(): EmbeddingsStatus {
    return { mode: "none", model: null, state: "off" };
  }

  async prepare(): Promise<boolean> {
    return false;
  }

  async embedPassages(_texts: string[]): Promise<null> {
    return null;
  }

  async embedQuery(_text: string): Promise<null> {
    return null;
  }

  async dispose(): Promise<void> {}
}
