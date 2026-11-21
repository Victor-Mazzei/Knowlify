import { isContentHash } from "../domain/library/ContentIdentity.js";
import { fileView } from "../domain/library/Book.js";
import { ValidationError } from "../domain/errors.js";
import type {
  Book,
  BookRepository,
  Clock,
  ContentHasher,
  ContentIdentityOutcome,
  ContentIdentityResolver,
  DuplicateRepository,
  FileStore,
  IdentityRequest,
  IgnoredBookRepository,
  ScanEvidence,
  SourceRepository,
} from "../ports/index.js";

type FileProbe = Pick<FileStore, "statIfExists" | "isDirectory" | "isWindows">;
type FileVersion = { size: number; mtime: number };

const oldestFirst = (a: Book, b: Book): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A file whose bytes are about to be read, and the row that would receive the hash. */
interface HashTarget {
  path: string;
  /** Version the caller saw (walk stat or book row); the file must still match it. */
  size: number;
  mtime: number | null;
  /** Row to persist the verified hash into; absent for a file with no row yet. */
  bookId?: string;
}

/**
 * Owns the "new / duplicate / moved" decision (ADR-4/ADR-6). Hashing happens before the
 * per-size lock; the candidate check and the row write happen inside it, in one synchronous
 * SQLite section. Two uploads of the same bytes, or an upload during a scan, therefore agree
 * on a single book.
 *
 * A stored hash is only a cache of the row's `size`/`mtime` version: it is used only after
 * the real file is stat-ed and found to still have that version. A stale hash is discarded
 * and the bytes actually on disk are read again (never attached to the old version).
 */
export class ContentIdentity implements ContentIdentityResolver {
  private readonly locks = new Map<number, Promise<void>>();

  constructor(
    private readonly books: BookRepository,
    private readonly duplicates: DuplicateRepository,
    private readonly hasher: ContentHasher,
    private readonly files: FileProbe,
    private readonly sources: Pick<SourceRepository, "list">,
    private readonly clock: Clock,
    private readonly ignored?: Pick<IgnoredBookRepository, "hasHash">,
  ) {}

  async resolve(request: IdentityRequest): Promise<ContentIdentityOutcome> {
    const { book } = request;
    const hashes = new Map<string, string>();
    /** Version of the real file whose hash is in `hashes`. */
    const versions = new Map<string, FileVersion>();
    const unreadable = new Set<string>();
    const sourceAvailability = new Map<string, Promise<boolean>>();
    if (request.contentHash !== undefined) {
      if (!isContentHash(request.contentHash)) throw new ValidationError("Invalid content hash");
      hashes.set(book.path, request.contentHash);
    }
    // A same-size ignored tombstone means a scan must read the bytes even when no current
    // row shares the size; otherwise deleted content would be imported from a new path.
    if (request.forceHash === true && !hashes.has(book.path)) {
      await this.hashFile({ path: book.path, size: book.size, mtime: book.mtime }, hashes, unreadable, versions);
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const outcome = await this.withSizeLock(book.size, () =>
        this.decide(request, hashes, unreadable, versions, sourceAvailability));
      if (outcome !== null) return outcome;

      // A candidate appeared (or its hash is still unknown): hash outside the lock (ADR-6).
      this.books.seedContentHashes(book.size);
      for (const candidate of this.books.bySize(book.size, book.path)) {
        if (hashes.has(candidate.path) || unreadable.has(candidate.path)) continue;
        await this.verifyCandidate(candidate, hashes, unreadable, versions);
      }
      if (!hashes.has(book.path) && this.books.bySize(book.size, book.path).length > 0) {
        // The file changed between the walk's stat and the end of the hash (ADR-6 TOCTOU):
        // discard the result and let the next scan see the settled version. Never decide
        // "new" or "moved" from bytes that were not read from a stable file.
        if (!await this.hashFile({ path: book.path, size: book.size, mtime: book.mtime }, hashes, unreadable, versions)) {
          return { kind: "changed", book: { ...book, content_hash: null } };
        }
      }
    }
    throw new Error("content identity did not stabilize");
  }

