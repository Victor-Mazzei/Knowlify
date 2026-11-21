import type { Db } from "./db.js";
import type { VectorFilter, VectorStore } from "../../ports/knowledge.js";

/** Scan page size; keeps each event-loop turn short while the index grows. */
const BATCH_SIZE = 2_000;
/** Bounds the IN list when a lexical pre-filter selects many books. */
const MAX_FILTER_BOOKS = 500;

interface VectorRow {
  chunk_id: number;
  vec: Buffer;
}

/**
 * Exact cosine search over float32 BLOBs. Vectors are written L2-normalized, so the dot
 * product is the cosine. Reads happen in bounded pages and yield between them so HTTP
 * handlers keep running; a native ANN index can replace this adapter later.
 */
export class SqliteBlobVectorStore implements VectorStore {
  constructor(private db: Db) {}

  count(): number {
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
      const byBook = this.db.prepare("SELECT chunk_id, vec FROM chunk_vectors WHERE book_id = ?");
      for (const bookId of bookIds) {
        scan(byBook.all(bookId) as VectorRow[]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return top.sortedDescending();
    }

    const conditions = ["chunk_id > ?"];
    const leading: unknown[] = [];
    if (filter.bookId) {
      conditions.push("book_id = ?");
      leading.push(filter.bookId);
    }
    const statement = this.db.prepare(
      `SELECT chunk_id, vec FROM chunk_vectors WHERE ${conditions.join(" AND ")} ORDER BY chunk_id LIMIT ?`,
    );
    let lastId = 0;
    for (;;) {
      const rows = statement.all(lastId, ...leading, BATCH_SIZE) as VectorRow[];
      if (!rows.length) break;
      for (const row of rows) lastId = row.chunk_id;
      scan(rows);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return top.sortedDescending();
  }
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
