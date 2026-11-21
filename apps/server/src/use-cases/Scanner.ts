import { fileView, supportedFormat, sourceBookId } from "../domain/library/Book.js";
import { BrowseRoots } from "../domain/library/BrowseRoots.js";
import { ValidationError } from "../domain/errors.js";
import type { Book, Source, BookRepository, SourceRepository, FileStore, Clock, IdGenerator, MetadataExtractor, Extracted, FileEntry, Logger, SourceBookSnapshot, AliasSnapshot, ContentIdentityResolver, DuplicateRepository, ScanEvidence, IgnoredBookRepository } from "../ports/index.js";
import type { IndexScheduler } from "../ports/knowledge.js";
export interface ScanStatus {
  scanning: boolean;
  pending: number;
  lastScanAt: number | null;
  skippedDuplicates: number;
  movedFiles: number;
  /** New or changed files skipped because their path or content was ignored. */
  ignoredSkipped: number;
}

/** Content identity wiring; absent in lightweight tests and when dedup is not configured. */
export interface ScannerDedup {
  identity: ContentIdentityResolver;
  aliases: DuplicateRepository;
  /** Called after the scan settles (used to trigger the background duplicate analysis). */
  onScanComplete?: () => void;
}
/** What one source walk saw, and where it could not look. */
interface WalkResult extends ScanEvidence {
  readonly seen: Set<string>;
  readonly unreadable: string[];
  readonly failedStat: Set<string>;
}
/** A row whose path was not seen by a successful walk; removed after every source was read. */
interface LostPath {
  readonly sourceId: string;
  readonly path: string;
  readonly bookId: string;
}
export interface ScannerOptions {
  /** Concurrent `stat` calls while walking a source (ADR-B1). */
  scanConcurrency?: number;
  /** Books extracted in parallel; the metadata pool size (ADR-B2). */
  metadataWorkers?: number;
  /** Rows per `saveMany` transaction; larger blocks block the event loop for longer. */
  writeBlockSize?: number;
  /** Books per `deleteMany` call during reconciliation. */
  deleteBatchSize?: number;
  /** Pending rows fetched per read; processed with `metadataWorkers` parallelism. */
  pendingReadBatch?: number;
}
const MAX_METADATA_BYTES = 200 * 1024 * 1024;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Small dependency-free `mapLimit`: the scanner only needs bounded fan-out. */
async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await run(items[index]!);
      } catch (error) {
        failure = failure ?? error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw failure;
}

