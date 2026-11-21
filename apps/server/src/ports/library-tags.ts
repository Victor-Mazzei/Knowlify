import type { Tag } from "../domain/library/Tag.js";
import type { BookFilters } from "./library-list.js";

export interface TagWithCount extends Tag {
  /** Books currently carrying the tag. */
  count: number;
}

/** A tag plus the canonical `name_key` the storage layer persists. */
export interface TagRecord extends Tag {
  nameKey: string;
}

/** Bulk requests accept an explicit id list or a filter the server re-counts. */
export type BookSelection =
  | { ids: string[] }
  | { filter: BookFilters; expectedTotal: number };

/** Ties every bulk endpoint to the same ceilings (ADR-7). */
export const BULK_LIMITS = {
  /** `selection.ids` on PATCH /books/tags. */
  maxTagSelectionIds: 200,
  /** `selection.ids` on POST /books/delete. */
  maxDeleteSelectionIds: 100,
  /** Books a single filter selection may cover. */
  maxFilterSelection: 20_000,
} as const;

export interface TagApplyResult {
  /** Number of book/tag links actually inserted. */
  added: number;
  /** Number of book/tag links actually deleted. */
  removed: number;
  /**
   * A book that would exceed `TAG_LIMITS.maxPerBook` after the operation. The caller throws
   * inside the surrounding transaction so nothing is kept.
   */
  overLimitBookId: string | null;
}

export interface TagRepository {
  list(): TagWithCount[];
  get(id: string): Tag | undefined;
  byIds(ids: string[]): Tag[];
  byNameKey(nameKey: string): Tag | undefined;
  count(): number;
  create(tag: TagRecord): void;
  update(tag: TagRecord): void;
  delete(id: string): boolean;
  /** Tag ids grouped by book; one query per 500 ids (no N+1). */
  forBooks(bookIds: string[]): Map<string, string[]>;
  /** Unions the tags of `fromBookId` into `toBookId`, then drops the source links. */
  reassign(fromBookId: string, toBookId: string): void;
  /** Applies add/remove for every book; the caller runs it inside one transaction. */
  apply(bookIds: string[], add: string[], remove: string[], now: number, maxPerBook: number): TagApplyResult;
}

export interface TagInput {
  name: string;
  color?: string;
}
