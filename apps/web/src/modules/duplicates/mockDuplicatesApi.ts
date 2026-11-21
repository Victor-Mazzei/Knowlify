import type { ApiFn } from "../../components/dialogs";
import {
  duplicateGroupBytes,
  MOCK_CANONICAL_BOOK,
  mockDuplicatesSummary,
  seedDuplicateGroups,
} from "./mockDuplicatesData";
import type {
  DuplicateBook,
  DuplicateGroup,
  DuplicatesScanState,
  MergeAccepted,
  MergePlan,
  MergeResult,
  MergeSkipped,
  MergeTarget,
} from "./types";

/** Fixed name the mock recognizes as an already-imported file (see the dedup plan). */
export const MOCK_DUPLICATE_FILE = "duplicate.epub";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const MOCK_DUPLICATES_SCENARIOS = ["ready", "empty", "hashing", "conflict"] as const;
export type MockDuplicatesScenario = (typeof MOCK_DUPLICATES_SCENARIOS)[number];

export function mockDuplicatesScenario(value: string | null): MockDuplicatesScenario {
  return MOCK_DUPLICATES_SCENARIOS.includes(value as MockDuplicatesScenario)
    ? (value as MockDuplicatesScenario)
    : "ready";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

type MergeBody =
  | { dryRun: true; targets: MergeTarget[] | "all" }
  | { dryRun: false; groups?: MergeTarget[] | "all"; confirm?: MergeAccepted[] };

function readTargets(value: unknown): MergeTarget[] | "all" | null | undefined {
  if (value === undefined) return undefined;
  if (value === "all") return "all";
  if (!Array.isArray(value)) return null;
  const targets: MergeTarget[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string") return null;
    targets.push({
      key: item.key,
      ...(typeof item.canonicalId === "string" ? { canonicalId: item.canonicalId } : {}),
    });
  }
  return targets;
}

function readConfirm(value: unknown): MergeAccepted[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const confirm: MergeAccepted[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.fingerprint !== "string") return null;
    confirm.push({ key: item.key, fingerprint: item.fingerprint });
  }
  return confirm;
}

