import type { Db } from "./db.js";
import type { VectorFilter, VectorStore } from "../../ports/knowledge.js";

/** Scan page size; keeps each event-loop turn short while the index grows. */
const BATCH_SIZE = 2_000;
/** Safety bound for a caller-provided book list; the normal sample is far smaller. */
const MAX_FILTER_BOOKS = 5_000;

interface VectorRow {
  chunk_id: number;
  vec: Buffer;
}

export interface SqliteBlobVectorStoreOptions {
  /**
   * Cache the vector count per SQLite `data_version`. Only safe when this connection does
   * not write: `data_version` changes when another connection commits, not on the writing
   * connection's own commits. Production uses this in the read-only search worker.
   */
  cacheCount?: boolean;
  /** Test seam: index epoch used for the rotating sample offset; defaults to data_version. */
  epoch?: () => number;
}

/**
 * Exact cosine search over float32 BLOBs. Vectors are written L2-normalized, so the dot
 * product is the cosine. Reads happen in bounded pages and yield between them so HTTP
 * handlers keep running; a native ANN index can replace this adapter later.
 */
export class SqliteBlobVectorStore implements VectorStore {
  private cachedVersion: number | null = null;
  private cachedCount = 0;
  private readonly cacheCount: boolean;
  private readonly epoch: () => number;

  constructor(private db: Db, options: SqliteBlobVectorStoreOptions = {}) {
    this.cacheCount = options.cacheCount ?? false;
    this.epoch = options.epoch ?? (() => this.db.pragma("data_version", { simple: true }) as number);
  }

  count(): number {
    if (!this.cacheCount) return this.queryCount();
    // `data_version` is a cheap change counter for commits made by other connections;
    // a checkpoint or a read does not bump it, so the cached count is never stale.
    const version = this.db.pragma("data_version", { simple: true }) as number;
    if (version !== this.cachedVersion) {
      this.cachedVersion = version;
      this.cachedCount = this.queryCount();
    }
    return this.cachedCount;
  }

