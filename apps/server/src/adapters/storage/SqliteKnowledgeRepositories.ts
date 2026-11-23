import type Database from "better-sqlite3";
import type { Db } from "./db.js";
import {
  isDegradedVersion,
  isLexicalVersion,
  isVectorVersion,
  type BookIndex,
  type IndexErrorCode,
  type IndexState,
  type Passage,
} from "../../domain/knowledge/BookIndex.js";
import type {
  BookIndexRepository,
  PassageRepository,
  PassageView,
  PendingIndexUpsert,
} from "../../ports/knowledge.js";
import { toFtsPlan, type FtsPlanOptions } from "./ftsQuery.js";

export { toFtsPlan, toFtsQuery, type FtsPlan } from "./ftsQuery.js";

interface BookIndexRow {
  book_id: string;
  state: IndexState;
  priority: number;
  content_hash: string | null;
  index_version: string | null;
  fingerprint: string | null;
  chunk_count: number;
  attempts: number;
  next_attempt_at: number;
  error_code: IndexErrorCode | null;
  error_message: string | null;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function toBookIndex(row: BookIndexRow): BookIndex {
  return {
    bookId: row.book_id,
    state: row.state,
    priority: row.priority === 1 ? 1 : 0,
    contentHash: row.content_hash,
    indexVersion: row.index_version,
    fingerprint: row.fingerprint,
    chunkCount: row.chunk_count,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Shared upsert for the queue; the caller wraps it in a transaction. */
const UPSERT_PENDING = `
  INSERT INTO book_index (book_id, state, priority, content_hash, index_version, fingerprint, chunk_count,
    attempts, next_attempt_at, error_code, error_message, requested_at, started_at, finished_at)
  VALUES (@bookId, 'pending', @priority, NULL, NULL, @fingerprint, 0, 0, 0, NULL, NULL, @now, NULL, NULL)
  ON CONFLICT(book_id) DO UPDATE SET
    state = 'pending',
    priority = MAX(book_index.priority, excluded.priority),
    fingerprint = excluded.fingerprint,
    content_hash = CASE WHEN @resetAttempts THEN NULL ELSE book_index.content_hash END,
    attempts = CASE WHEN @resetAttempts THEN 0 ELSE book_index.attempts END,
    next_attempt_at = 0,
    error_code = NULL,
    error_message = NULL,
    requested_at = excluded.requested_at,
    started_at = NULL,
    finished_at = NULL
`;

/** The queue is the book_index table itself: pending rows are jobs. */
export class SqliteBookIndexRepository implements BookIndexRepository {
  private revisionCounter = 0;
  constructor(private db: Db) {}

  get(bookId: string): BookIndex | undefined {
    const row = this.db.prepare("SELECT * FROM book_index WHERE book_id = ?").get(bookId) as BookIndexRow | undefined;
    return row ? toBookIndex(row) : undefined;
  }

  upsertPending(i: PendingIndexUpsert): void {
    this.db.transaction(() => {
      const before = this.db.prepare("SELECT state FROM book_index WHERE book_id = ?").get(i.bookId) as { state: IndexState } | undefined;
      this.db.prepare(UPSERT_PENDING).run({
        bookId: i.bookId,
        priority: i.priority,
        fingerprint: i.fingerprint,
        now: i.now,
        resetAttempts: i.resetAttempts ? 1 : 0,
      });
      if (before?.state !== "pending") this.revisionCounter++;
    })();
  }

  upsertPendingMany(items: readonly PendingIndexUpsert[]): void {
    if (items.length === 0) return;
    this.db.transaction(() => {
      const select = this.db.prepare("SELECT state FROM book_index WHERE book_id = ?");
      const upsert = this.db.prepare(UPSERT_PENDING);
      let changed = false;
      for (const item of items) {
        const before = select.get(item.bookId) as { state: IndexState } | undefined;
        upsert.run({
          bookId: item.bookId,
          priority: item.priority,
          fingerprint: item.fingerprint,
          now: item.now,
          resetAttempts: item.resetAttempts ? 1 : 0,
        });
        if (before?.state !== "pending") changed = true;
      }
      if (changed) this.revisionCounter++;
    })();
  }

  claimNext(now: number): BookIndex | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM book_index
        WHERE state = 'pending' AND next_attempt_at <= ?
        ORDER BY priority DESC, requested_at ASC
        LIMIT 1
      `).get(now) as BookIndexRow | undefined;
      if (!row) return undefined;
      const result = this.db.prepare("UPDATE book_index SET state = 'indexing', started_at = ? WHERE book_id = ? AND state = 'pending'")
        .run(now, row.book_id);
      if (result.changes !== 1) return undefined;
      this.revisionCounter++;
      return toBookIndex({ ...row, state: "indexing", started_at: now });
    })();
  }

  nextDueAt(): number | null {
    const row = this.db.prepare("SELECT MIN(next_attempt_at) AS due FROM book_index WHERE state = 'pending'").get() as { due: number | null };
    return row.due;
  }

  save(index: BookIndex): void {
    this.db.transaction(() => {
      const before = this.db.prepare("SELECT state FROM book_index WHERE book_id = ?").get(index.bookId) as { state: IndexState } | undefined;
      this.db.prepare(`
        INSERT INTO book_index (book_id, state, priority, content_hash, index_version, fingerprint, chunk_count,
          attempts, next_attempt_at, error_code, error_message, requested_at, started_at, finished_at)
        VALUES (@bookId, @state, @priority, @contentHash, @indexVersion, @fingerprint, @chunkCount,
          @attempts, @nextAttemptAt, @errorCode, @errorMessage, @requestedAt, @startedAt, @finishedAt)
        ON CONFLICT(book_id) DO UPDATE SET
          state = excluded.state,
          priority = excluded.priority,
          content_hash = excluded.content_hash,
          index_version = excluded.index_version,
          fingerprint = excluded.fingerprint,
          chunk_count = excluded.chunk_count,
          attempts = excluded.attempts,
          next_attempt_at = excluded.next_attempt_at,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          requested_at = excluded.requested_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at
      `).run({
        bookId: index.bookId,
        state: index.state,
        priority: index.priority,
        contentHash: index.contentHash,
        indexVersion: index.indexVersion,
        fingerprint: index.fingerprint,
        chunkCount: index.chunkCount,
        attempts: index.attempts,
        nextAttemptAt: index.nextAttemptAt,
        errorCode: index.error?.code ?? null,
        errorMessage: index.error?.message ?? null,
        requestedAt: index.requestedAt,
        startedAt: index.startedAt,
        finishedAt: index.finishedAt,
      });
      if (before?.state !== index.state) this.revisionCounter++;
    })();
  }

  resetInterrupted(): number {
    const result = this.db.prepare("UPDATE book_index SET state = 'pending', started_at = NULL WHERE state = 'indexing'").run();
    if (result.changes > 0) this.revisionCounter += result.changes;
    return result.changes;
  }

  statesFor(bookIds: string[]): Map<string, BookIndex> {
    const states = new Map<string, BookIndex>();
    // Stay below SQLite's parameter limit when listing a large library.
    const batchSize = 500;
    for (let offset = 0; offset < bookIds.length; offset += batchSize) {
      const batch = bookIds.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT * FROM book_index WHERE book_id IN (${placeholders})`).all(...batch) as BookIndexRow[];
      for (const row of rows) states.set(row.book_id, toBookIndex(row));
    }
    return states;
  }

