import type { FastifyInstance } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import { MAX_TAG_IDS_PER_REQUEST } from "../../domain/library/Tag.js";
import type { BookSelection } from "../../ports/index.js";
import { BULK_LIMITS } from "../../ports/library-tags.js";
import type { BookRemoval } from "../../use-cases/BookRemoval.js";
import type { Tags } from "../../use-cases/Tags.js";
import { parseBookFilters, type BooksQuerystring } from "./booksQuery.js";

const TAG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOOK_ID = /^[^\s,]{1,200}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shared `{ ids }` / `{ filter, expectedTotal }` envelope (ADR-7). */
export function parseSelection(value: unknown, indexingEnabled: boolean, maxIds: number): BookSelection {
  if (!isRecord(value)) throw new ValidationError("selection is required");
  const hasIds = value.ids !== undefined;
  const hasFilter = value.filter !== undefined;
  if (hasIds === hasFilter) throw new ValidationError("selection must have either ids or filter");
  if (hasIds) {
    if (!Array.isArray(value.ids)) throw new ValidationError("selection.ids must be an array");
    if (value.ids.length === 0) throw new ValidationError("selection.ids cannot be empty");
    const invalid = value.ids.find((id) => typeof id !== "string" || !BOOK_ID.test(id));
    if (invalid !== undefined) throw new ValidationError("selection.ids must be book ids");
    const ids = [...new Set(value.ids as string[])];
    if (ids.length > maxIds) throw new ValidationError(`selection.ids accepts at most ${maxIds} values`);
    return { ids };
  }
  if (!isRecord(value.filter)) throw new ValidationError("selection.filter must be an object");
  if (typeof value.expectedTotal !== "number" || !Number.isInteger(value.expectedTotal) || value.expectedTotal < 0) {
    throw new ValidationError("selection.expectedTotal must be a non-negative integer");
  }
  return {
    filter: parseBookFilters(value.filter as BooksQuerystring, indexingEnabled),
    expectedTotal: value.expectedTotal,
  };
}

const parseTagIds = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of tag ids`);
  if (value.length > MAX_TAG_IDS_PER_REQUEST) {
    throw new ValidationError(`${field} accepts at most ${MAX_TAG_IDS_PER_REQUEST} tag ids`);
  }
  const invalid = value.find((id) => typeof id !== "string" || !TAG_ID.test(id));
  if (invalid !== undefined) throw new ValidationError(`${field} must contain tag ids`);
  return [...new Set(value as string[])];
};

interface TagPatchBody {
  selection?: unknown;
  add?: unknown;
  remove?: unknown;
}

export function parseTagPatch(body: unknown, indexingEnabled: boolean): {
  selection: BookSelection;
  add: string[];
  remove: string[];
} {
  if (!isRecord(body)) throw new ValidationError("Invalid tag batch");
  const typed = body as TagPatchBody;
  const add = parseTagIds(typed.add, "add");
  const remove = parseTagIds(typed.remove, "remove");
  if (add.length === 0 && remove.length === 0) {
    throw new ValidationError("add or remove must contain at least one tag id");
  }
  if (add.some((id) => remove.includes(id))) {
    throw new ValidationError("add and remove must not share tag ids");
  }
  return {
    selection: parseSelection(typed.selection, indexingEnabled, BULK_LIMITS.maxTagSelectionIds),
    add,
    remove,
  };
}

export function parseRemovalRequest(body: unknown, indexingEnabled: boolean): {
  selection: BookSelection;
  confirmNotes: boolean;
  dryRun: boolean;
} {
  if (!isRecord(body)) throw new ValidationError("Invalid deletion request");
  if (body.confirmNotes !== undefined && typeof body.confirmNotes !== "boolean") {
    throw new ValidationError("confirmNotes must be a boolean");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    throw new ValidationError("dryRun must be a boolean");
  }
  return {
    selection: parseSelection(body.selection, indexingEnabled, BULK_LIMITS.maxDeleteSelectionIds),
    confirmNotes: body.confirmNotes === true,
    dryRun: body.dryRun === true,
  };
}

export async function booksBulkRoutes(
  app: FastifyInstance,
  opts: { tags: Tags; removal: BookRemoval; indexingEnabled: boolean },
) {
  const { tags, removal, indexingEnabled } = opts;
  // The static route wins over /books/:id (Fastify prioritizes exact segments). There is
  // intentionally no GET /books/tags: tags are read from /api/tags.
  app.patch("/books/tags", async (req) => {
    const batch = parseTagPatch(req.body, indexingEnabled);
    return tags.apply(batch.selection, batch.add, batch.remove);
  });
  app.post("/books/delete", async (req) => {
    const request = parseRemovalRequest(req.body, indexingEnabled);
    return removal.remove(request.selection, {
      confirmNotes: request.confirmNotes,
      dryRun: request.dryRun,
    });
  });
}