  /** Returns `null` when a hash is still missing and the caller must compute it outside the lock. */
  private async decide(
    request: IdentityRequest,
    hashes: Map<string, string>,
    unreadable: Set<string>,
    versions: Map<string, FileVersion>,
    sourceAvailability: Map<string, Promise<boolean>>,
  ): Promise<ContentIdentityOutcome | null> {
    const { book } = request;
    this.books.seedContentHashes(book.size);
    const candidates = this.books.bySize(book.size, book.path);
    if (!hashes.has(book.path) && candidates.length > 0) return null;
    if (candidates.some((candidate) => !hashes.has(candidate.path) && !unreadable.has(candidate.path))) return null;
    // The incoming file may have changed while a candidate was re-verified after a retry.
    if (!await this.versionStillCurrent(book.path, versions)) {
      hashes.delete(book.path);
      versions.delete(book.path);
      return null;
    }

    const hash = hashes.get(book.path) ?? null;
    // Ignore only decisions that would create data: a changed file keeps its existing book
    // and its notes/progress even if another copy of that content was deleted before.
    if (request.existingBookId === undefined && request.restoreIgnored !== true
      && hash !== null && this.ignored?.hasHash(hash)) {
      return { kind: "ignored" };
    }
    if (request.existingBookId !== undefined) {
      // A changed file keeps its book id. If its new bytes equal another book, that is a
      // manual merge decision for DuplicateFinder: turning it into an alias would hide the
      // notes and progress tied to this id.
      const changed = { ...book, content_hash: hash };
      this.books.save(changed);
      return { kind: "changed", book: changed };
    }

    const matching = hash === null ? [] : candidates.filter((candidate) => hashes.get(candidate.path) === hash);
    const alive: Book[] = [];
    const missing: Book[] = [];
    // Candidates whose absence could not be proven by this scan: a stat failure, a source
    // that was not walked, an empty mount point or a partially read folder. None of them
    // may repoint the canonical path.
    const unverifiable: Book[] = [];
    for (const candidate of matching) {
      let current: FileVersion | null;
      let failed = false;
      try {
        current = await this.files.statIfExists(candidate.path);
      } catch {
        current = null;
        failed = true;
      }
      // Another upload may have committed its row but not moved the temp file yet. That row
      // is the canonical copy (its writer is about to place the file), not a moved book.
      const inFlightUpload = candidate.source_id === null && candidate.status === "pending";
      if (current === null) {
        if (inFlightUpload) {
          alive.push(candidate);
        } else if (failed) {
          unverifiable.push(candidate);
        } else if (!this.walkSaysGone(candidate, request.scan)
          || !await this.sourceRootAvailable(candidate.source_id, sourceAvailability)) {
          // An unmounted NAS (even with an existing but empty mount point) looks like ENOENT
          // for every path under it. A source that was not walked successfully may still
          // hold the file, so its absence is not proof of a move.
          unverifiable.push(candidate);
        } else {
          missing.push(candidate);
        }
        continue;
      }
      const version = versions.get(candidate.path);
      if (!version || current.size !== version.size || current.mtime !== version.mtime) {
        // The file changed after its hash was verified: that hash no longer describes it.
        hashes.delete(candidate.path);
        versions.delete(candidate.path);
        this.books.clearContentHashIfCurrent(candidate.id, candidate.size, candidate.mtime);
        return null;
      }
      alive.push(candidate);
    }
    if (alive.length > 0) {
      return this.aliasTo(alive.sort(oldestFirst)[0]!, book, hash!);
    }
    if (unverifiable.length > 0) {
      // The file may still be there (source not scanned, empty mount point, read error).
      // Keep every existing row at its path and hide the new occurrence as an alias of the
      // oldest copy instead of claiming the canonical book moved.
      return this.aliasTo([...unverifiable, ...missing].sort(oldestFirst)[0]!, book, hash!);
    }
    if (missing.length > 0) {
      // Every matching path is definitively gone and its source was walked successfully in
      // this execution: this is the same file moved/renamed. Keep the id.
      const movedFrom = [...missing].sort(oldestFirst)[0]!;
      const moved: Book = {
        // `movedFrom` was read from `books`, which returns effective values. The
        // repository stores file values, so a user override must not become one.
        ...fileView(movedFrom),
        path: book.path,
        source_id: book.source_id ?? null,
        size: book.size,
        mtime: book.mtime ?? null,
        content_hash: hash,
      };
      this.books.save(moved);
      this.duplicates.deleteAlias(book.path);
      return { kind: "moved", bookId: moved.id, book: moved };
    }

    const created: Book = { ...book, content_hash: hash };
    this.books.save(created);
    this.duplicates.deleteAlias(book.path);
    return { kind: "new", book: created };
  }

  private aliasTo(canonical: Book, incoming: Book, hash: string): ContentIdentityOutcome {
    this.duplicates.upsertAlias({
      path: incoming.path,
      bookId: canonical.id,
      sourceId: incoming.source_id ?? null,
      size: incoming.size,
      mtime: incoming.mtime ?? null,
      contentHash: hash,
      detectedAt: this.clock.now(),
    });
    return { kind: "duplicate", bookId: canonical.id };
  }

  /**
   * True only when this scan execution walked the candidate's source to the end, saw at
   * least one file in it and did not skip the candidate's path or a parent directory. A
   * source outside the map was not scanned (NAS offline, root unreadable, upload), so its
   * absence answers nothing about a move.
   */
  private walkSaysGone(candidate: Book, scan: ReadonlyMap<string, ScanEvidence> | undefined): boolean {
    if (candidate.source_id === null || scan === undefined) return false;
    const walk = scan.get(candidate.source_id);
    if (!walk || walk.seen.size === 0) return false;
    if (walk.seen.has(candidate.path) || walk.failedStat.has(candidate.path)) return false;
    const separator = this.files.isWindows ? "\\" : "/";
    return !walk.unreadable.some((dir) => {
      const prefix = dir.endsWith(separator) ? dir : `${dir}${separator}`;
      return candidate.path.startsWith(prefix);
    });
  }

