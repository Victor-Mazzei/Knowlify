import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import {
  DEFAULT_TAG_COLOR,
  MAX_TAG_IDS_PER_REQUEST,
  TAG_LIMITS,
  assertTagColor,
  normalizeTagName,
  tagKey,
  type Tag,
} from "../domain/library/Tag.js";
import type {
  BookListReader,
  BookSelection,
  Clock,
  IdGenerator,
  TagRepository,
  TagWithCount,
  UnitOfWork,
} from "../ports/index.js";
import { BULK_LIMITS } from "../ports/library-tags.js";
import { resolveSelection } from "./BulkSelection.js";

export interface TagUpdate {
  name?: string;
  color?: string;
}

export interface TagApplyResult {
  matched: number;
  added: number;
  removed: number;
}

export interface TagNamesResult {
  matched: number;
  added: number;
  createdTags: string[];
}

export interface TagRemovalResult {
  matched: number;
  removed: number;
}

const tagExists = (name: string, tags: TagRepository): boolean =>
  tags.byNameKey(tagKey(name)) !== undefined;

const uniqueIds = (ids: string[], label: string, max: number): string[] => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new ValidationError(`${label} cannot be empty`);
  if (unique.length > max) throw new ValidationError(`${label} accepts at most ${max} values`);
  return unique;
};

/**
 * Tag application rules (ADR-5/ADR-7). Every bulk call runs in one transaction, so a
 * concurrent tag deletion cannot leave half of the books tagged, and a per-book limit
 * violation rolls back the whole batch.
 */
