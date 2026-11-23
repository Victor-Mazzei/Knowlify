import type {
  LexicalHit,
  LexicalQueryResult,
  PassageQueryStore,
  PassageRepository,
  PassageView,
  ScoredPassage,
  VectorFilter,
  VectorStore,
} from "../../ports/knowledge.js";

/**
 * In-process implementation of the retrieval read model. Used for in-memory databases
 * (tests) and anywhere a worker thread is not available; every call is synchronous
 * inside, so a caller that needs a responsive event loop must use the worker adapter.
 */
export class SqlitePassageQueryStore implements PassageQueryStore {
  constructor(
    private readonly passages: PassageRepository,
    private readonly vectors: VectorStore,
  ) {}

  async searchLexical(q: string, limit: number, bookId?: string): Promise<LexicalHit[]> {
    return (await this.searchLexicalResult(q, limit, bookId)).hits;
  }

  async searchLexicalResult(q: string, limit: number, bookId?: string): Promise<LexicalQueryResult> {
    return this.passages.searchLexicalResult(q, limit, bookId);
  }

  async hydrate(ids: number[]): Promise<PassageView[]> {
    return this.passages.hydrate(ids);
  }

  async nearest(query: Float32Array, limit: number, filter?: VectorFilter): Promise<ScoredPassage[]> {
    return this.vectors.nearest(query, limit, filter);
  }

  async vectorCount(): Promise<number> {
    return this.vectors.count();
  }

  /** Nothing to release: the connection belongs to the composing process. */
  async close(): Promise<void> {}
}