  /**
   * Makes a candidate hash usable only while the real file still has the row version the
   * hash was computed for. A stale hash is cleared and the bytes actually present are read
   * again, without attaching that new hash to the old row version.
   */
  private async verifyCandidate(
    candidate: Book,
    hashes: Map<string, string>,
    unreadable: Set<string>,
    versions: Map<string, FileVersion>,
  ): Promise<void> {
    const cached = candidate.content_hash && isContentHash(candidate.content_hash) ? candidate.content_hash : null;
    let current: FileVersion | null;
    try {
      current = await this.files.statIfExists(candidate.path);
    } catch {
      unreadable.add(candidate.path);
      return;
    }
    if (!current) {
      // The row is the only remaining record of the moved file. Keep its last known hash
      // for the moved decision, which re-checks the source root before trusting absence.
      if (cached) hashes.set(candidate.path, cached);
      else unreadable.add(candidate.path);
      return;
    }
    const sameVersion = candidate.mtime !== null
      && current.size === candidate.size
      && current.mtime === candidate.mtime;
    if (sameVersion) {
      if (cached) {
        hashes.set(candidate.path, cached);
        versions.set(candidate.path, current);
        return;
      }
      await this.hashFile(
        { path: candidate.path, size: candidate.size, mtime: candidate.mtime, bookId: candidate.id },
        hashes,
        unreadable,
        versions,
      );
      return;
    }
    if (candidate.mtime === null && current.size === candidate.size) {
      // Managed upload (or legacy row) without an mtime: verify the bytes and store the
      // mtime observed while reading, so the merge can revalidate the file.
      await this.hashFile(
        { path: candidate.path, size: candidate.size, mtime: null, bookId: candidate.id },
        hashes,
        unreadable,
        versions,
      );
      return;
    }
    if (cached) this.books.clearContentHashIfCurrent(candidate.id, candidate.size, candidate.mtime);
    // The row no longer describes the file: hash the current bytes for this decision only.
    await this.hashFile(
      { path: candidate.path, size: current.size, mtime: current.mtime },
      hashes,
      unreadable,
      versions,
    );
  }

  /** Confirms that a hash computed earlier in this resolution still describes the file. */
  private async versionStillCurrent(path: string, versions: Map<string, FileVersion>): Promise<boolean> {
    const version = versions.get(path);
    // A request-provided upload hash has no final file to stat yet.
    if (!version) return true;
    const current = await this.files.statIfExists(path).catch(() => null);
    return current !== null && current.size === version.size && current.mtime === version.mtime;
  }

  /**
   * True when the source folder that contains a missing path is still reachable. A whole
   * unmounted source answers ENOENT for every path inside it, which must not read as a move.
   */
  private sourceRootAvailable(
    sourceId: string | null,
    cache: Map<string, Promise<boolean>>,
  ): Promise<boolean> {
    // Managed uploads live under data/books; there is no removable source root.
    if (sourceId === null) return Promise.resolve(true);
    const cached = cache.get(sourceId);
    if (cached) return cached;
    const pending = (async () => {
      const source = this.sources.list().find((row) => row.id === sourceId);
      if (!source) return false;
      // The adapter returns false for missing paths and stat errors.
      return this.files.isDirectory(source.path);
    })();
    cache.set(sourceId, pending);
    return pending;
  }

  /**
   * Reads the file only while its real stat matches the version the caller saw and does not
   * change during the read. A missing, unreadable or mutating file yields no trusted hash.
   */
  private async hashFile(
    target: HashTarget,
    hashes: Map<string, string>,
    unreadable: Set<string>,
    versions: Map<string, FileVersion>,
  ): Promise<boolean> {
    try {
      const before = await this.files.statIfExists(target.path);
      if (!before || before.size !== target.size) {
        unreadable.add(target.path);
        return false;
      }
      if (target.mtime !== null && before.mtime !== target.mtime) {
        unreadable.add(target.path);
        return false;
      }
      const hash = await this.hasher.hash(target.path);
      const after = await this.files.statIfExists(target.path);
      if (!after || after.size !== before.size || after.mtime !== before.mtime) {
        unreadable.add(target.path);
        return false;
      }
      if (target.bookId) {
        const stored = this.books.setContentHashIfCurrent(
          target.bookId,
          hash,
          target.size,
          target.mtime,
          target.mtime === null ? before.mtime : undefined,
        );
        if (!stored) {
          // The row moved on while the file was hashed; its hash cannot be trusted for it.
          unreadable.add(target.path);
          return false;
        }
      }
      hashes.set(target.path, hash);
      versions.set(target.path, before);
      return true;
    } catch {
      unreadable.add(target.path);
      return false;
    }
  }

  private withSizeLock<T>(size: number, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(size) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    this.locks.set(size, tail);
    void tail.then(() => {
      if (this.locks.get(size) === tail) this.locks.delete(size);
    });
    return next;
  }
}
