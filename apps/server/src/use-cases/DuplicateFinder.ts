import { createHash } from "node:crypto";
import {
  contentGroupKey,
  isContentHash,
  parseContentGroupKey,
  pickCanonical,
  type CanonicalCandidate,
} from "../domain/library/ContentIdentity.js";
import { ConflictError, ValidationError } from "../domain/errors.js";
import type {
  Book,
  BookRepository,
  Clock,
  ContentHasher,
  DuplicateBookStats,
  DuplicateContentAnchor,
  DuplicateRepository,
  FavoriteRepository,
  FileStore,
  IdGenerator,
  Logger,
  MergeLogRepository,
  NoteRepository,
  ProgressRepository,
  SourceRepository,
  TagRepository,
  UnitOfWork,
} from "../ports/index.js";
import type { ConversationRepository } from "../ports/assistant.js";
import type { BookMetadataRepository, CustomCoverStore } from "../ports/library-metadata.js";
import { BookLocks } from "./BookLocks.js";

const DEFAULT_HASH_CONCURRENCY = 2;
const DEFAULT_BOOT_DELAY_MS = 30_000;
const DEFAULT_MERGE_GROUPS_LIMIT = 500;
const MERGE_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface DuplicateStatus {
  state: "idle" | "hashing" | "ready";
  progress: number | null;
  groups: number;
  redundantBooks: number;
}

export interface DuplicateBookView {
  id: string;
  title: string;
  author: string;
  format: Book["format"];
  path: string;
  sourceId: string | null;
  sourceLabel: string;
  addedAt: number;
  canonical: boolean;
  hasNotes: boolean;
  hasProgress: boolean;
  indexed: boolean;
}

export interface DuplicateGroup {
  key: string;
  size: number;
  contentHash: string;
  canonicalId: string;
  books: DuplicateBookView[];
  aliases: string[];
}

export interface DuplicateSummary {
  groups: number;
  redundantBooks: number;
  reclaimableBytes: number;
}

export interface DuplicateFindPage {
  groups: DuplicateGroup[];
  nextAnchor: DuplicateContentAnchor | null;
  summary: DuplicateSummary;
}

export interface MergeGroupRequest {
  key: string;
  canonicalId?: string;
}

/** A group accepted by a dry run, pinned to the exact plan the user reviewed. */
export interface MergeConfirmation {
  key: string;
  fingerprint: string;
}

export interface MergeRequest {
  /** Explicit scope. Older clients still send only this field. */
  groups?: MergeGroupRequest[] | "all";
  /** New scope: only these exact group plans may be merged. */
  confirm?: MergeConfirmation[];
  dryRun: boolean;
}

export interface MergePlan {
  groups: number;
  booksRemoved: number;
  notesMoved: number;
  conversationsMoved: number;
  progressKept: number;
  indexesDropped: number;
  managedFilesRemoved: number;
  reclaimableBytes: number;
}

export interface MergeSkipped {
  key: string;
  reason: "gone" | "changed" | "failed";
}

export interface MergeDryRunResult {
  merged: 0;
  plan: MergePlan;
  warnings: string[];
  /** Groups whose current plan is exactly what a subsequent merge will verify. */
  accepted: MergeConfirmation[];
  /** Requested keys that are gone or changed and were left out of the plan. */
  omitted: string[];
}

export interface MergeAppliedResult extends Omit<MergePlan, "groups"> {
  merged: number;
  skipped: MergeSkipped[];
}

export type MergeResult = MergeDryRunResult | MergeAppliedResult;

/** A file to remove once every merge transaction committed. Book files carry the version
 * that was validated so a change during the merge is not deleted. */
interface PendingRemoval {
  path: string;
  size?: number;
  mtime?: number | null;
}

export interface DuplicateFinderOptions {
  hashConcurrency?: number;
  bootDelayMs?: number;
  mergeGroupsLimit?: number;
  /** Passive WAL checkpoint between merge batches (ADR-8). */
  checkpoint?: () => void;
}

