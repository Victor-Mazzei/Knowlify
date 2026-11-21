import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { createMockDuplicatesApi } from "./mockDuplicatesApi";
import { manyDuplicateGroups } from "./mockDuplicatesData";
import type {
  DuplicateBook,
  DuplicateGroup,
  DuplicatesPage,
  MergeAccepted,
  MergeResult,
  MergeReview,
  MergeTarget,
} from "./types";
import { useDuplicates } from "./useDuplicates";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const book = (id: string): DuplicateBook => ({
  id,
  title: `Book ${id}`,
  author: "Author",
  format: "epub",
  path: `/library/${id}.epub`,
  sourceId: "source-1",
  sourceLabel: "Fiction",
  addedAt: 1,
  canonical: true,
  hasNotes: false,
  hasProgress: false,
  indexed: false,
});

const group = (index: number): DuplicateGroup => ({
  key: `${index}:${"a".repeat(64)}`,
  size: index,
  contentHash: "a".repeat(64),
  canonicalId: `b${index}`,
  books: [book(`b${index}`)],
  aliases: [],
});

const page = (groups: DuplicateGroup[], nextCursor: string | null): DuplicatesPage => ({
  groups,
  nextCursor,
  summary: { groups: 2, redundantBooks: 1, reclaimableBytes: 1024 },
});

function expectedTotals(groups: DuplicateGroup[]): { booksRemoved: number; notesMoved: number } {
  let booksRemoved = 0;
  let notesMoved = 0;
  for (const item of groups) {
    const duplicates = item.books.filter((copy) => copy.id !== item.canonicalId);
    booksRemoved += duplicates.length;
    notesMoved += duplicates.filter((copy) => copy.hasNotes).length;
  }
  return { booksRemoved, notesMoved };
}

type MergeCall = { dryRun: boolean; groups?: MergeTarget[] | "all"; confirm?: MergeAccepted[] };

function recordingApi(base: ApiFn, calls: MergeCall[]) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/duplicates/merge" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as {
        groups?: MergeTarget[] | "all";
        confirm?: MergeAccepted[];
        dryRun?: boolean;
      };
      calls.push({ dryRun: body.dryRun === true, groups: body.groups, confirm: body.confirm });
    }
    return base(path, init);
  });
}

/** Adds a group to the list after the merge commits, as a later scan would. */
function withGroupAfterMerge(base: ApiFn, extra: DuplicateGroup): ApiFn {
  let merged = false;
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/duplicates/merge" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { dryRun?: boolean };
      if (body.dryRun !== true) merged = true;
    }
    const response = await base(path, init);
    if (!merged || !path.startsWith("/api/duplicates?") || (init?.method ?? "GET").toUpperCase() !== "GET") {
      return response;
    }
    const payload = (await response.json()) as DuplicatesPage;
    return json({
      ...payload,
      groups: [...payload.groups, extra],
      summary: {
        ...payload.summary,
        groups: payload.summary.groups + 1,
        redundantBooks: payload.summary.redundantBooks + Math.max(0, extra.books.length - 1),
      },
    });
  });
}