export class Scanner {
  private scanning = false;
  private lastScanAt: number | null = null;
  private working = false;
  /** A walk can outlive its source: never let it write books back after removal. */
  private readonly removedSources = new Set<string>();
  private readonly roots: BrowseRoots;
  private readonly scanConcurrency: number;
  private readonly metadataWorkers: number;
  private readonly writeBlockSize: number;
  private readonly deleteBatchSize: number;
  private readonly pendingReadBatch: number;
  private skippedDuplicates = 0;
  private movedFiles = 0;
  private ignoredSkipped = 0;
  constructor(private books: BookRepository, private sourceRepository: SourceRepository, private files: FileStore,
    private clock: Clock, private ids: IdGenerator, private metadata: Record<Book["format"], MetadataExtractor>, private log: Logger,
    private indexer?: IndexScheduler, browseRoots: string[] = [], options: ScannerOptions = {},
    private dedup?: ScannerDedup, private ignored?: Pick<IgnoredBookRepository, "pathsAmong" | "sizesAmong">) {
    this.roots = new BrowseRoots(browseRoots, (path) => files.realpath(path));
    this.scanConcurrency = Math.max(1, options.scanConcurrency ?? 8);
    this.metadataWorkers = Math.max(1, options.metadataWorkers ?? 2);
    this.writeBlockSize = Math.max(1, options.writeBlockSize ?? 500);
    this.deleteBatchSize = Math.max(1, Math.min(100, options.deleteBatchSize ?? 100));
    this.pendingReadBatch = Math.max(1, options.pendingReadBatch ?? 200);
  }
  status(): ScanStatus {
    return {
      scanning: this.scanning,
      pending: this.books.pendingCount(),
      lastScanAt: this.lastScanAt,
      skippedDuplicates: this.skippedDuplicates,
      movedFiles: this.movedFiles,
      ignoredSkipped: this.ignoredSkipped,
    };
  }
  sources() { return this.sourceRepository.list(); }
  async listSources() {
    return Promise.all(this.sources().map(async s => ({ ...s, accessible: await this.files.isDirectory(s.path), books: this.books.countForSource(s.id) })));
  }
  addSource(path: string): Source {
    const existing = this.sourceRepository.byPath(path);
    if (existing) return existing;
    const source = { id: this.ids.next(), path };
    this.sourceRepository.save(source);
    return source;
  }
  async addReadableSource(input?: string) {
    const path = input?.trim();
    if (!path) throw new ValidationError("path is required");
    if (!await this.files.isDirectory(path)) throw new ValidationError("Directory not found or not readable by the server");
    const source = this.addSource(this.roots.restricted ? await this.allowedSourcePath(path) : path);
    void this.scan();
    return source;
  }
  private async allowedSourcePath(path: string): Promise<string> {
    const resolved = await this.files.realpath(path).catch(() => null);
    if (!resolved) throw new ValidationError("Directory not found or not readable by the server");
    if (!await this.roots.contains(resolved)) {
      throw new ValidationError("This folder is outside the folders Knowlify may browse");
    }
    return resolved;
  }
  async removeSource(id: string): Promise<boolean> {
    if (this.sources().some(source => source.id === id)) this.removedSources.add(id);
    const indexed = this.books.snapshotForSource(id);
    const ids: string[] = [];
    if (this.dedup) {
      // A copy in another source keeps the book (notes, progress and index) accessible.
      for (const row of indexed.values()) {
        const alias = this.dedup.aliases.aliasesForBook(row.id)
          .find((candidate) => candidate.sourceId !== null && candidate.sourceId !== id);
        if (alias) {
          if (!this.dedup.aliases.promoteAlias(row.id, alias.path)) ids.push(row.id);
        } else {
          ids.push(row.id);
        }
      }
      // Aliases that lived in the removed source disappear with it.
      this.dedup.aliases.deleteAliasesForSource(id);
    } else {
      ids.push(...[...indexed.values()].map((row) => row.id));
    }
    for (let start = 0; start < ids.length; start += this.deleteBatchSize) {
      this.books.deleteMany(ids.slice(start, start + this.deleteBatchSize));
      await yieldToLoop();
    }
    return this.sourceRepository.delete(id);
  }
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.skippedDuplicates = 0;
    this.movedFiles = 0;
    this.ignoredSkipped = 0;
    try {
      const evidence = new Map<string, ScanEvidence>();
      const lost: LostPath[] = [];
      for (const source of this.sources()) {
        if (!this.removedSources.has(source.id)) await this.scanSource(source, evidence, lost);
      }
      await this.reconcileLostPaths(lost, evidence);
      this.lastScanAt = this.clock.now();
      if (this.skippedDuplicates > 0 || this.movedFiles > 0) {
        this.log.info(`scan dedup: ${this.skippedDuplicates} duplicate(s) skipped, ${this.movedFiles} file(s) moved`);
      }
    } catch (e) { this.log.error(e, "scan failed"); }
    finally { this.scanning = false; }
    try { this.dedup?.onScanComplete?.(); }
    catch (e) { this.log.error(e, "scan completion hook failed"); }
    void this.processPending();
  }
  private async scanSource(source: Source, evidence: Map<string, ScanEvidence>, lost: LostPath[]) {
    // One query replaces one `byPath` per file (ADR-B1). It is also the set of
    // books reconciliation may remove after the walk.
    const indexed = this.books.snapshotForSource(source.id);
    const aliases = this.dedup?.aliases.aliasSnapshotForSource(source.id) ?? new Map<string, AliasSnapshot>();
    const result: WalkResult = { seen: new Set(), unreadable: [], failedStat: new Set() };
    const pending: Book[] = [];
    const changed = new Set<string>();
    try {
      await this.walk(source.path, source, indexed, aliases, result, pending, changed, evidence, true);
      // Register only after the whole walk finished: a flush in the middle of the walk must
      // not treat the part that was not visited yet as proof that a file moved.
      evidence.set(source.id, result);
      await this.flush(pending, changed, evidence);
    } catch (e) { this.log.error(e, `cannot read source ${source.path}; keeping existing index`); return; }
    // Removal owns the rows from this point; reconciliation must not touch them.
    if (this.removedSources.has(source.id)) return;
    // An unmounted share or an empty mount point hides every file at once. Removing the
    // index then would drop books and their reading progress until a rescan sees files
    // again, so keep them; explicit source removal remains the way to discard a source.
    if (result.seen.size === 0 && (indexed.size > 0 || aliases.size > 0)) {
      this.log.info(`source ${source.path} shows no files; keeping ${indexed.size} indexed books`);
      return;
    }
    for (const [path, row] of indexed) {
      if (result.seen.has(path) || result.failedStat.has(path)) continue;
      if (result.unreadable.some(dir => this.isUnder(path, dir))) continue;
      // A row that is missing from a successfully read source may still be the canonical
      // of a copy found in another source. Decide after every source was walked, so the
      // outcome does not depend on the source order.
      lost.push({ sourceId: source.id, path, bookId: row.id });
    }
    if (this.dedup) {
      for (const [path] of aliases) {
        if (result.seen.has(path) || result.failedStat.has(path)) continue;
        if (result.unreadable.some(dir => this.isUnder(path, dir))) continue;
        this.dedup.aliases.deleteAlias(path);
      }
    }
  }

  /**
   * Reconciles rows whose path disappeared from a source that was walked successfully.
   * A row is deleted only when every alias is proven absent by this execution; an alias that
   * could not be checked (offline source, failed stat, unreadable folder) may still be the
   * only copy, so keeping the row preserves its id, notes, progress and index. This runs
   * after every source walk, so a move into a source scanned earlier still finds its alias
   * instead of deleting the book first.
   */
  private async reconcileLostPaths(lost: LostPath[], evidence: Map<string, ScanEvidence>): Promise<void> {
    const removed: string[] = [];
    let kept = 0;
    for (const entry of lost) {
      if (this.removedSources.has(entry.sourceId)) continue;
      const current = this.books.get(entry.bookId);
      // The row was already moved or promoted by the identity resolution above.
      if (!current || current.path !== entry.path) continue;
      const promotion = await this.promoteAlias(entry.bookId, evidence);
      if (promotion === "promoted") { this.movedFiles += 1; continue; }
      if (promotion !== "none") { kept += 1; continue; }
      removed.push(entry.bookId);
      if (removed.length >= this.deleteBatchSize) {
        this.books.deleteMany(removed.splice(0, removed.length));
        await yieldToLoop();
      }
    }
    if (removed.length > 0) this.books.deleteMany(removed);
    if (kept > 0) this.log.info(`scan kept ${kept} book(s) whose copy could not be verified`);
  }

  /**
   * When the canonical path disappears, an alias that a successful walk of this execution
   * still saw becomes the book's new path. The id is kept, so notes, progress and index stay
   * attached (ADR-3). An alias is only trusted when its own source was walked successfully
   * and the walk did not skip it. An alias that cannot be proven absent blocks the deletion
   * instead: an offline or partially read source is not evidence that its file is gone.
   */
  private async promoteAlias(bookId: string, evidence: Map<string, ScanEvidence>): Promise<"promoted" | "failed" | "unverifiable" | "none"> {
    if (!this.dedup) return "none";
    let failed = false;
    let unverifiable = false;
    for (const alias of this.dedup.aliases.aliasesForBook(bookId)) {
      if (this.aliasWasSeen(alias, evidence)) {
        if (this.dedup.aliases.promoteAlias(bookId, alias.path)) return "promoted";
        failed = true;
      } else if (!await this.aliasIsGone(alias, evidence)) {
        unverifiable = true;
      }
    }
    if (failed) this.log.error(new Error("Alias path is already owned by another book"), `cannot promote ${bookId}; keeping it`);
    return failed ? "failed" : unverifiable ? "unverifiable" : "none";
  }

  private aliasWasSeen(alias: AliasSnapshot, evidence: Map<string, ScanEvidence>): boolean {
    // Managed upload paths are never walked by the scan.
    if (alias.sourceId === null) return false;
    const walk = evidence.get(alias.sourceId);
    if (!walk || walk.seen.size === 0) return false;
    if (!walk.seen.has(alias.path) || walk.failedStat.has(alias.path)) return false;
    return !walk.unreadable.some(dir => this.isUnder(alias.path, dir));
  }

  /**
   * True only when the alias is proven absent. A source that was not walked (offline), a
   * failed stat or an unreadable folder only means the copy could not be checked, and
   * treating that as absence would delete the book and its user data while a copy remains.
   * Managed upload paths are outside the walk, so only a successful local stat can prove
   * their absence.
   */
  private async aliasIsGone(alias: AliasSnapshot, evidence: Map<string, ScanEvidence>): Promise<boolean> {
    if (alias.sourceId === null) {
      try { return await this.files.statIfExists(alias.path) === null; }
      catch { return false; }
    }
    const walk = evidence.get(alias.sourceId);
    if (!walk || walk.seen.size === 0) return false;
    if (walk.seen.has(alias.path) || walk.failedStat.has(alias.path)) return false;
    return !walk.unreadable.some(dir => this.isUnder(alias.path, dir));
  }
  /** Segment-aware containment: an unreadable `/library/locked` must not hide `/library/locked-extra`. */
  private isUnder(path: string, dir: string): boolean {
    const separator = this.files.isWindows ? "\\" : "/";
    const prefix = dir.endsWith(separator) ? dir : `${dir}${separator}`;
    return path.startsWith(prefix);
  }
  private async walk(dir: string, source: Source, indexed: Map<string, SourceBookSnapshot>,
    aliases: Map<string, AliasSnapshot>, result: WalkResult, pending: Book[], changed: Set<string>,
    evidence: Map<string, ScanEvidence>, isRoot = true): Promise<void> {
    if (this.removedSources.has(source.id)) return;
    let entries: FileEntry[];
    try { entries = await this.files.entries(dir); }
    catch (e) {
      if (isRoot) throw e;
      result.unreadable.push(dir);
      this.log.error(e, `skipping ${dir}; keeping indexed books under it`);
      return;
    }
    const files = entries.filter((entry) => !entry.name.startsWith(".") && !entry.directory && entry.file && supportedFormat(this.files.extension(entry.name)));
    await mapLimit(files, this.scanConcurrency, async (entry) => {
      const st = await this.files.stat(entry.path).catch(() => null);
      if (!st) { result.failedStat.add(entry.path); return; }
      result.seen.add(entry.path);
      const existing = indexed.get(entry.path);
      const format = this.files.extension(entry.name);
      if (!supportedFormat(format)) return;
      if (!existing) {
        const alias = aliases.get(entry.path);
        if (alias) {
          // An unchanged alias costs one stat and stays invisible; a changed one is no
          // longer the file the alias described, so it re-enters normal resolution.
          if (alias.mtime === st.mtime && alias.size === st.size) return;
          this.dedup?.aliases.deleteAlias(entry.path);
        }
        pending.push({ id: sourceBookId(entry.path), title: this.files.title(entry.name), author: "", format,
          path: entry.path, cover_path: null, size: st.size, added_at: this.clock.now(), source_id: source.id,
          mtime: st.mtime, status: "pending", content_hash: null });
      } else if (existing.mtime !== st.mtime || existing.size !== st.size) {
        const current = this.books.get(existing.id);
        if (current) {
          changed.add(current.id);
          // The repository expects file values: starting from the effective row would
          // promote an override to be the new file metadata (ADR-2).
          pending.push({ ...fileView(current), mtime: st.mtime, size: st.size, status: "pending" });
        }
      }
      if (pending.length >= this.writeBlockSize) await this.flush(pending, changed, evidence);
    });
    for (const entry of entries) {
      if (!entry.name.startsWith(".") && entry.directory) {
        await this.walk(entry.path, source, indexed, aliases, result, pending, changed, evidence, false);
      }
    }
  }
  private async flush(pending: Book[], changed: Set<string>, evidence: Map<string, ScanEvidence>): Promise<void> {
    if (pending.length === 0) return;
    const live = pending.splice(0, pending.length)
      .filter(book => !book.source_id || !this.removedSources.has(book.source_id));
    if (live.length === 0) { await yieldToLoop(); return; }
    // Tombstones are read at flush time, against the database: a deletion committed while
    // the walk was running must still stop a pending (including "changed") row from being
    // upserted. Dropping a changed row is what prevents a deleted book from resurrecting.
    const ignoredPaths = this.ignored?.pathsAmong(live.map((book) => book.path)) ?? new Set<string>();
    const kept = ignoredPaths.size === 0 ? live : live.filter((book) => !ignoredPaths.has(book.path));
    this.ignoredSkipped += live.length - kept.length;
    if (kept.length === 0) { await yieldToLoop(); return; }
    if (!this.dedup) {
      this.books.saveMany(kept);
      await yieldToLoop();
      return;
    }
    // Batch writes are kept for the common case (no size collision). Rows that may share
    // content with another book go through identity resolution, which serializes the
    // check-and-insert per size. This is also where an upload racing the scan is caught:
    // the lookup happens at flush time, after any concurrent upload committed its row.
    const counts = new Map<number, number>();
    for (const book of kept) counts.set(book.size, (counts.get(book.size) ?? 0) + 1);
    const present = this.books.sizesPresent([...counts.keys()]);
    // A file can be in a fresh path whose content was deleted elsewhere; a matching ignored
    // size forces the hash so ContentIdentity can decide with the real bytes.
    const ignoredSizes = this.ignored?.sizesAmong([...counts.keys()]) ?? new Set<number>();
    const plain: Book[] = [];
    const colliding: Book[] = [];
    for (const book of kept) {
      if ((counts.get(book.size) ?? 0) > 1 || present.has(book.size) || ignoredSizes.has(book.size)) colliding.push(book);
      else plain.push(book);
    }
    this.books.saveMany(plain);
    if (colliding.length > 0) {
      const resolve = async (book: Book) => {
        try {
          const outcome = await this.dedup!.identity.resolve({
            book,
            existingBookId: changed.has(book.id) ? book.id : undefined,
            scan: evidence,
            forceHash: ignoredSizes.has(book.size),
          });
          if (outcome.kind === "duplicate") this.skippedDuplicates += 1;
          else if (outcome.kind === "moved") this.movedFiles += 1;
          else if (outcome.kind === "ignored") this.ignoredSkipped += 1;
          else if (outcome.kind === "changed") this.books.save(outcome.book);
        } catch (e) {
          // Hashing failed (unreadable file). Keep the old behaviour: persist the pending
          // row and let metadata extraction report the error on this book.
          this.log.error(e, `cannot resolve content identity for ${book.path}`);
          this.books.save(book);
        }
      };
      // Changed rows first: their new version becomes a candidate for the new files in the
      // same batch, so the batch resolves deterministically regardless of walk order.
      await mapLimit(colliding.filter((book) => changed.has(book.id)), 2, resolve);
      await mapLimit(colliding.filter((book) => !changed.has(book.id)), 2, resolve);
    }
    await yieldToLoop();
  }
  async processPending(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const batch = this.books.pending(this.pendingReadBatch);
        if (!batch.length) break;
        const ready = await this.processChunks(batch);
        if (ready.length > 0) {
          // Deferred writes must not reinsert a book deleted while another extraction
          // in the same batch was still running.
          const updated = new Set(this.books.updateMetadataMany(ready));
          for (const book of ready) {
            if (!updated.has(book.id)) continue;
            try { this.indexer?.schedule(book, 0); }
            catch (e) { this.log.error(e, `cannot enqueue indexing for ${book.path}`); }
          }
        }
        await yieldToLoop();
      }
    } finally { this.working = false; }
  }
  /** Fallback for extractors without a batch API: N extractions at a time (the old path). */
  private async processChunks(batch: Book[]): Promise<Book[]> {
    const ready: Book[] = [];
    for (let start = 0; start < batch.length; start += this.metadataWorkers) {
      const chunk = batch.slice(start, start + this.metadataWorkers);
      const processed = await Promise.all(chunk.map(book => this.processBook(book)));
      for (const book of processed) if (book) ready.push(book);
    }
    return ready;
  }

  private failedBook(book: Book, error: unknown): Book | null {
    this.log.error(error, `metadata failed for ${book.path}`);
    const current = this.books.get(book.id);
    // Keep the extracted version as the guard: a rescan that changed the file
    // must leave the book pending instead of marking this older attempt as done.
    // Starting from fileView keeps an override out of the file-side columns.
    return current ? { ...fileView(current), mtime: book.mtime, size: book.size, status: "error" } : null;
  }

  private async finalizeBook(book: Book, meta: Extracted): Promise<Book | null> {
    const cover = meta.cover ? await this.files.writeCover(book.id, meta.cover) : null;
    // A source can be removed while metadata is being extracted. Never resurrect its books.
    const current = this.books.get(book.id);
    if (!current) return null;
    const file = fileView(current);
    return { ...file, mtime: book.mtime, size: book.size,
      title: meta.title ?? file.title, author: meta.author ?? file.author,
      cover_path: cover ?? file.cover_path, status: "ready" };
  }

  private async processBook(book: Book): Promise<Book | null> {
    try {
      let meta: Extracted = {};
      if (book.format === "epub" || book.size <= MAX_METADATA_BYTES) meta = await this.metadata[book.format].extract(book.path);
      return await this.finalizeBook(book, meta);
    } catch (e) {
      return this.failedBook(book, e);
    }
  }
}
