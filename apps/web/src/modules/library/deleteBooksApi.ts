import type { ApiFn } from "../../components/dialogs";
import { ApiError, readJson } from "../../services/api";
import type { BookSelection, DeleteDryRun, DeletePartial, DeleteResult } from "../../types";

/** What the dialog tells the page after a partial deletion. */
export type DeleteProgress = {
  /** Explicit ids already committed; a filtered selection refreshes instead. */
  removedIds?: string[];
  /** The only part that still needs review, or null when nothing is left. */
  remaining: BookSelection | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const numberField = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

export function normalizeDryRun(value: unknown): DeleteDryRun | null {
  if (!isRecord(value)) return null;
  return {
    books: numberField(value.books),
    notes: numberField(value.notes),
    conversations: numberField(value.conversations),
    withProgress: numberField(value.withProgress),
    indexed: numberField(value.indexed),
    managedFiles: numberField(value.managedFiles),
    externalBooks: numberField(value.externalBooks),
    wouldIgnore: numberField(value.wouldIgnore),
  };
}

const normalizeResult = (value: unknown): DeleteResult | null => {
  if (!isRecord(value)) return null;
  return {
    removed: numberField(value.removed),
    missing: numberField(value.missing),
    notesRemoved: numberField(value.notesRemoved),
    ignored: numberField(value.ignored),
    filesRemoved: numberField(value.filesRemoved),
    fileErrors: numberField(value.fileErrors),
    remaining: numberField(value.remaining),
  };
};

export async function requestDeleteDryRun(api: ApiFn, selection: BookSelection): Promise<DeleteDryRun> {
  const response = await api("/api/books/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection, dryRun: true }),
  });
  const report = normalizeDryRun(await readJson(response));
  if (!report) throw new Error("The server returned an unexpected report.");
  return report;
}

export async function requestDelete(
  api: ApiFn,
  selection: BookSelection,
  confirmNotes: boolean,
): Promise<DeleteResult> {
  const response = await api("/api/books/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selection,
      ...(confirmNotes ? { confirmNotes: true } : {}),
      dryRun: false,
    }),
  });
  const result = normalizeResult(await readJson(response));
  if (!result) throw new Error("The server returned an unexpected result.");
  return result;
}

/**
 * A 409 with `removed > 0` means earlier blocks were committed before a note
 * created mid-operation blocked the rest. A stale total (`removed` absent) is
 * left to the existing review flow.
 */
export function parseDeletePartial(error: unknown): DeletePartial | null {
  if (!(error instanceof ApiError) || error.code !== "selection_changed") return null;
  const details = error.details ?? {};
  const removed = numberField(details.removed);
  const remainingIds = stringList(details.remainingIds);
  const remainingTotal = typeof details.remainingTotal === "number" ? details.remainingTotal : undefined;
  // The server also reports the remainder when the first block was blocked before
  // anything was deleted (removed 0). A stale dry-run total (`total` only) is not
  // a partial result and keeps the old review flow.
  if (removed <= 0 && remainingIds === undefined && remainingTotal === undefined) return null;
  return {
    removed,
    ...(remainingIds === undefined ? {} : { remainingIds }),
    ...(remainingTotal === undefined ? {} : { remainingTotal }),
  };
}

export function selectionSize(selection: BookSelection): number {
  return "ids" in selection ? selection.ids.length : selection.expectedTotal;
}

/** Explicit ids the server reports as gone, derived from the remaining list. */
export function removedIdsOf(current: BookSelection, partial: DeletePartial): string[] | undefined {
  if (!("ids" in current) || partial.remainingIds === undefined) return undefined;
  const remaining = new Set(partial.remainingIds);
  return current.ids.filter((id) => !remaining.has(id));
}

/** The next selection to review; null means the remainder is empty. */
export function remainingSelection(current: BookSelection, partial: DeletePartial): BookSelection | null {
  if ("ids" in current) {
    if (partial.remainingIds === undefined) return { ids: [...current.ids] };
    return partial.remainingIds.length > 0 ? { ids: [...partial.remainingIds] } : null;
  }
  const expectedTotal = partial.remainingTotal ?? Math.max(0, current.expectedTotal - partial.removed);
  return expectedTotal > 0 ? { filter: current.filter, expectedTotal } : null;
}

export function partialMessage(total: number, done: number, remaining: number): string {
  const noun = remaining === 1 ? "book" : "books";
  const verb = remaining === 1 ? "was" : "were";
  return `Deleted ${done} of ${total}. ${remaining} ${noun} changed (new notes) and ${verb} not deleted — review again.`;
}