describe("useDuplicates", () => {
  it("loads the first page and appends the next one", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/api/scan") {
        return json({ scanning: false, pending: 0, duplicates: { state: "ready", progress: null, groups: 2, redundantBooks: 1 } });
      }
      if (path.includes("cursor=next")) return json(page([group(2)], null));
      return json(page([group(1)], "next"));
    });
    const { result, unmount } = renderHook(() => useDuplicates(api));

    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.nextCursor).toBe("next");
    expect(result.current.scan?.state).toBe("ready");

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.groups.map((item) => item.key)).toEqual([group(1).key, group(2).key]);
    expect(result.current.nextCursor).toBeNull();
    unmount();
  });

  it("reports an older server as unavailable", async () => {
    const api = vi.fn(async () => new Response("{}", { status: 404 }));
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it("merges the accepted groups and reloads the summary", async () => {
    const api = createMockDuplicatesApi();
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.groups).toHaveLength(3));

    await act(async () => {
      const target = [{ key: result.current.groups[0]!.key }];
      const review = await result.current.dryRun(target);
      expect(review.accepted).toHaveLength(1);
      const outcome = await result.current.merge();
      expect(outcome.merged).toBe(1);
    });
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    expect(result.current.summary?.groups).toBe(2);
    unmount();
  });

  it("keeps a non-default canonical choice in the confirmed merge", async () => {
    const calls: MergeCall[] = [];
    const api = recordingApi(createMockDuplicatesApi(), calls);
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.groups).toHaveLength(3));

    const first = result.current.groups[0]!;
    const alternate = first.books.find((copy) => copy.id !== first.canonicalId)!.id;
    await act(async () => {
      const review = await result.current.dryRun([{ key: first.key, canonicalId: alternate }]);
      expect(review.accepted).toHaveLength(1);
      const outcome = await result.current.merge();
      expect(outcome.merged).toBe(1);
      expect(outcome.skipped).toEqual([]);
    });

    const merge = calls.find((call) => !call.dryRun);
    expect(merge?.groups).toEqual([{ key: first.key, canonicalId: alternate }]);
    expect(merge?.confirm).toHaveLength(1);
    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    unmount();
  });

  it("refuses to merge without a reviewed dry-run", async () => {
    const api = createMockDuplicatesApi();
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.groups).toHaveLength(3));

    await act(async () => {
      await expect(result.current.merge()).rejects.toThrow("Review the merge plan before merging.");
      await result.current.dryRun([{ key: result.current.groups[0]!.key }]);
      await result.current.merge();
      await expect(result.current.merge()).rejects.toThrow("Review the merge plan before merging.");
    });
    expect(result.current.groups).toHaveLength(2);
    unmount();
  });

  it("checks every group in batches before merging more than 500", async () => {
    const seeded = manyDuplicateGroups(1200);
    const expected = expectedTotals(seeded);
    const calls: MergeCall[] = [];
    const api = recordingApi(createMockDuplicatesApi({ groups: seeded }), calls);
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.summary?.groups).toBe(1200));

    let review!: MergeReview;
    await act(async () => {
      review = await result.current.dryRun("all");
    });
    expect(review.requested).toBe(1200);
    expect(review.plan.groups).toBe(1200);
    expect(review.plan.booksRemoved).toBe(expected.booksRemoved);
    expect(review.plan.notesMoved).toBe(expected.notesMoved);
    expect(review.omitted).toEqual([]);
    expect(review.accepted).toHaveLength(1200);

    const dryRuns = calls.filter((call) => call.dryRun);
    expect(dryRuns.map((call) => (call.groups as MergeTarget[]).length)).toEqual([500, 500, 200]);
    expect(dryRuns.every((call) => Array.isArray(call.groups) && call.groups.length <= 500)).toBe(true);

    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.merge();
    });
    expect(outcome.merged).toBe(1200);
    expect(outcome.booksRemoved).toBe(expected.booksRemoved);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.remaining).toBe(0);

    const merges = calls.filter((call) => !call.dryRun);
    expect(merges.map((call) => call.confirm?.length)).toEqual([500, 500, 200]);
    expect(merges.map((call) => (call.groups as MergeTarget[]).length)).toEqual([500, 500, 200]);
    const confirmedKeys = merges.flatMap((call) => call.confirm?.map((item) => item.key) ?? []);
    expect(confirmedKeys).toEqual(seeded.map((item) => item.key));
    const mergedGroups = merges.flatMap((call) => call.groups as MergeTarget[]);
    expect(mergedGroups).toEqual(seeded.map((item) => ({ key: item.key })));
    expect(
      merges.flatMap((call) => call.confirm ?? []).every((item) => item.fingerprint.length > 0),
    ).toBe(true);
    expect(result.current.summary?.groups).toBe(0);
    expect(result.current.groups).toEqual([]);
    unmount();
  });

  it("accumulates skipped groups across batches and reports the remainder", async () => {
    const seeded = manyDuplicateGroups(1200);
    const skip = new Set([seeded[10]!.key, seeded[700]!.key]);
    const skippedDuplicates = seeded
      .filter((item) => skip.has(item.key))
      .reduce((total, item) => total + item.books.length - 1, 0);
    const api = createMockDuplicatesApi({ groups: seeded, skipMergeKeys: skip });
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.summary?.groups).toBe(1200));

    await act(async () => {
      await result.current.dryRun("all");
    });

    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.merge();
    });
    expect(outcome.merged).toBe(1198);
    expect(outcome.booksRemoved).toBe(expectedTotals(seeded).booksRemoved - skippedDuplicates);
    expect(outcome.skipped.map((item) => item.key).sort()).toEqual([...skip].sort());
    expect(outcome.remaining).toBe(2);
    expect(result.current.summary?.groups).toBe(2);
    unmount();
  });

  it("confirms only the groups accepted by the dry-run", async () => {
    const seeded = manyDuplicateGroups(1200);
    const omitted = seeded[42]!.key;
    const calls: MergeCall[] = [];
    const api = recordingApi(
      createMockDuplicatesApi({ groups: seeded, skipDryRunKeys: new Set([omitted]) }),
      calls,
    );
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.summary?.groups).toBe(1200));

    let review!: MergeReview;
    await act(async () => {
      review = await result.current.dryRun("all");
    });
    expect(review.accepted).toHaveLength(1199);
    expect(review.omitted).toEqual([omitted]);

    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.merge();
    });
    expect(outcome.merged).toBe(1199);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.remaining).toBe(1);
    const confirmed = calls
      .filter((call) => !call.dryRun)
      .flatMap((call) => call.confirm?.map((item) => item.key) ?? []);
    expect(confirmed).not.toContain(omitted);
    expect(confirmed).toHaveLength(1199);
    const confirmedGroups = calls
      .filter((call) => !call.dryRun)
      .flatMap((call) => (call.groups as MergeTarget[] | undefined)?.map((item) => item.key) ?? []);
    expect(confirmedGroups).not.toContain(omitted);
    expect(confirmedGroups).toHaveLength(1199);
    unmount();
  });

  it("does not merge a group omitted from the reviewed scope", async () => {
    const seeded = manyDuplicateGroups(3);
    const omitted = seeded[0]!.key;
    const unstable = new Set([omitted]);
    const calls: MergeCall[] = [];
    const api = recordingApi(
      createMockDuplicatesApi({ groups: seeded, skipDryRunKeys: unstable }),
      calls,
    );
    // The group becomes stable again after the batch commits. An implementation
    // that re-reviews the whole library would merge it without a new consent.
    const clearing = vi.fn(async (path: string, init?: RequestInit) => {
      const response = await api(path, init);
      if (path === "/api/duplicates/merge" && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { dryRun?: boolean };
        if (body.dryRun === false) unstable.clear();
      }
      return response;
    });
    const { result, unmount } = renderHook(() => useDuplicates(clearing));
    await waitFor(() => expect(result.current.summary?.groups).toBe(3));

    await act(async () => {
      await result.current.dryRun("all");
    });
    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.mergeAll();
    });
    expect(outcome.merged).toBe(2);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.remaining).toBe(1);
    expect(result.current.summary?.groups).toBe(1);

    const dryRuns = calls.filter((call) => call.dryRun);
    const merges = calls.filter((call) => !call.dryRun);
    expect(dryRuns).toHaveLength(1);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.confirm?.map((item) => item.key)).toEqual(seeded.slice(1).map((item) => item.key));
    expect(merges[0]?.confirm?.map((item) => item.key)).not.toContain(omitted);
    unmount();
  });

  it("stops after the reviewed batch when a group changed", async () => {
    const seeded = manyDuplicateGroups(2);
    const changing = seeded[1]!.key;
    const calls: MergeCall[] = [];
    const api = recordingApi(
      createMockDuplicatesApi({ groups: seeded, skipMergeKeys: new Set([changing]) }),
      calls,
    );
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.summary?.groups).toBe(2));

    await act(async () => {
      await result.current.dryRun("all");
    });
    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.mergeAll();
    });
    expect(outcome.merged).toBe(1);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]).toMatchObject({ key: changing, reason: "changed" });
    expect(outcome.remaining).toBe(1);
    expect(result.current.summary?.groups).toBe(1);
    expect(calls.filter((call) => !call.dryRun)).toHaveLength(1);
    unmount();
  });

  it("does not merge a group that appears after the reviewed batch", async () => {
    const seeded = manyDuplicateGroups(3);
    const extra = manyDuplicateGroups(4)[3]!;
    const calls: MergeCall[] = [];
    const api = recordingApi(
      withGroupAfterMerge(createMockDuplicatesApi({ groups: seeded }), extra),
      calls,
    );
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.summary?.groups).toBe(3));

    await act(async () => {
      await result.current.dryRun("all");
    });
    let outcome!: MergeResult;
    await act(async () => {
      outcome = await result.current.mergeAll();
    });
    expect(outcome.merged).toBe(3);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.remaining).toBe(1);
    expect(result.current.groups.map((item) => item.key)).toEqual([extra.key]);

    const dryRuns = calls.filter((call) => call.dryRun);
    const merges = calls.filter((call) => !call.dryRun);
    expect(dryRuns).toHaveLength(1);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.confirm?.map((item) => item.key)).toEqual(seeded.map((item) => item.key));
    expect(merges[0]?.confirm?.map((item) => item.key)).not.toContain(extra.key);
    unmount();
  });

  it("does not prepare a merge when the server omits accepted", async () => {
    const base = createMockDuplicatesApi();
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      const response = await base(path, init);
      if (path !== "/api/duplicates/merge" || typeof init?.body !== "string") return response;
      const body = JSON.parse(init.body) as { dryRun?: boolean };
      if (body.dryRun !== true) return response;
      const payload = (await response.json()) as Record<string, unknown>;
      delete payload.accepted;
      delete payload.omitted;
      return json(payload);
    });
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.groups).toHaveLength(3));

    await act(async () => {
      const review = await result.current.dryRun("all");
      expect(review.accepted).toBeNull();
      await expect(result.current.merge()).rejects.toThrow("Review the merge plan before merging.");
    });
    expect(result.current.groups).toHaveLength(3);
    unmount();
  });

  it("starts an analysis from the idle state", async () => {
    const api = createMockDuplicatesApi();
    const { result, unmount } = renderHook(() => useDuplicates(api));
    await waitFor(() => expect(result.current.scan?.state).toBe("ready"));

    await act(async () => {
      await result.current.startScan();
    });
    expect(result.current.scan?.state).toBe("hashing");
    unmount();
  });
});
