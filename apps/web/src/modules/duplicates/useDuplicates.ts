import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";
import { duplicatesApi, DUPLICATES_PAGE_LIMIT, MERGE_GROUPS_LIMIT } from "./duplicatesApi";
import { formatCount } from "./format";
import type {
  DuplicateGroup,
  DuplicatesPage,
  DuplicatesScanState,
  DuplicatesSummary,
  MergeAccepted,
  MergeBatch,
  MergePlan,
  MergeResult,
  MergeReview,
  MergeSkipped,
  MergeTarget,
} from "./types";

const POLL_MS = 2500;

const PLAN_FIELDS = [
  "groups",
  "booksRemoved",
  "notesMoved",
  "conversationsMoved",
  "progressKept",
  "indexesDropped",
  "managedFilesRemoved",
  "reclaimableBytes",
] as const satisfies readonly (keyof MergePlan)[];

/** Per-batch counts are replaced by one warning over the combined plan. */
const BATCH_COUNT_WARNINGS = [
  /^\d+ uploaded file\(s\) will be removed from the app data directory\.$/,
  /^Index data for \d+ duplicate book\(s\) will be discarded\.$/,
];

function emptyPlan(): MergePlan {
  return {
    groups: 0,
    booksRemoved: 0,
    notesMoved: 0,
    conversationsMoved: 0,
    progressKept: 0,
    indexesDropped: 0,
    managedFilesRemoved: 0,
    reclaimableBytes: 0,
  };
}

function addPlan(total: MergePlan, part: MergePlan): void {
  for (const field of PLAN_FIELDS) total[field] += part[field];
}

function appendGroups(current: DuplicateGroup[], next: DuplicateGroup[]): DuplicateGroup[] {
  const seen = new Set(current.map((group) => group.key));
  return [...current, ...next.filter((group) => !seen.has(group.key))];
}