  counts(): { pending: number; indexing: number; ready: number; error: number } {
    const counts = { pending: 0, indexing: 0, ready: 0, error: 0 };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM book_index GROUP BY state").all() as { state: IndexState; n: number }[];
    for (const row of rows) counts[row.state] = row.n;
    return counts;
  }

  requeue(scope: "failed" | "all", now: number): number {
    return this.db.transaction(() => {
      const filter = scope === "failed" ? "state = 'error'" : "state IN ('ready','error')";
      const result = this.db.prepare(`
        UPDATE book_index
        SET state = 'pending', priority = 1, attempts = 0, content_hash = NULL, next_attempt_at = 0,
          error_code = NULL, error_message = NULL, requested_at = ?, started_at = NULL, finished_at = NULL
        WHERE ${filter}
      `).run(now);
      if (result.changes > 0) this.revisionCounter += result.changes;
      return result.changes;
    })();
  }

  staleIds(currentVersion: string): string[] {
    const rows = this.db.prepare(`
      SELECT book_id, index_version FROM book_index
      WHERE state = 'ready' AND (index_version IS NULL OR index_version <> ?)
    `).all(currentVersion) as { book_id: string; index_version: string | null }[];
    // A lexical-by-choice book stays lexical when a vector embedder becomes available; only
    // degraded (`|none`) and older pipeline versions are reconciled automatically. While the
    // configured provider is down (current version `|none`), vector books are kept: an outage
    // must not erase a complete vector index.
    const currentIsLexical = isLexicalVersion(currentVersion);
    const currentIsDegraded = isDegradedVersion(currentVersion);
    return rows
      .filter((row) => {
        const stored = row.index_version;
        if (isLexicalVersion(stored) && !currentIsLexical) return false;
        if (currentIsDegraded && isVectorVersion(stored)) return false;
        return true;
      })
      .map((row) => row.book_id);
  }