  private queryCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM chunk_vectors").get() as { n: number }).n;
  }

  async nearest(
    query: Float32Array,
    limit: number,
    filter: VectorFilter = {},
  ): Promise<{ passageId: number; score: number }[]> {
    if (!query.length || limit <= 0) return [];
    const top = new TopK(limit);
    const bytesPerVector = query.byteLength;
    const scratch = { bytes: new Uint8Array(0) };
    const bookIds = filter.bookIds
      ? [...new Set(filter.bookIds)].slice(0, MAX_FILTER_BOOKS)
      : null;
    if (bookIds && bookIds.length === 0) return [];

    const scan = (rows: VectorRow[]): void => {
      for (const row of rows) {
        // A model change reindexes books; vectors from another dimension must not be mixed.
        if (row.vec.length % 4 !== 0 || row.vec.length !== bytesPerVector) continue;
        top.push(row.chunk_id, dot(query, row.vec, scratch));
      }
    };

    // A lexical pre-filter selects a handful of books: use chunk_vectors_book per book
    // instead of scanning the whole chunk_id range (which would defeat the ceiling).
    if (bookIds) {
      const includeSample = filter.includeSample === true && filter.maxVectors !== undefined;
      const candidates = includeSample
        ? this.withStrideSample(bookIds, filter.maxVectors!)
        : bookIds;
      await this.scanBookVectors(candidates, includeSample ? filter.maxVectors : undefined, scan);
      return top.sortedDescending();
    }
    if (filter.bookId) {
      await this.scanBookVectors([filter.bookId], undefined, scan);
      return top.sortedDescending();
    }

    // No book restriction and an index above the ceiling: examine a bounded, evenly
    // spread sample so semantic questions without lexical overlap still get an answer.
    const budget = filter.maxVectors;
    if (budget !== undefined) {
      if (budget <= 0) return [];
      const sample = this.sampleBooks(budget);
      if (sample) {
        await this.scanBookVectors(sample, budget, scan);
        return top.sortedDescending();
      }
    }

    const statement = this.db.prepare(
      "SELECT chunk_id, vec FROM chunk_vectors WHERE chunk_id > ? ORDER BY chunk_id LIMIT ?",
    );
    let lastId = 0;
    for (;;) {
      const rows = statement.all(lastId, BATCH_SIZE) as VectorRow[];
      if (!rows.length) break;
      for (const row of rows) lastId = row.chunk_id;
      scan(rows);
      await yieldToLoop();
    }
    return top.sortedDescending();
  }

  /** Reads the vectors of the given books, yielding between them and optionally capped. */
  private async scanBookVectors(
    bookIds: readonly string[],
    budget: number | undefined,
    scan: (rows: VectorRow[]) => void,
  ): Promise<void> {
    const statement = this.db.prepare("SELECT chunk_id, vec FROM chunk_vectors WHERE book_id = ? LIMIT ?");
    let remaining = budget ?? -1;
    for (const bookId of bookIds) {
      if (remaining === 0) return;
      const rows = statement.all(bookId, remaining) as VectorRow[];
      scan(rows);
      if (budget !== undefined) remaining -= rows.length;
      await yieldToLoop();
    }
  }

  /**
   * Picks books evenly across the **entire** eligible list, starting at an offset that
   * rotates with the index epoch (data_version). The total uses the cached count and the
   * book list comes from `book_index`, never from a full scan of `chunk_vectors`.
   */
  private sampleBooks(maxVectors: number): string[] | null {
    const vectors = this.count();
    if (vectors <= maxVectors) return null;
    const books = this.vectorBookIds();
    if (books.length === 0) return [];
    return this.strideSample(books, maxVectors, vectors);
  }

  /** Lexical candidates first, then a uniform stride sample of every eligible book. */
  private withStrideSample(lexical: readonly string[], maxVectors: number): string[] {
    const books = this.vectorBookIds();
    const sampled = this.strideSample(books, maxVectors, this.count());
    return [...new Set([...lexical, ...sampled])].slice(0, MAX_FILTER_BOOKS);
  }

  private strideSample(books: readonly string[], maxVectors: number, vectors: number): string[] {
    if (books.length === 0) return [];
    const sampleSize = Math.max(1, vectors > 0 ? Math.floor((maxVectors * books.length) / vectors) : books.length);
    const stride = Math.max(1, Math.ceil(books.length / sampleSize));
    const start = books.length > 0 ? ((this.epoch() % books.length) + books.length) % books.length : 0;
    const sampled: string[] = [];
    for (let step = 0; step < books.length; step += stride) {
      sampled.push(books[(start + step) % books.length]!);
    }
    return sampled;
  }

  /**
   * Books whose stored index version includes vectors. `book_index` is bounded by the
   * library size (thousands of rows), unlike `chunk_vectors` (millions). Test/ephemeral
   * databases that insert vectors without an index row fall back to a distinct scan; it
   * is no longer cut at the first 2,000 ids, so a high-id book can be sampled.
   */
  private vectorBookIds(): string[] {
    const indexed = this.db.prepare(`
      SELECT book_id FROM book_index
      WHERE state = 'ready' AND index_version IS NOT NULL
        AND index_version NOT LIKE '%|none' AND index_version NOT LIKE '%|lexical'
      ORDER BY book_id
    `).all() as { book_id: string }[];
    if (indexed.length > 0) return indexed.map((row) => row.book_id);
    const fallback = this.db.prepare(`
      SELECT DISTINCT book_id FROM chunk_vectors
      ORDER BY book_id
    `).all() as { book_id: string }[];
    return fallback.map((row) => row.book_id);
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Dot product over an aligned Float32Array. SQLite returns BLOBs as Buffers that may start
 * on an unaligned byte offset; those rare rows are copied into a reusable scratch buffer.
 * Both paths use the same IEEE-754 float32 arithmetic, so top-K results are identical.
 */
function dot(query: Float32Array, blob: Buffer, scratch: { bytes: Uint8Array }): number {
  const length = blob.length >>> 2;
  let vector: Float32Array;
  if ((blob.byteOffset & 3) === 0) {
    vector = new Float32Array(blob.buffer, blob.byteOffset, length);
  } else {
    if (scratch.bytes.length < blob.length) {
      scratch.bytes = new Uint8Array(blob.length);
    }
    scratch.bytes.set(blob);
    vector = new Float32Array(scratch.bytes.buffer, 0, length);
  }
  let score = 0;
  for (let index = 0; index < query.length; index += 1) score += query[index]! * vector[index]!;
  return score;
}

interface Scored {
  passageId: number;
  score: number;
}

class TopK {
  private heap: Scored[] = [];
  constructor(private limit: number) {}

  push(passageId: number, score: number): void {
    if (this.heap.length < this.limit) {
      this.heap.push({ passageId, score });
      this.bubbleUp(this.heap.length - 1);
    } else if (score > this.heap[0]!.score) {
      this.heap[0] = { passageId, score };
      this.sinkDown(0);
    }
  }

  sortedDescending(): Scored[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heap[parent]!.score <= this.heap[index]!.score) return;
      [this.heap[parent], this.heap[index]] = [this.heap[index]!, this.heap[parent]!];
      index = parent;
    }
  }

  private sinkDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.heap[left]!.score < this.heap[smallest]!.score) smallest = left;
      if (right < this.heap.length && this.heap[right]!.score < this.heap[smallest]!.score) smallest = right;
      if (smallest === index) return;
      [this.heap[smallest], this.heap[index]] = [this.heap[index]!, this.heap[smallest]!];
      index = smallest;
    }
  }
}