function dedupeTargets(targets: MergeTarget[]): MergeTarget[] {
  const unique = new Map<string, MergeTarget>();
  for (const target of targets) unique.set(target.key, target);
  return [...unique.values()];
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

type PreparedMerge = {
  target: MergeTarget[] | "all";
  /** Batches built only from the accepted entries of the reviewed dry-run. */
  batches: MergeBatch[];
  requested: number;
};

type MergeTotals = {
  merged: number;
  booksRemoved: number;
  skipped: MergeSkipped[];
  /** A group is reported once even when later rounds retry it. */
  skippedKeys: Set<string>;
};

function emptyTotals(): MergeTotals {
  return { merged: 0, booksRemoved: 0, skipped: [], skippedKeys: new Set() };
}

export function useDuplicates(api: ApiFn) {
  const client = useMemo(() => duplicatesApi(api), [api]);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [summary, setSummary] = useState<DuplicatesSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [scan, setScan] = useState<DuplicatesScanState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<"scan" | "merge" | null>(null);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const alive = useRef(true);
  const request = useRef(0);
  const scanRef = useRef<DuplicatesScanState | null>(null);
  const prepared = useRef<PreparedMerge | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** A server merge is exclusive, so dry-runs and merges never overlap. */
  const serialize = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = pending.current.then(task, task);
    pending.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const load = useCallback(
    async (options: { append?: boolean; cursor?: string } = {}): Promise<DuplicatesPage | undefined> => {
      const id = ++request.current;
      if (options.append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const page = await client.page(options.cursor);
        if (!alive.current || id !== request.current) return page;
        setGroups((current) => (options.append ? appendGroups(current, page.groups) : page.groups));
        setSummary(page.summary);
        setNextCursor(page.nextCursor);
        setUnavailable(false);
        return page;
      } catch (e) {
        if (!alive.current || id !== request.current) return;
        if (e instanceof ApiError && e.status === 404) {
          setUnavailable(true);
          return;
        }
        setError(formatError(e));
      } finally {
        if (alive.current && id === request.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [client],
  );

  const readScan = useCallback(async () => {
    try {
      const next = await client.status();
      if (!alive.current) return;
      const previous = scanRef.current;
      scanRef.current = next;
      setScan(next);
      if (previous?.state === "hashing" && next?.state !== "hashing") void load();
    } catch {
      // The analysis state is additive; a failure here must not hide the group list.
    }
  }, [client, load]);

  useEffect(() => {
    void load();
    void readScan();
  }, [load, readScan]);

  useEffect(() => {
    if (scan?.state !== "hashing") return;
    const timer = window.setInterval(() => void readScan(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [readScan, scan?.state]);

  const reload = useCallback(() => load(), [load]);
  const loadMore = useCallback(
    () => (nextCursor ? load({ append: true, cursor: nextCursor }) : Promise.resolve()),
    [load, nextCursor],
  );

  const startScan = useCallback(async () => {
    setBusy("scan");
    setError("");
    try {
      const next = await client.scan();
      if (!alive.current) return;
      scanRef.current = next;
      setScan(next);
      if (next?.state === "ready") await load();
    } catch (e) {
      if (alive.current) setError(formatError(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [client, load]);

  const allTargets = useCallback(async (): Promise<MergeTarget[]> => {
    const targets: MergeTarget[] = [];
    const keys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page = await client.page(cursor, DUPLICATES_PAGE_LIMIT);
      for (const group of page.groups) {
        if (keys.has(group.key)) continue;
        keys.add(group.key);
        targets.push({ key: group.key });
      }
      if (!page.nextCursor) break;
      if (cursors.has(page.nextCursor)) throw new Error("The duplicate list did not advance.");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return targets;
  }, [client]);

  /**
   * Runs the dry-run for every batch and keeps only what the server accepted.
   * `accepted: null` means the server predates the reviewed-confirm contract:
   * the report is still useful, but no merge can be confirmed safely.
   */
  const review = useCallback(
    async (target: MergeTarget[] | "all"): Promise<{ review: MergeReview; batches: MergeBatch[] }> => {
      const targets = target === "all" ? await allTargets() : dedupeTargets(target);
      // The server's fingerprint covers the canonical the dry-run used. A manual choice
      // must be repeated in the merge request or the confirmed plan no longer matches.
      const reviewedCanonicals = new Map<string, string>();
      for (const entry of targets) {
        if (entry.canonicalId !== undefined) reviewedCanonicals.set(entry.key, entry.canonicalId);
      }
      const plan = emptyPlan();
      const warnings: string[] = [];
      const accepted = new Map<string, MergeAccepted>();
      const omitted = new Set<string>();
      let supported = true;
      for (const batch of chunk(targets, MERGE_GROUPS_LIMIT)) {
        const result = await client.dryRun(batch);
        addPlan(plan, result.plan);
        if (result.accepted === null) {
          supported = false;
        } else {
          for (const item of result.accepted) accepted.set(item.key, item);
        }
        for (const key of result.omitted) omitted.add(key);
        for (const warning of result.warnings) {
          if (BATCH_COUNT_WARNINGS.some((pattern) => pattern.test(warning))) continue;
          if (!warnings.includes(warning)) warnings.push(warning);
        }
      }
      if (plan.managedFilesRemoved > 0) {
        warnings.push(`${plan.managedFilesRemoved} uploaded file(s) will be removed from the app data directory.`);
      }
      if (plan.indexesDropped > 0) {
        warnings.push(`Index data for ${plan.indexesDropped} duplicate book(s) will be discarded.`);
      }
      const acceptedList = supported ? [...accepted.values()] : null;
      return {
        review: { merged: 0, plan, warnings, requested: targets.length, accepted: acceptedList, omitted: [...omitted] },
        batches:
          acceptedList === null
            ? []
            : chunk(acceptedList, MERGE_GROUPS_LIMIT).map((confirm) => ({
                confirm,
                groups: confirm.map(({ key }) => {
                  const canonicalId = reviewedCanonicals.get(key);
                  return canonicalId === undefined ? { key } : { key, canonicalId };
                }),
              })),
      };
    },
    [allTargets, client],
  );

  const dryRun = useCallback(
    (target: MergeTarget[] | "all"): Promise<MergeReview> => {
      // A new review invalidates the previous scope even while requests are queued.
      prepared.current = null;
      return serialize(async () => {
        const result = await review(target);
        prepared.current =
          result.review.accepted === null
            ? null
            : { target, requested: result.review.requested, batches: result.batches };
        return result.review;
      });
    },
    [review, serialize],
  );

  /** Sends the reviewed confirmations as-is; nothing from local state is merged. */
  const runPrepared = useCallback(
    async (scope: PreparedMerge, totals: MergeTotals): Promise<void> => {
      for (const batch of scope.batches) {
        const result = await client.merge(batch);
        totals.merged += result.merged;
        totals.booksRemoved += result.booksRemoved;
        for (const item of result.skipped) {
          if (totals.skippedKeys.has(item.key)) continue;
          totals.skippedKeys.add(item.key);
          totals.skipped.push(item);
        }
      }
      prepared.current = null;
    },
    [client],
  );

  /**
   * Confirms exactly the batches the user reviewed. A new or previously omitted
   * group is left for a fresh analysis; expanding the scope here would merge
   * groups that never appeared in the totals the user approved.
   */
  const confirmPrepared = useCallback(
    (requireAll: boolean): Promise<MergeResult> =>
      serialize(async () => {
        const scope = prepared.current;
        if (!scope || scope.batches.length === 0 || (requireAll && scope.target !== "all")) {
          throw new Error("Review the merge plan before merging.");
        }
        setBusy("merge");
        setError("");
        const totals = emptyTotals();
        try {
          await runPrepared(scope, totals);
          const page = await load();
          return {
            merged: totals.merged,
            booksRemoved: totals.booksRemoved,
            skipped: totals.skipped,
            remaining: page?.summary.groups ?? Math.max(0, scope.requested - totals.merged - totals.skipped.length),
          };
        } catch (e) {
          await load();
          if (totals.merged > 0) {
            throw new Error(
              `Merged ${formatCount(totals.merged)} ${totals.merged === 1 ? "group" : "groups"} before the merge stopped. ${formatError(e)}`,
            );
          }
          throw e;
        } finally {
          if (alive.current) setBusy(null);
        }
      }),
    [load, runPrepared, serialize],
  );

  const merge = useCallback(() => confirmPrepared(false), [confirmPrepared]);
  const mergeAll = useCallback(() => confirmPrepared(true), [confirmPrepared]);

  return {
    groups,
    summary,
    nextCursor,
    scan,
    loading,
    loadingMore,
    busy,
    error,
    unavailable,
    reload,
    loadMore,
    startScan,
    dryRun,
    merge,
    mergeAll,
  };
}
