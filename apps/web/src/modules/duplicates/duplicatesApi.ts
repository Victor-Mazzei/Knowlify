import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { createMockDuplicatesApi, mockDuplicatesScenario } from "./mockDuplicatesApi";
import { parseDryRun, parseMergeResult, parsePage, parseScanState } from "./parse";
import type {
  DuplicatesPage,
  DuplicatesScanState,
  MergeBatch,
  MergeDryRun,
  MergeResult,
  MergeTarget,
} from "./types";

/** Groups per page for the review list; the contract uses the same size in its example. */
export const DUPLICATES_PAGE_SIZE = 50;

/** The page route accepts up to this many groups; used when collecting a large merge. */
export const DUPLICATES_PAGE_LIMIT = 200;

/** The merge route accepts at most this many groups per dry-run or real call. */
export const MERGE_GROUPS_LIMIT = 500;

export type DuplicatesApi = {
  page: (cursor?: string | null, limit?: number) => Promise<DuplicatesPage>;
  status: () => Promise<DuplicatesScanState | null>;
  scan: () => Promise<DuplicatesScanState | null>;
  dryRun: (target: MergeTarget[] | "all") => Promise<MergeDryRun>;
  merge: (batch: MergeBatch) => Promise<MergeResult>;
};

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function read(api: ApiFn, path: string, init?: RequestInit): Promise<unknown> {
  const response = init ? await api(path, init) : await api(path);
  // `useApi` throws for non-2xx; injected APIs (tests, dev fixtures) may not.
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      /* keep the status fallback */
    }
    throw new ApiError(response.status, message);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("The server sent an unexpected response.");
  }
}

function scanStateOf(body: unknown): DuplicatesScanState | null {
  if (typeof body !== "object" || body === null) return null;
  return parseScanState((body as Record<string, unknown>).duplicates);
}

const dryRunBody = (groups: MergeTarget[] | "all") => ({ groups, dryRun: true });

const mergeBody = ({ groups, confirm }: MergeBatch) => ({ groups, confirm, dryRun: false });

export function createDuplicatesApi(api: ApiFn): DuplicatesApi {
  return {
    page: async (cursor, limit = DUPLICATES_PAGE_SIZE) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      return parsePage(await read(api, `/api/duplicates?${query.toString()}`));
    },
    status: async () => scanStateOf(await read(api, "/api/scan")),
    scan: async () => parseScanState(await read(api, "/api/duplicates/scan", { method: "POST" })),
    dryRun: async (target) =>
      parseDryRun(await read(api, "/api/duplicates/merge", jsonInit(dryRunBody(target)))),
    merge: async (batch) =>
      parseMergeResult(await read(api, "/api/duplicates/merge", jsonInit(mergeBody(batch)))),
  };
}

/**
 * Application wiring: `?mock=duplicates` (plus optional `&scenario=empty|hashing|conflict`)
 * swaps in the in-memory provider tree, matching the other settings mocks.
 */
export function duplicatesApi(api: ApiFn): DuplicatesApi {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search);
    if (query.get("mock") === "duplicates") {
      return createDuplicatesApi(
        createMockDuplicatesApi({ scenario: mockDuplicatesScenario(query.get("scenario")) }),
      );
    }
  }
  return createDuplicatesApi(api);
}