const emptyPlan = (): MergePlan => ({
  groups: 0, booksRemoved: 0, notesMoved: 0, conversationsMoved: 0,
  progressKept: 0, indexesDropped: 0, managedFilesRemoved: 0, reclaimableBytes: 0,
});

function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  });
  return Promise.all(workers).then(() => undefined);
}

const candidateOf = (book: Book, stats: DuplicateBookStats): CanonicalCandidate => ({
  id: book.id,
  notes: stats.notes,
  conversations: stats.conversations,
  hasProgress: stats.hasProgress,
  indexed: stats.indexState === "ready",
  status: book.status,
  managed: book.source_id === null,
  addedAt: book.added_at,
});

/**
 * Stable digest of everything a merge plan for one group depends on: the content hash,
 * the chosen canonical and each member's identity and file version. A member added,
 * removed or changed between the dry run and the merge changes the fingerprint, so the
 * user-confirmed plan cannot silently cover a different set of rows.
 */
export function mergeGroupFingerprint(
  key: string,
  contentHash: string,
  canonicalId: string,
  books: readonly Book[],
): string {
  const members = [...books]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((book) => ({ id: book.id, path: book.path, size: book.size, mtime: book.mtime ?? null }));
  const payload = JSON.stringify({ version: 1, key, contentHash, canonicalId, members });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Background detection of duplicates that already exist (ADR-7) and the reviewed merge.
 * Detection only hashes books whose size is shared with another book; merges are never
 * automatic: the HTTP contract always exposes a dry run first.
 */
export class DuplicateFinder {
  private state: DuplicateStatus["state"] = "idle";
  private progress: number | null = null;
  private groupCount = 0;
  private redundantBookCount = 0;
  private analysis: Promise<void> | null = null;
  private merging = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly hashConcurrency: number;
  private readonly bootDelayMs: number;
  private readonly mergeGroupsLimit: number;
  private readonly checkpoint: () => void;

  constructor(
    private readonly books: BookRepository,
    private readonly duplicates: DuplicateRepository,
    private readonly hasher: ContentHasher,
    private readonly sources: SourceRepository,
    private readonly notes: Pick<NoteRepository, "reassign">,
    private readonly conversations: Pick<ConversationRepository, "reassign">,
    private readonly progressRepository: Pick<ProgressRepository, "merge">,
    private readonly files: Pick<FileStore, "statIfExists" | "removeManaged">,
    private readonly unitOfWork: UnitOfWork,
    private readonly mergeLog: MergeLogRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly log: Logger,
    options: DuplicateFinderOptions = {},
    private readonly tags?: Pick<TagRepository, "reassign">,
    private readonly favorites?: Pick<FavoriteRepository, "set">,
    private readonly metadata?: Pick<BookMetadataRepository, "get" | "move" | "setCover">,
    private readonly customCovers?: Pick<CustomCoverStore, "move">,
    private readonly locks: BookLocks = new BookLocks(),
  ) {
    this.hashConcurrency = Math.max(1, options.hashConcurrency ?? DEFAULT_HASH_CONCURRENCY);
    this.bootDelayMs = Math.max(0, options.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS);
    this.mergeGroupsLimit = Math.max(1, options.mergeGroupsLimit ?? DEFAULT_MERGE_GROUPS_LIMIT);
    this.checkpoint = options.checkpoint ?? (() => {});
  }

  start(): void {
    try {
      const pruned = this.mergeLog.prune(this.clock.now() - MERGE_LOG_RETENTION_MS);
      if (pruned > 0) this.log.info(`pruned ${pruned} expired duplicate merge log entries`);
    } catch (e) {
      this.log.error(e, "cannot prune duplicate merge log");
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.trigger(), this.bootDelayMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): DuplicateStatus {
    return {
      state: this.state,
      progress: this.progress,
      groups: this.groupCount,
      redundantBooks: this.redundantBookCount,
    };
  }

  trigger(): void {
    void this.analyze().catch((error: unknown) => this.log.error(error, "duplicate analysis failed"));
  }

  analyze(): Promise<void> {
    if (this.analysis) return this.analysis;
    this.analysis = this.runAnalysis().finally(() => { this.analysis = null; });
    return this.analysis;
  }

  private async runAnalysis(): Promise<void> {
    const targets: Book[] = [];
    for (const group of this.duplicates.sizeGroups()) {
      for (const book of this.books.bySize(group.size)) {
        // A hash without an mtime (managed upload imported before mtimes were recorded)
        // cannot be revalidated against the file at merge time, so verify it once here.
        if (!book.content_hash || !isContentHash(book.content_hash) || book.mtime === null) {
          targets.push(book);
        }
      }
    }
    if (targets.length === 0) {
      this.refreshSummary();
      this.state = "ready";
      this.progress = null;
      return;
    }
    this.state = "hashing";
    this.progress = 0;
    let done = 0;
    await mapLimit(targets, this.hashConcurrency, async (book) => {
      if (this.stopped) return;
      try {
        await this.hashVerified(book);
      } catch (e) {
        this.log.warn?.(`cannot hash ${book.path} while looking for duplicates: ${(e as Error).message}`);
      }
      done += 1;
      this.progress = done / targets.length;
    });
    this.refreshSummary();
    this.state = "ready";
    this.progress = null;
    this.log.info(`duplicate analysis: ${this.groupCount} group(s), ${this.redundantBookCount} redundant book(s)`);
  }

  /**
   * Persists a hash only when the real file matched the row before the read and did not
   * change during it. A file modified by another process therefore never gets a hash that
   * would later justify a destructive merge (ADR-6).
   */
  private async hashVerified(book: Book): Promise<void> {
    const before = await this.files.statIfExists(book.path);
    if (!before || before.size !== book.size) return;
    if (book.mtime !== null && before.mtime !== book.mtime) return;
    const hash = await this.hasher.hash(book.path);
    const after = await this.files.statIfExists(book.path);
    if (!after || after.size !== before.size || after.mtime !== before.mtime) return;
    this.books.setContentHashIfCurrent(
      book.id,
      hash,
      book.size,
      book.mtime,
      book.mtime === null ? before.mtime : undefined,
    );
  }

  private refreshSummary(): void {
    const counts = this.duplicates.contentGroupCounts();
    this.groupCount = counts.groups;
    this.redundantBookCount = counts.redundantBooks;
  }

  summary(): DuplicateSummary {
    const counts = this.duplicates.contentGroupCounts();
    return {
      groups: counts.groups,
      redundantBooks: counts.redundantBooks,
      reclaimableBytes: this.duplicates.reclaimableBytes(this.duplicates.redundantBookIds()),
    };
  }

  page(limit: number, anchor: DuplicateContentAnchor | null): DuplicateFindPage {
    const rows = this.duplicates.contentGroups(anchor, limit + 1);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const labels = this.sourceLabels();
    const groups: DuplicateGroup[] = [];
    for (const row of visible) {
      const group = this.buildGroup(row.size, row.contentHash, labels);
      if (group) groups.push(group);
    }
    const last = visible[visible.length - 1];
    return {
      groups,
      nextAnchor: hasMore && last ? { size: last.size, contentHash: last.contentHash } : null,
      summary: this.summary(),
    };
  }

  private sourceLabels(): Map<string, string> {
    return new Map(this.sources.list().map((source) => [source.id, source.path]));
  }

  private buildGroup(size: number, contentHash: string, labels?: Map<string, string>): DuplicateGroup | null {
    const books = this.groupBooks(size, contentHash);
    if (books.length < 2) return null;
    const stats = this.duplicates.statsForBooks(books.map((book) => book.id));
    const canonicalId = pickCanonical(books.map((book) => candidateOf(book, this.statsOf(stats, book.id)))).id;
    const sourceLabels = labels ?? this.sourceLabels();
    const aliases = this.duplicates.aliasesForBooks(books.map((book) => book.id));
    return {
      key: contentGroupKey(size, contentHash),
      size,
      contentHash,
      canonicalId,
      books: books.map((book) => {
        const bookStats = this.statsOf(stats, book.id);
        return {
          id: book.id,
          title: book.title,
          author: book.author,
          format: book.format,
          path: book.path,
          sourceId: book.source_id,
          sourceLabel: book.source_id === null ? "Upload" : sourceLabels.get(book.source_id) ?? book.source_id,
          addedAt: book.added_at,
          canonical: book.id === canonicalId,
          hasNotes: bookStats.notes > 0,
          hasProgress: bookStats.hasProgress,
          indexed: bookStats.indexState === "ready",
        };
      }),
      aliases: books.flatMap((book) => aliases.get(book.id) ?? []),
    };
  }

  private statsOf(stats: Map<string, DuplicateBookStats>, bookId: string): DuplicateBookStats {
    return stats.get(bookId) ?? { notes: 0, conversations: 0, hasProgress: false, progressUpdatedAt: null, indexState: "none" };
  }

  private groupBooks(size: number, contentHash: string): Book[] {
    return this.books.bySize(size).filter((book) => book.content_hash === contentHash);
  }

  /** True when any file no longer matches the version whose hash justified the group. */
  private async groupChangedSinceAnalysis(books: Book[]): Promise<boolean> {
    for (const book of books) {
      const current = await this.files.statIfExists(book.path).catch(() => null);
      // Missing or unreadable (EACCES, I/O, unmounted share) is never a safe merge.
      if (!current || current.size !== book.size) return true;
      // Without an mtime the row cannot prove the bytes on disk are still the hashed
      // version; the background analysis fills it before this group is mergeable.
      if (book.mtime === null || current.mtime !== book.mtime) return true;
    }
    return false;
  }

  private requestedGroups(request: MergeRequest): MergeGroupRequest[] {
    if (request.groups === undefined) {
      // A confirmation list is a complete scope on its own: the client sends back exactly
      // the plans the dry run reviewed.
      const confirm = request.confirm ?? [];
      if (confirm.length === 0) throw new ValidationError("groups or confirm is required");
      if (confirm.length > this.mergeGroupsLimit) {
        throw new ValidationError(`at most ${this.mergeGroupsLimit} groups can be merged per request`);
      }
      return confirm.map(({ key }) => ({ key }));
    }
    if (request.groups === "all") {
      return this.duplicates.contentGroups(null, this.mergeGroupsLimit)
        .map((group) => ({ key: contentGroupKey(group.size, group.contentHash) }));
    }
    if (request.groups.length === 0) throw new ValidationError("groups cannot be empty");
    if (request.groups.length > this.mergeGroupsLimit) {
      throw new ValidationError(`at most ${this.mergeGroupsLimit} groups can be merged per request`);
    }
    const unique = new Map<string, MergeGroupRequest>();
    for (const entry of request.groups) {
      const { size, contentHash } = parseContentGroupKey(entry.key);
      if (entry.canonicalId !== undefined) {
        const books = this.groupBooks(size, contentHash);
        if (!books.some((book) => book.id === entry.canonicalId)) {
          throw new ValidationError("canonicalId does not belong to the group");
        }
      }
      unique.set(entry.key, entry);
    }
    return [...unique.values()];
  }

  /** Validates the reviewed plan and indexes it by key. `null` means the legacy request. */
  private confirmations(request: MergeRequest): Map<string, string> | null {
    if (request.confirm === undefined) return null;
    if (request.confirm.length === 0) throw new ValidationError("confirm cannot be empty");
    if (request.confirm.length > this.mergeGroupsLimit) {
      throw new ValidationError(`at most ${this.mergeGroupsLimit} groups can be merged per request`);
    }
    const confirmed = new Map<string, string>();
    for (const entry of request.confirm) {
      parseContentGroupKey(entry.key);
      if (!isContentHash(entry.fingerprint)) throw new ValidationError("fingerprint is invalid");
      if (confirmed.has(entry.key)) throw new ValidationError("confirm keys must be unique");
      confirmed.set(entry.key, entry.fingerprint);
    }
    return confirmed;
  }

  async merge(request: MergeRequest): Promise<MergeResult> {
    if (this.merging) throw new ConflictError("A duplicate merge is already running");
    this.merging = true;
    try {
      const requested = this.requestedGroups(request);
      const confirmations = this.confirmations(request);
      if (request.dryRun === true) return await this.mergeResolved(request, requested, confirmations);
      // A committed merge moves the override row and then renames the custom cover file.
      // Hold the same per-book lock as metadata edits and deletion, so no operation can
      // remove or replace the file between the row write and the rename.
      const ids = new Set<string>();
      for (const entry of requested) {
        const { size, contentHash } = parseContentGroupKey(entry.key);
        for (const book of this.groupBooks(size, contentHash)) ids.add(book.id);
      }
      return await this.locks.run([...ids], () => this.mergeResolved(request, requested, confirmations));
    } finally {
      this.merging = false;
    }
  }

  private async mergeResolved(
    request: MergeRequest,
    requested: MergeGroupRequest[],
    confirmations: Map<string, string> | null,
  ): Promise<MergeResult> {
    const plan = emptyPlan();
    const accepted: MergeConfirmation[] = [];
    const omitted: string[] = [];
    const skipped: MergeSkipped[] = [];
    const removals = new Map<string, PendingRemoval>();
    const coverMoves: Array<{ fromId: string; toId: string; path: string | null }> = [];
    let merged = 0;
    for (const entry of requested) {
      const { size, contentHash } = parseContentGroupKey(entry.key);
      const books = this.groupBooks(size, contentHash);
      if (books.length < 2) {
        if (request.dryRun) omitted.push(entry.key);
        else skipped.push({ key: entry.key, reason: "gone" });
        continue;
      }
      const stats = this.duplicates.statsForBooks(books.map((book) => book.id));
      const canonicalCandidate = entry.canonicalId ?? pickCanonical(
        books.map((book) => candidateOf(book, this.statsOf(stats, book.id))),
      ).id;
      const canonical = books.find((book) => book.id === canonicalCandidate);
      if (!canonical) {
        if (request.dryRun) omitted.push(entry.key);
        else skipped.push({ key: entry.key, reason: "changed" });
        continue;
      }
      const fingerprint = mergeGroupFingerprint(entry.key, contentHash, canonical.id, books);
      // Never merge a plan the user did not review: a confirmation is exact, and a group
      // outside it (or a plan that changed) is left for a new dry run. The legacy
      // `groups`-only request has no reviewed digest, so it keeps the old behaviour but
      // can never expand the requested set.
      if (!request.dryRun && confirmations !== null && confirmations.get(entry.key) !== fingerprint) {
        skipped.push({ key: entry.key, reason: "changed" });
        continue;
      }
      if (await this.groupChangedSinceAnalysis(books)) {
        if (request.dryRun) omitted.push(entry.key);
        else skipped.push({ key: entry.key, reason: "changed" });
        continue;
      }
      const duplicates = books.filter((book) => book.id !== canonical.id);
      if (request.dryRun) {
        accepted.push({ key: entry.key, fingerprint });
        plan.groups += 1;
        plan.booksRemoved += duplicates.length;
        plan.notesMoved += duplicates.reduce((total, book) => total + this.statsOf(stats, book.id).notes, 0);
        plan.conversationsMoved += duplicates.reduce((total, book) => total + this.statsOf(stats, book.id).conversations, 0);
        plan.progressKept += duplicates.filter((book) => this.statsOf(stats, book.id).hasProgress).length;
        plan.indexesDropped += duplicates.filter((book) => this.statsOf(stats, book.id).indexState === "ready").length;
        plan.managedFilesRemoved += duplicates.filter((book) => book.source_id === null).length;
        plan.reclaimableBytes += this.duplicates.reclaimableBytes(duplicates.map((book) => book.id));
        continue;
      }
      try {
        const result = this.unitOfWork.run(() => this.mergeGroup(canonical, duplicates, contentHash));
        merged += 1;
        if (merged % 50 === 0) this.checkpoint();
        plan.booksRemoved += result.booksRemoved;
        plan.notesMoved += result.notesMoved;
        plan.conversationsMoved += result.conversationsMoved;
        plan.progressKept += result.progressKept;
        plan.indexesDropped += result.indexesDropped;
        plan.managedFilesRemoved += result.managedFilesRemoved;
        plan.reclaimableBytes += result.reclaimableBytes;
        for (const removal of result.files) removals.set(removal.path, removal);
        for (const move of result.coverMoves) coverMoves.push({ ...move, path: move.path });
      } catch (e) {
        this.log.error(e, `cannot merge duplicate group ${entry.key}`);
        skipped.push({ key: entry.key, reason: "failed" });
      }
    }
    // The override row moved inside the transaction; the custom cover file follows after
    // the commit. A failed rename keeps the file at its old path (still referenced by the
    // row), and the revision is bumped either way so the browser refetches the cover.
    for (const move of coverMoves) {
      if (move.path === null) continue;
      let path = move.path;
      if (this.customCovers) {
        try {
          path = await this.customCovers.move(move.fromId, move.toId) ?? path;
        } catch (e) {
          this.log.error(e, `cannot move custom cover ${move.fromId} to ${move.toId}`);
        }
      }
      try {
        this.metadata?.setCover(move.toId, path, this.clock.now(), this.clock.now());
      } catch (e) {
        // The row already belongs to the canonical book and the file still exists at
        // `path`; a revision bump is best effort and must not fail a committed merge.
        this.log.error(e, `cannot update the custom cover of ${move.toId}`);
      }
    }
    if (request.dryRun) {
      const warnings = [
        "Files in library folders are never changed or deleted.",
      ];
      if (plan.managedFilesRemoved > 0) {
        warnings.push(`${plan.managedFilesRemoved} uploaded file(s) will be removed from the app data directory.`);
      }
      if (plan.indexesDropped > 0) {
        warnings.push(`Index data for ${plan.indexesDropped} duplicate book(s) will be discarded.`);
      }
      return { merged: 0, plan, warnings, accepted, omitted };
    }
    if (merged > 0) this.checkpoint();
    // File removal happens only after every group transaction committed. Each book file
    // is re-stated so one that changed during the merge survives, and `removeManaged`
    // re-checks containment (realpath) and refuses anything outside data/books and
    // data/covers, so a stale or tampered row can never delete a library file.
    for (const removal of removals.values()) {
      try {
        if (removal.size !== undefined) {
          const current = await this.files.statIfExists(removal.path).catch(() => null);
          if (!current) continue;
          if (current.size !== removal.size || (removal.mtime !== null && current.mtime !== removal.mtime)) {
            this.log.warn?.(`leaving ${removal.path} in place: the file changed during the merge`);
            continue;
          }
        }
        await this.files.removeManaged(removal.path);
      } catch (e) { this.log.error(e, `cannot remove merged file ${removal.path}`); }
    }
    this.refreshSummary();
    this.log.info(`duplicate merge: ${merged} group(s), ${plan.booksRemoved} book(s) removed`);
    return {
      merged,
      booksRemoved: plan.booksRemoved,
      notesMoved: plan.notesMoved,
      conversationsMoved: plan.conversationsMoved,
      progressKept: plan.progressKept,
      indexesDropped: plan.indexesDropped,
      managedFilesRemoved: plan.managedFilesRemoved,
      reclaimableBytes: plan.reclaimableBytes,
      skipped,
    };
  }

  private mergeGroup(canonical: Book, duplicates: Book[], contentHash: string) {
    const now = this.clock.now();
    const files: PendingRemoval[] = [];
    interface CoverMove { fromId: string; toId: string; path: string | null }
    const coverMoves: CoverMove[] = [];
    const result = {
      booksRemoved: 0,
      notesMoved: 0,
      conversationsMoved: 0,
      progressKept: 0,
      indexesDropped: 0,
      managedFilesRemoved: 0,
      reclaimableBytes: 0,
      files,
      coverMoves,
    };
    // Favorites are user data like notes and tags: the surviving copy wins if either side
    // was flagged favorite, and unfavoriting later is always possible (ADR-1).
    if (duplicates.some((duplicate) => duplicate.favorite === 1)) {
      this.favorites?.set(canonical.id, true);
    }
    for (const duplicate of duplicates) {
      const stats = this.statsOf(this.duplicates.statsForBooks([duplicate.id]), duplicate.id);
      if (stats.indexState === "ready") result.indexesDropped += 1;
      result.reclaimableBytes += this.duplicates.reclaimableBytes([duplicate.id]);
      const noteIds = this.notes.reassign(duplicate.id, canonical.id);
      result.notesMoved += noteIds.length;
      result.conversationsMoved += this.conversations.reassign(duplicate.id, canonical.id).conversations;
      const progress = this.progressRepository.merge(duplicate.id, canonical.id);
      if (progress.kept) result.progressKept += 1;
      // Tags are user data too: the surviving copy inherits every tag of the removed one.
      this.tags?.reassign(duplicate.id, canonical.id);
      // A user's metadata edit is user data as well: when the canonical has no override,
      // the duplicate's override (and the custom cover file, moved after commit) survives.
      // Otherwise the duplicate's override is discarded with the row (ADR-2).
      const adoptedCover = this.adoptOverride(canonical.id, duplicate.id);
      if (adoptedCover !== undefined) coverMoves.push({ fromId: duplicate.id, toId: canonical.id, path: adoptedCover });
      // Alternate paths already attached to the duplicate now belong to the canonical book.
      for (const alias of this.duplicates.aliasesForBook(duplicate.id)) {
        this.duplicates.upsertAlias({ ...alias, bookId: canonical.id, detectedAt: now });
      }
      this.duplicates.upsertAlias({
        path: duplicate.path,
        bookId: canonical.id,
        sourceId: duplicate.source_id,
        size: duplicate.size,
        mtime: duplicate.mtime,
        contentHash,
        detectedAt: now,
      });
      this.mergeLog.save({
        id: this.ids.next(),
        canonicalId: canonical.id,
        duplicateId: duplicate.id,
        duplicatePath: duplicate.path,
        sourceId: duplicate.source_id,
        contentHash,
        noteIds,
        progress: progress.progress,
        mergedAt: now,
      });
      this.books.delete(duplicate.id);
      result.booksRemoved += 1;
      // The effective cover of a duplicate whose override was adopted is the custom file
      // now owned by the canonical book; removing it would delete the inherited cover.
      const adoptedCustomCover = adoptedCover !== undefined && adoptedCover !== null;
      if (duplicate.cover_path && !adoptedCustomCover) files.push({ path: duplicate.cover_path });
      if (duplicate.source_id === null) {
        // Only a file managed by the app; library folders are read-only. The row's version
        // travels with the removal so a file that changed during the merge is kept.
        files.push({ path: duplicate.path, size: duplicate.size, mtime: duplicate.mtime });
        result.managedFilesRemoved += 1;
      }
    }
    return result;
  }

  /**
   * Moves the duplicate's override to the canonical row when the canonical has none.
   * Returns the custom cover path that must be moved after the transaction, `null` when
   * there is no custom cover, and `undefined` when nothing was adopted. The database
   * transaction owns the row move; the file rename is a post-commit side effect.
   */
  private adoptOverride(canonicalId: string, duplicateId: string): string | null | undefined {
    if (!this.metadata) return undefined;
    if (this.metadata.get(canonicalId)) return undefined;
    const source = this.metadata.get(duplicateId);
    if (!source) return undefined;
    if (!this.metadata.move(duplicateId, canonicalId)) return undefined;
    return source.coverPath;
  }
}