export class Tags {
  constructor(
    private readonly tags: TagRepository,
    private readonly books: Pick<BookListReader, "byIds" | "count" | "matchingIds">,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(): TagWithCount[] {
    return this.tags.list();
  }

  create(input: { name: unknown; color?: unknown }): Tag {
    const name = normalizeTagName(input.name);
    const color = assertTagColor(input.color);
    return this.unitOfWork.run(() => {
      if (tagExists(name, this.tags)) throw new ConflictError("A tag with this name already exists", "tag_name_taken");
      if (this.tags.count() >= TAG_LIMITS.maxTags) {
        throw new ConflictError(`At most ${TAG_LIMITS.maxTags} tags are allowed`, "tag_limit_reached");
      }
      const tag: Tag & { nameKey: string } = {
        id: this.ids.next(),
        name,
        nameKey: tagKey(name),
        color,
        createdAt: this.clock.now(),
      };
      this.tags.create(tag);
      return { id: tag.id, name: tag.name, color: tag.color, createdAt: tag.createdAt };
    });
  }

  update(id: string, patch: TagUpdate): Tag {
    if (patch.name === undefined && patch.color === undefined) {
      throw new ValidationError("At least one of name or color is required");
    }
    const name = patch.name === undefined ? undefined : normalizeTagName(patch.name);
    const color = patch.color === undefined ? undefined : assertTagColor(patch.color);
    return this.unitOfWork.run(() => {
      const current = this.tags.get(id);
      if (!current) throw new NotFoundError("Tag not found");
      const nameKey = name === undefined ? undefined : tagKey(name);
      if (nameKey !== undefined) {
        const owner = this.tags.byNameKey(nameKey);
        // Renaming only the case of the same tag is allowed: the owner is itself.
        if (owner && owner.id !== id) throw new ConflictError("A tag with this name already exists", "tag_name_taken");
      }
      const updated = {
        ...current,
        name: name ?? current.name,
        color: color ?? current.color,
      };
      this.tags.update({ ...updated, nameKey: nameKey ?? tagKey(current.name) });
      return updated;
    });
  }

  remove(id: string): void {
    if (!this.tags.delete(id)) throw new NotFoundError("Tag not found");
  }

  /**
   * MCP bulk write: accepts tag names or ids, resolves existing tags and creates the
   * missing names with the default color. Runs in one transaction, so a limit violation
   * or a missing book leaves neither links nor newly created tags behind.
   */
  addByNames(bookIds: string[], values: string[]): TagNamesResult {
    const books = uniqueIds(bookIds, "bookIds", BULK_LIMITS.maxTagSelectionIds);
    const names = uniqueIds(values, "tags", MAX_TAG_IDS_PER_REQUEST);
    return this.unitOfWork.run(() => {
      const resolved = resolveSelection({ ids: books }, this.books, {
        maxIds: BULK_LIMITS.maxTagSelectionIds,
        maxFilter: BULK_LIMITS.maxFilterSelection,
      });
      if (resolved.missing > 0) throw new NotFoundError("Book not found", "book_not_found");
      const tagIds: string[] = [];
      const createdTags: string[] = [];
      const seen = new Set<string>();
      for (const value of names) {
        const existing = this.tags.byIds([value])[0] ?? this.tags.byNameKey(tagKey(value));
        if (existing) {
          if (!seen.has(existing.id)) {
            seen.add(existing.id);
            tagIds.push(existing.id);
          }
          continue;
        }
        if (this.tags.count() >= TAG_LIMITS.maxTags) {
          throw new ConflictError(`At most ${TAG_LIMITS.maxTags} tags are allowed`, "tag_limit_reached");
        }
        const name = normalizeTagName(value);
        const tag: Tag & { nameKey: string } = {
          id: this.ids.next(),
          name,
          nameKey: tagKey(name),
          color: DEFAULT_TAG_COLOR,
          createdAt: this.clock.now(),
        };
        this.tags.create(tag);
        createdTags.push(name);
        if (!seen.has(tag.id)) {
          seen.add(tag.id);
          tagIds.push(tag.id);
        }
      }
      const result = this.tags.apply(resolved.ids, tagIds, [], this.clock.now(), TAG_LIMITS.maxPerBook);
      if (result.overLimitBookId) {
        throw new ConflictError(`A book can have at most ${TAG_LIMITS.maxPerBook} tags`, "book_tag_limit", {
          bookId: result.overLimitBookId,
        });
      }
      return { matched: resolved.ids.length, added: result.added, createdTags };
    });
  }

  /** MCP bulk write: removes only existing tags; an unknown name aborts the whole batch. */
  removeByNames(bookIds: string[], values: string[]): TagRemovalResult {
    const books = uniqueIds(bookIds, "bookIds", BULK_LIMITS.maxTagSelectionIds);
    const names = uniqueIds(values, "tags", MAX_TAG_IDS_PER_REQUEST);
    return this.unitOfWork.run(() => {
      const resolved = resolveSelection({ ids: books }, this.books, {
        maxIds: BULK_LIMITS.maxTagSelectionIds,
        maxFilter: BULK_LIMITS.maxFilterSelection,
      });
      if (resolved.missing > 0) throw new NotFoundError("Book not found", "book_not_found");
      const tagIds = [...new Set(names.map((value) => {
        const tag = this.tags.byIds([value])[0] ?? this.tags.byNameKey(tagKey(value));
        if (!tag) throw new NotFoundError("Tag not found", "tag_not_found");
        return tag.id;
      }))];
      const result = this.tags.apply(resolved.ids, [], tagIds, this.clock.now(), TAG_LIMITS.maxPerBook);
      return { matched: resolved.ids.length, removed: result.removed };
    });
  }

  apply(selection: BookSelection, add: string[], remove: string[]): TagApplyResult {
    if (add.length === 0 && remove.length === 0) {
      throw new ValidationError("add or remove must contain at least one tag id");
    }
    if (add.length > MAX_TAG_IDS_PER_REQUEST || remove.length > MAX_TAG_IDS_PER_REQUEST) {
      throw new ValidationError(`add and remove accept at most ${MAX_TAG_IDS_PER_REQUEST} tag ids`);
    }
    const overlap = add.find((id) => remove.includes(id));
    if (overlap !== undefined) throw new ValidationError("add and remove must not share tag ids");
    return this.unitOfWork.run(() => {
      const resolved = resolveSelection(selection, this.books, {
        maxIds: BULK_LIMITS.maxTagSelectionIds,
        maxFilter: BULK_LIMITS.maxFilterSelection,
      });
      // Checked inside the transaction: a concurrent DELETE /tags/:id either is seen here
      // (404, nothing applied) or happens after this commit (the link cascades away).
      if (add.length > 0 && this.tags.byIds(add).length !== add.length) {
        throw new NotFoundError("Tag not found", "tag_not_found");
      }
      const result = this.tags.apply(resolved.ids, add, remove, this.clock.now(), TAG_LIMITS.maxPerBook);
      if (result.overLimitBookId) {
        throw new ConflictError(`A book can have at most ${TAG_LIMITS.maxPerBook} tags`, "book_tag_limit", {
          bookId: result.overLimitBookId,
        });
      }
      return { matched: resolved.ids.length, added: result.added, removed: result.removed };
    });
  }
}
