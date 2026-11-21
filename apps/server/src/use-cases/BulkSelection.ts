import { ConflictError, ValidationError } from "../domain/errors.js";
import type { BookListReader, BookSelection } from "../ports/index.js";

export interface SelectionLimits {
  /** Ceiling for an explicit id list. */
  maxIds: number;
  /** Ceiling for a filter selection; the request is rejected above it. */
  maxFilter: number;
}

export interface ResolvedSelection {
  /** Existing book ids, in the order the reader returned them. */
  ids: string[];
  /** Requested ids that no longer exist (id selection only). */
  missing: number;
}

/**
 * Resolves either selection form inside the caller's transaction. A filter selection is
 * re-counted at operation time; a mismatch means the result set changed since the client
 * reviewed the impact, so the operation is rejected instead of applying to another set.
 */
export function resolveSelection(
  selection: BookSelection,
  reader: Pick<BookListReader, "byIds" | "count" | "matchingIds">,
  limits: SelectionLimits,
): ResolvedSelection {
  if ("ids" in selection) {
    if (selection.ids.length === 0) throw new ValidationError("selection.ids cannot be empty");
    if (selection.ids.length > limits.maxIds) {
      throw new ValidationError(`selection.ids accepts at most ${limits.maxIds} values`);
    }
    const unique = [...new Set(selection.ids)];
    const found = reader.byIds(unique);
    return { ids: found.map((book) => book.id), missing: unique.length - found.length };
  }
  const total = reader.count(selection.filter);
  if (total !== selection.expectedTotal) {
    throw new ConflictError("The selection changed; review the current total", "selection_changed", { total });
  }
  if (total > limits.maxFilter) {
    throw new ConflictError(`The selection is larger than ${limits.maxFilter} books`, "selection_too_large", {
      total,
      max: limits.maxFilter,
    });
  }
  return { ids: reader.matchingIds(selection.filter, limits.maxFilter + 1), missing: 0 };
}
