/**
 * Deduplication benchmark: scanner with and without content identity on a library with a
 * known share of byte-identical files (hardlinks). No ports, no Docker, throw-away data dir.
 *
 *   npx tsx scripts/bench/dedup.mts
 *   N=300 DUP_PCT=12 npx tsx scripts/bench/dedup.mts   # smoke run
 *
 * Env: N (files, default 11000), DUP_PCT (default 12), MIN_KB (512), MAX_KB (1536),
 *      KEEP=1 keeps the generated library and databases. One JSON object is printed.
 */
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const N = Math.max(2, Number(process.env.N ?? 11_000));
const DUP_PCT = Math.min(90, Math.max(0, Number(process.env.DUP_PCT ?? 12)));
const MIN_KB = Math.max(1, Number(process.env.MIN_KB ?? 512));
const MAX_KB = Math.max(MIN_KB, Number(process.env.MAX_KB ?? 1536));
const KEEP = process.env.KEEP === "1";

const root = mkdtempSync(join(tmpdir(), "knowlify-dedup-bench-"));
const library = join(root, "library");
mkdirSync(library, { recursive: true });
const booksDir = join(root, "books");
const coversDir = join(root, "covers");
mkdirSync(booksDir, { recursive: true });
mkdirSync(coversDir, { recursive: true });

const { openDb } = await import("../../apps/server/src/adapters/storage/db.js");
const {
  SqliteBookDuplicateRepository,
  SqliteBookRepository,
  SqliteConversationRepository,
  SqliteMergeLogRepository,
  SqliteNoteRepository,
  SqliteProgressRepository,
  SqliteSourceRepository,
  SqliteUnitOfWork,
} = await import("../../apps/server/src/adapters/storage/repositories.js");
const { DiskFileStore } = await import("../../apps/server/src/adapters/files/FileStore.js");
const { NodeContentHasher } = await import("../../apps/server/src/adapters/files/NodeContentHasher.js");
const { ContentIdentity } = await import("../../apps/server/src/use-cases/ContentIdentity.js");
const { DuplicateFinder } = await import("../../apps/server/src/use-cases/DuplicateFinder.js");
const { Scanner } = await import("../../apps/server/src/use-cases/Scanner.js");

const out: Record<string, unknown> = { N, dupPct: DUP_PCT, minKb: MIN_KB, maxKb: MAX_KB };
const round = (value: number) => Math.round(value * 10) / 10;

// ---- fixture: unique contents plus byte-identical hardlinks -------------------------------
let seeded = performance.now();
const duplicateCount = Math.round((N * DUP_PCT) / 100);
const uniqueCount = Math.max(1, N - duplicateCount);
const minBytes = MIN_KB * 1024;
const maxBytes = MAX_KB * 1024;
const base = randomBytes(maxBytes);
const sizes = new Map<string, number>();
const uniquePaths: string[] = [];
for (let i = 0; i < uniqueCount; i++) {
  // Byte-level sizes keep real-world dispersion: a collision needs the same exact length.
  const size = minBytes + Math.floor(Math.random() * (maxBytes - minBytes + 1));
  // A per-file marker keeps different files different while the rest of the payload is
  // reused; writeFileSync copies the bytes before the next iteration mutates the marker.
  Buffer.from(createHash("sha256").update(`file-${i}`).digest("hex"), "ascii").copy(base, 0);
  const path = join(library, `book-${String(i).padStart(5, "0")}.pdf`);
  writeFileSync(path, base.subarray(0, size));
  sizes.set(path, size);
  uniquePaths.push(path);
}
const duplicatePaths: string[] = [];
for (let i = 0; i < duplicateCount; i++) {
  const source = uniquePaths[Math.floor(Math.random() * uniquePaths.length)]!;
  const path = join(library, `copy-${String(i).padStart(5, "0")}.pdf`);
  linkSync(source, path);
  sizes.set(path, sizes.get(source)!);
  duplicatePaths.push(path);
}
const files = readdirSync(library).length;
const uniqueBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
out.fixture = {
  files,
  uniqueFiles: uniqueCount,
  duplicates: duplicateCount,
  uniqueGb: round(uniqueBytes / 1024 / 1024 / 1024),
  seconds: round((performance.now() - seeded) / 1000),
};

const clock = { now: () => Date.now() };
let nextId = 0;
const ids = { next: () => `bench-${++nextId}` };
const metadata = {
  pdf: { extract: async () => ({}) },
  epub: { extract: async () => ({}) },
};
const log = { info: () => {}, error: () => {}, warn: () => {} };

