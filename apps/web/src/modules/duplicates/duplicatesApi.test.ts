import { describe, expect, it, vi } from "vitest";
import { createDuplicatesApi } from "./duplicatesApi";
import type { DuplicateBook, DuplicateGroup } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const book: DuplicateBook = {
  id: "b1",
  title: "Dune",
  author: "Frank Herbert",
  format: "epub",
  path: "/library/Dune.epub",
  sourceId: "source-1",
  sourceLabel: "Fiction",
  addedAt: 1,
  canonical: true,
  hasNotes: true,
  hasProgress: false,
  indexed: true,
};

const group: DuplicateGroup = {
  key: "100:abc",
  size: 100,
  contentHash: "a".repeat(64),
  canonicalId: "b1",
  books: [book],
  aliases: [],
};

const page = {
  groups: [group],
  nextCursor: "next",
  summary: { groups: 2, redundantBooks: 3, reclaimableBytes: 4096 },
};

const plan = {
  groups: 1,
  booksRemoved: 1,
  notesMoved: 1,
  conversationsMoved: 0,
  progressKept: 0,
  indexesDropped: 1,
  managedFilesRemoved: 0,
  reclaimableBytes: 512,
};

describe("duplicates api", () => {
  it("requests the paged groups and parses the page", async () => {
    const api = vi.fn(async () => json(page));
    const result = await createDuplicatesApi(api).page("cursor-1");
    expect(api).toHaveBeenCalledWith("/api/duplicates?limit=50&cursor=cursor-1");
    expect(result.groups).toHaveLength(1);
    expect(result.summary.redundantBooks).toBe(3);
  });

  it("uses the larger page size when collecting a merge scope", async () => {
    const api = vi.fn(async () => json(page));
    await createDuplicatesApi(api).page(null, 200);
    expect(api).toHaveBeenCalledWith("/api/duplicates?limit=200");
  });

  it("extracts the duplicates block from the scan status", async () => {
    const api = vi.fn(async () =>
      json({ scanning: true, pending: 2, skippedDuplicates: 5, duplicates: { state: "hashing", progress: 0.38, groups: 2, redundantBooks: 3 } }),
    );
    const state = await createDuplicatesApi(api).status();
    expect(api).toHaveBeenCalledWith("/api/scan");
    expect(state).toEqual({ state: "hashing", progress: 0.38, groups: 2, redundantBooks: 3 });
  });

  it("starts an analysis and reads the returned state", async () => {
    const api = vi.fn(async () => json({ state: "hashing", progress: 0.1, groups: 0, redundantBooks: 0 }, 202));
    const state = await createDuplicatesApi(api).scan();
    expect(api).toHaveBeenCalledWith("/api/duplicates/scan", { method: "POST" });
    expect(state?.state).toBe("hashing");
  });

  it("sends a dry-run request with canonical choices and reads the accepted groups", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) =>
      json({
        merged: 0,
        plan,
        warnings: ["1 uploaded copy will be removed."],
        accepted: [{ key: group.key, fingerprint: "fp-1" }],
        omitted: ["changed-group"],
      }),
    );
    const result = await createDuplicatesApi(api).dryRun([{ key: group.key, canonicalId: "b2" }]);
    const [, init] = api.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: [{ key: group.key, canonicalId: "b2" }],
      dryRun: true,
    });
    expect(result.plan.groups).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.accepted).toEqual([{ key: group.key, fingerprint: "fp-1" }]);
    expect(result.omitted).toEqual(["changed-group"]);
  });

  it("marks a dry-run without accepted as a legacy response", async () => {
    const api = vi.fn(async () => json({ merged: 0, plan, warnings: [] }));
    const result = await createDuplicatesApi(api).dryRun([{ key: group.key }]);
    expect(result.accepted).toBeNull();
    expect(result.omitted).toEqual([]);
  });

  it("rejects a malformed accepted list", async () => {
    const api = vi.fn(async () =>
      json({ merged: 0, plan, warnings: [], accepted: [{ key: group.key }], omitted: [] }),
    );
    await expect(createDuplicatesApi(api).dryRun([{ key: group.key }])).rejects.toThrow(
      "The server sent an unexpected response.",
    );
  });

  it("sends the real merge with the reviewed groups and accepted fingerprints", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) =>
      json({ merged: 1, booksRemoved: 1, skipped: [{ key: "gone", reason: "changed" }] }),
    );
    const batch = {
      groups: [{ key: group.key, canonicalId: "b2" }],
      confirm: [{ key: group.key, fingerprint: "fp-1" }],
    };
    const result = await createDuplicatesApi(api).merge(batch);
    const [, init] = api.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ ...batch, dryRun: false });
    expect(result).toEqual({ merged: 1, booksRemoved: 1, skipped: [{ key: "gone", reason: "changed" }] });
  });

  it("surfaces a 409 with the server message", async () => {
    const api = vi.fn(async () => json({ message: "Another duplicate merge is already running." }, 409));
    await expect(
      createDuplicatesApi(api).merge({
        groups: [{ key: group.key }],
        confirm: [{ key: group.key, fingerprint: "fp-1" }],
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Another duplicate merge is already running.",
    });
  });

  it("rejects an unexpected payload", async () => {
    const api = vi.fn(async () => json({ groups: "nope" }));
    await expect(createDuplicatesApi(api).page()).rejects.toThrow("The server sent an unexpected response.");
  });
});
