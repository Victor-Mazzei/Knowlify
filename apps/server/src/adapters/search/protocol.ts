import type { LexicalHit, PassageView, ScoredPassage, VectorFilter } from "../../ports/knowledge.js";

/** One request per message; `id` correlates the reply and never contains query text. */
export type SearchWorkerRequest =
  | { type: "lexical"; id: number; q: string; limit: number; bookId?: string }
  | { type: "hydrate"; id: number; ids: number[] }
  /** `epoch` is the sample offset captured by the API process with the request. */
  | { type: "nearest"; id: number; vector: Float32Array; limit: number; filter?: VectorFilter; epoch: number }
  | { type: "vector-count"; id: number }
  | { type: "close" };

export type SearchWorkerResponse =
  /** `complete` is false when the read only reached the cheap/fallback layer. */
  | { type: "lexical"; id: number; hits: LexicalHit[]; complete: boolean }
  | { type: "hydrate"; id: number; views: PassageView[] }
  | { type: "nearest"; id: number; hits: ScoredPassage[] }
  | { type: "vector-count"; id: number; count: number }
  /** Only the error class travels: SQLite messages never reach the log or the client. */
  | { type: "error"; id: number; errorType: string };