function readMergeBody(init?: RequestInit): MergeBody | null {
  if (typeof init?.body !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(init.body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const targets = readTargets(value.groups);
  const confirm = readConfirm(value.confirm);
  if (targets === null || confirm === null) return null;
  if (value.dryRun === true) {
    if (targets === undefined) return null;
    return { dryRun: true, targets };
  }
  if (targets === undefined && confirm === undefined) return null;
  return {
    dryRun: false,
    ...(targets === undefined ? {} : { groups: targets }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

/** Deterministic stand-in for the server-side group fingerprint. */
export function mockFingerprint(group: DuplicateGroup, canonicalId: string): string {
  return `${group.key}|${canonicalId}|${group.books.map((book) => book.id).join(",")}`;
}

type Selection = { group: DuplicateGroup; canonicalId: string };

function selectGroups(groups: DuplicateGroup[], targets: MergeTarget[] | "all"): Selection[] {
  if (targets === "all") return groups.map((group) => ({ group, canonicalId: group.canonicalId }));
  const chosen = new Map(targets.map((target) => [target.key, target.canonicalId]));
  return groups
    .filter((group) => chosen.has(group.key))
    .map((group) => ({ group, canonicalId: chosen.get(group.key) ?? group.canonicalId }));
}

function canonicalOf(selection: Selection): DuplicateBook | undefined {
  return (
    selection.group.books.find((item) => item.id === selection.canonicalId) ??
    selection.group.books.find((item) => item.id === selection.group.canonicalId)
  );
}

function planFor(selections: Selection[]): { plan: MergePlan; warnings: string[] } {
  const plan: MergePlan = {
    groups: 0,
    booksRemoved: 0,
    notesMoved: 0,
    conversationsMoved: 0,
    progressKept: 0,
    indexesDropped: 0,
    managedFilesRemoved: 0,
    reclaimableBytes: 0,
  };
  for (const selection of selections) {
    const canonical = canonicalOf(selection);
    if (!canonical) continue;
    const duplicates = selection.group.books.filter((item) => item.id !== canonical.id);
    plan.groups += 1;
    plan.booksRemoved += duplicates.length;
    plan.notesMoved += duplicates.filter((item) => item.hasNotes).length;
    plan.conversationsMoved += duplicates.filter((item) => item.hasNotes).length;
    plan.progressKept += duplicates.filter((item) => item.hasProgress).length;
    plan.indexesDropped += duplicates.filter((item) => item.indexed).length;
    plan.managedFilesRemoved += duplicates.filter((item) => item.sourceId === null).length;
    plan.reclaimableBytes += duplicateGroupBytes(selection.group);
  }
  const warnings = ["Files in library folders are never changed or deleted."];
  if (plan.managedFilesRemoved > 0) {
    warnings.push(`${plan.managedFilesRemoved} uploaded file(s) will be removed from the app data directory.`);
  }
  if (plan.indexesDropped > 0) {
    warnings.push(`Index data for ${plan.indexesDropped} duplicate book(s) will be discarded.`);
  }
  return { plan, warnings };
}

export type MockDuplicatesOptions = {
  scenario?: MockDuplicatesScenario;
  /** Overrides the default three-group fixture (for scale regressions). */
  groups?: DuplicateGroup[];
  /** Groups the dry-run leaves out (`omitted`); the request still contains them. */
  skipDryRunKeys?: ReadonlySet<string>;
  /** Groups the real merge skips as changed, as if the file changed after the review. */
  skipMergeKeys?: ReadonlySet<string>;
};

/**
 * In-memory stand-in for the dedup routes, used by tests and `?mock=duplicates` in dev.
 * `hashing` keeps a fixed progress so the analyzing state can be inspected; `conflict`
 * rejects a real merge with 409.
 */
export function createMockDuplicatesApi(options: MockDuplicatesOptions = {}): ApiFn {
  const scenario = options.scenario ?? "ready";
  let groups = options.groups
    ? [...options.groups]
    : scenario === "empty"
      ? []
      : seedDuplicateGroups();
  let scanState: DuplicatesScanState["state"] = scenario === "hashing" ? "hashing" : "ready";
  const progress = 0.38;

  const state = (): DuplicatesScanState => ({
    state: scanState,
    progress: scanState === "hashing" ? progress : null,
    groups: groups.length,
    redundantBooks: mockDuplicatesSummary(groups).redundantBooks,
  });

  return async (path, init = {}) => {
    const url = new URL(path, "http://mock.knowlify");
    const method = (init.method ?? "GET").toUpperCase();

    if (url.pathname === "/api/scan" && method === "GET") {
      return json({
        scanning: false,
        pending: 0,
        lastScanAt: null,
        skippedDuplicates: 5,
        movedFiles: 2,
        duplicates: state(),
      });
    }

    if (url.pathname === "/api/duplicates/scan" && method === "POST") {
      scanState = "hashing";
      return json(state(), 202);
    }

    if (url.pathname === "/api/duplicates" && method === "GET") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const start = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const end = start + limit;
      return json({
        groups: groups.slice(start, end),
        nextCursor: end < groups.length ? String(end) : null,
        summary: mockDuplicatesSummary(groups),
      });
    }

    if (url.pathname === "/api/duplicates/merge" && method === "POST") {
      const body = readMergeBody(init);
      if (!body) return json({ message: "Invalid merge request." }, 400);
      if (!body.dryRun && scenario === "conflict") {
        return json({ message: "Another duplicate merge is already running." }, 409);
      }
      if (body.dryRun) {
        const selections = selectGroups(groups, body.targets);
        const requested =
          body.targets === "all" ? groups.map((group) => group.key) : body.targets.map((target) => target.key);
        const planned = selections.filter((selection) => !options.skipDryRunKeys?.has(selection.group.key));
        const accepted: MergeAccepted[] = [];
        for (const selection of planned) {
          if (!canonicalOf(selection)) continue;
          const fingerprint = mockFingerprint(selection.group, selection.canonicalId);
          accepted.push({ key: selection.group.key, fingerprint });
        }
        const acceptedKeys = new Set(accepted.map((item) => item.key));
        const omitted = [...new Set(requested)].filter((key) => !acceptedKeys.has(key));
        const { plan, warnings } = planFor(planned);
        return json({ merged: 0, plan, warnings, accepted, omitted });
      }

      // Reproduce the server: `groups` defines the scope (with the canonical the
      // dry-run reviewed); `confirm` only narrows it. Nothing is remembered from
      // an earlier dry-run.
      const requested: MergeTarget[] =
        body.groups === undefined
          ? (body.confirm ?? []).map(({ key }) => ({ key }))
          : body.groups === "all"
            ? groups.map((group) => ({ key: group.key }))
            : body.groups;
      const confirmations =
        body.confirm === undefined ? null : new Map(body.confirm.map((item) => [item.key, item.fingerprint]));
      const skipped: MergeSkipped[] = [];
      const mergedSelections: Selection[] = [];
      const seen = new Set<string>();
      for (const target of requested) {
        if (seen.has(target.key)) continue;
        seen.add(target.key);
        const group = groups.find((candidate) => candidate.key === target.key);
        if (!group) {
          skipped.push({ key: target.key, reason: "gone" });
          continue;
        }
        const selection = { group, canonicalId: target.canonicalId ?? group.canonicalId };
        if (!canonicalOf(selection) || options.skipMergeKeys?.has(target.key)) {
          skipped.push({ key: target.key, reason: "changed" });
          continue;
        }
        const fingerprint = mockFingerprint(group, selection.canonicalId);
        if (confirmations !== null && confirmations.get(target.key) !== fingerprint) {
          skipped.push({ key: target.key, reason: "changed" });
          continue;
        }
        mergedSelections.push(selection);
      }
      const mergedKeys = new Set(mergedSelections.map((selection) => selection.group.key));
      groups = groups.filter((group) => !mergedKeys.has(group.key));
      scanState = "ready";
      const { plan } = planFor(mergedSelections);
      const result: MergeResult = { merged: mergedSelections.length, booksRemoved: plan.booksRemoved, skipped };
      return json({
        ...result,
        notesMoved: plan.notesMoved,
        conversationsMoved: plan.conversationsMoved,
        progressKept: plan.progressKept,
        indexesDropped: plan.indexesDropped,
        managedFilesRemoved: plan.managedFilesRemoved,
        reclaimableBytes: plan.reclaimableBytes,
      });
    }

    return json({ message: "Not found" }, 404);
  };
}

/**
 * Mock upload wrapper used by tests and the `VITE_MOCK_BOOKS=1` dev library: a file
 * named `duplicate.epub` answers 200 with the canonical book plus `duplicateOf`.
 */
export function mockDuplicateUpload(base: ApiFn): ApiFn {
  return async (path, init) => {
    if (path === "/api/books" && (init?.method ?? "GET").toUpperCase() === "POST") {
      const body = init?.body;
      const file = body instanceof FormData ? body.get("file") : null;
      if (file instanceof File && file.name.toLowerCase() === MOCK_DUPLICATE_FILE) {
        return json({ ...MOCK_CANONICAL_BOOK, duplicateOf: MOCK_CANONICAL_BOOK.id }, 200);
      }
    }
    return base(path, init);
  };
}