  unindexedReadyBookIds(): string[] {
    const rows = this.db.prepare(`
      SELECT b.id FROM books b
      LEFT JOIN book_index i ON i.book_id = b.id
      WHERE b.status = 'ready' AND i.book_id IS NULL
    `).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  averageChunkCount(): number | null {
    const row = this.db.prepare("SELECT AVG(chunk_count) AS average FROM book_index WHERE chunk_count > 0")
      .get() as { average: number | null };
    return row.average;
  }

  vectorBookCount(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM book_index
      WHERE state = 'ready' AND index_version IS NOT NULL
        AND index_version NOT LIKE '%|none' AND index_version NOT LIKE '%|lexical'
    `).get() as { n: number };
    return row.n;
  }

  walCheckpoint(): void {
    this.db.pragma("wal_checkpoint(PASSIVE)");
  }

  revision(): number {
    return this.revisionCounter;
  }
}

function mergeHits(
  strict: readonly { passageId: number; rank: number }[],
  expanded: readonly { passageId: number; rank: number }[],
  limit: number,
): { passageId: number; rank: number }[] {
  const seen = new Set<number>();
  const merged: { passageId: number; rank: number }[] = [];
  for (const hit of [...strict, ...expanded]) {
    if (seen.has(hit.passageId)) continue;
    seen.add(hit.passageId);
    merged.push(hit);
    if (merged.length >= limit) break;
  }
  return merged;
}

export class SqlitePassageRepository implements PassageRepository {
  private dfEpoch: number | null = null;
  private readonly dfCache = new Map<string, number>();
  private dfTotal = 0;
  private vocab: { exact: Database.Statement; range: Database.Statement } | null | undefined;

  constructor(private db: Db) {}

  clear(bookId: string): void {
    this.db.prepare("DELETE FROM chunks WHERE book_id = ?").run(bookId);
    this.invalidateFrequencyCache();
  }

  append(bookId: string, items: { passage: Passage; vector: Float32Array | null }[]): void {
    if (!items.length) return;
    const insertChunk = this.db.prepare("INSERT INTO chunks (book_id, ordinal, text, page, section) VALUES (?, ?, ?, ?, ?)");
    const insertVector = this.db.prepare("INSERT INTO chunk_vectors (chunk_id, book_id, vec) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const item of items) {
        const result = insertChunk.run(bookId, item.passage.ordinal, item.passage.text, item.passage.page, item.passage.section);
        if (item.vector) insertVector.run(Number(result.lastInsertRowid), bookId, toBlob(item.vector));
      }
    })();
    this.invalidateFrequencyCache();
  }

  /**
   * A write from this same connection does not bump `PRAGMA data_version` (only other
   * connections' commits do), so the write path clears the cache explicitly. The
   * production search worker is a separate read-only connection and relies on the epoch.
   */
  private invalidateFrequencyCache(): void {
    this.dfEpoch = null;
    this.dfCache.clear();
  }

  searchLexical(q: string, limit: number, bookId?: string): { passageId: number; rank: number }[] {
    const plan = toFtsPlan(q, this.frequencyOptions());
    if (!plan.primary || limit <= 0) return [];
    // The FTS rowid *is* chunks.id (`content_rowid='id'`), so the unfiltered path needs no
    // join. Joining read one chunks row per match, which costs 3-6x more on a cold page
    // cache (random reads) and neither changes the ranking nor the returned ids.
    const unfiltered = this.db.prepare(`
      SELECT chunks_fts.rowid AS passageId, bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT ?
    `);
    // The join is required to filter by book, and it stays bounded to that book's rows.
    const filtered = bookId
      ? this.db.prepare(`
          SELECT c.id AS passageId, bm25(chunks_fts) AS rank
          FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ? AND c.book_id = ?
          ORDER BY rank LIMIT ?
        `)
      : null;
    const run = (match: string): { passageId: number; rank: number }[] =>
      (filtered
        ? filtered.all(match, bookId, limit)
        : unfiltered.all(match, limit)) as { passageId: number; rank: number }[];

    const strict = run(plan.primary);
    // The three-term OR is allowed only when no term is rare and the AND matched nothing.
    // With rare terms present, common terms never enter an OR: the rare union is the only
    // recall pass, bounded to the rare postings and the request's 8 s worker timeout.
    if (plan.rare === 0 && strict.length === 0 && plan.fallback) {
      return mergeHits(strict, run(plan.fallback), limit);
    }
    return strict;
  }

  /** df cache and total row count are invalidated together when the file epoch changes. */
  private frequencyOptions(): FtsPlanOptions | undefined {
    const epoch = this.db.pragma("data_version", { simple: true }) as number;
    if (this.dfEpoch !== epoch) {
      this.dfEpoch = epoch;
      this.dfCache.clear();
      this.dfTotal = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    }
    if (!this.ensureVocab()) return undefined;
    return {
      documentFrequency: (text, prefix) => this.documentFrequency(text, prefix),
      totalRows: this.dfTotal,
    };
  }

  private ensureVocab(): boolean {
    if (this.vocab === null) return false;
    if (this.vocab) return true;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.chunks_vocab USING fts5vocab('main', 'chunks_fts', 'row')");
      this.vocab = {
        exact: this.db.prepare("SELECT doc FROM temp.chunks_vocab WHERE term = ?"),
        range: this.db.prepare("SELECT SUM(doc) AS n FROM temp.chunks_vocab WHERE term >= ? AND term < ?"),
      };
      return true;
    } catch {
      // No corpus access (or FTS5 vocab unavailable): the pure planner still answers.
      this.vocab = null;
      return false;
    }
  }

  private documentFrequency(text: string, prefix: boolean): number {
    const key = `${prefix ? "p" : "e"}:${text}`;
    const cached = this.dfCache.get(key);
    if (cached !== undefined) return cached;
    let df = 0;
    if (this.vocab) {
      if (prefix) {
        const row = this.vocab.range.get(text, `${text}\uffff`) as { n: number | null } | undefined;
        df = row?.n ?? 0;
      } else {
        const row = this.vocab.exact.get(text) as { doc: number } | undefined;
        df = row?.doc ?? 0;
      }
    }
    this.dfCache.set(key, df);
    return df;
  }

  hydrate(ids: number[]): PassageView[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT c.id AS passageId, c.book_id AS bookId, b.title AS bookTitle,
        c.text AS text, c.page AS page, c.section AS section
      FROM chunks c JOIN books b ON b.id = c.book_id
      WHERE c.id IN (${placeholders})
    `).all(...ids) as PassageView[];
    const byId = new Map(rows.map((row) => [row.passageId, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