function instrumentedHasher() {
  const inner = new NodeContentHasher();
  const counter = { calls: 0, bytes: 0 };
  return {
    counter,
    hasher: {
      async hash(path: string) {
        counter.calls += 1;
        counter.bytes += sizes.get(path) ?? 0;
        return inner.hash(path);
      },
    },
  };
}

async function measure(run: () => Promise<void>) {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const started = performance.now();
  await run();
  const ms = performance.now() - started;
  histogram.disable();
  return {
    ms: round(ms),
    p99Ms: round(histogram.percentile(99) / 1e6),
    maxMs: round(histogram.max / 1e6),
  };
}

function buildScanner(dedup: boolean) {
  const db = openDb(":memory:");
  const books = new SqliteBookRepository(db);
  const sources = new SqliteSourceRepository(db);
  const aliases = new SqliteBookDuplicateRepository(db);
  const store = new DiskFileStore(booksDir, coversDir);
  const counting = instrumentedHasher();
  let scanner: InstanceType<typeof Scanner>;
  if (dedup) {
    const identity = new ContentIdentity(books, aliases, counting.hasher, store, sources, clock);
    scanner = new Scanner(books, sources, store, clock, ids, metadata, log, undefined, [], {},
      { identity, aliases });
  } else {
    scanner = new Scanner(books, sources, store, clock, ids, metadata, log);
  }
  scanner.processPending = async () => {};
  sources.save({ id: "src", path: library });
  return { db, books, sources, aliases, store, counting, scanner };
}

// ---- baseline: same walk, no content identity --------------------------------------------
const baseline = buildScanner(false);
const baselineCold = await measure(() => baseline.scanner.scan());
const baselineWarm = await measure(() => baseline.scanner.scan());
const baselineBooks = baseline.books.count();
baseline.db.close();

// ---- dedup: cold and warm scans -----------------------------------------------------------
const dedup = buildScanner(true);
const dedupCold = await measure(() => dedup.scanner.scan());
const hashesCold = dedup.counting.counter.calls;
const bytesCold = dedup.counting.counter.bytes;
const aliasesAfterCold = dedup.aliases.aliasSnapshotForSource("src").size;
const booksAfterCold = dedup.books.count();
const coldStatus = dedup.scanner.status();

const hashesBeforeWarm = dedup.counting.counter.calls;
const dedupWarm = await measure(() => dedup.scanner.scan());
const warmHashes = dedup.counting.counter.calls - hashesBeforeWarm;
const warmStatus = dedup.scanner.status();

// ---- duplicate finder over the deduped library -------------------------------------------
const notes = new SqliteNoteRepository(dedup.db);
const conversations = new SqliteConversationRepository(dedup.db);
const progress = new SqliteProgressRepository(dedup.db);
const finder = new DuplicateFinder(
  dedup.books,
  dedup.aliases,
  dedup.counting.hasher,
  dedup.sources,
  notes,
  conversations,
  progress,
  dedup.store,
  new SqliteUnitOfWork(dedup.db),
  new SqliteMergeLogRepository(dedup.db),
  clock,
  ids,
  log,
  { bootDelayMs: 0 },
);
const finderStarted = performance.now();
await finder.analyze();
const finderMs = round(performance.now() - finderStarted);

out.baseline = {
  coldScan: baselineCold,
  warmScan: baselineWarm,
  books: baselineBooks,
};
out.dedup = {
  coldScan: dedupCold,
  warmScan: dedupWarm,
  books: booksAfterCold,
  aliases: aliasesAfterCold,
  skippedDuplicates: coldStatus.skippedDuplicates,
  movedFiles: coldStatus.movedFiles,
  hashCalls: hashesCold,
  bytesReadMb: round(bytesCold / 1024 / 1024),
  warmHashes,
  warmSkippedDuplicates: warmStatus.skippedDuplicates,
};
out.finder = { ms: finderMs, status: finder.status() };
out.overhead = {
  coldMs: round(dedupCold.ms - baselineCold.ms),
  coldPct: round(((dedupCold.ms - baselineCold.ms) / baselineCold.ms) * 100),
  warmMs: round(dedupWarm.ms - baselineWarm.ms),
};
out.root = KEEP ? root : "(removed)";
console.log(JSON.stringify(out, null, 2));

dedup.db.close();
if (!KEEP) rmSync(root, { recursive: true, force: true });
