import { NotFoundError } from "../domain/errors.js";
import type {
  BookListReader,
  BookSelection,
  FavoriteRepository,
  UnitOfWork,
} from "../ports/index.js";
import { resolveSelection } from "./BulkSelection.js";

/** Ceilings for `PATCH /api/books/favorite` (same envelope as the tag batch). */
export const FAVORITE_LIMITS = {
  /** `ids` per request; the repository writes any selection in blocks of 100. */
  maxIds: 100,
  /** Books a single filter selection may cover. */
  maxFilter: 20_000,
} as const;

export interface FavoriteBatchResult {
  /** Books matched by the selection; setting an existing value still counts as matched. */
  updated: number;
}

/**
 * Favorite writes (ADR-1). A filter selection is re-counted inside the same transaction as
 * the update, so a set that changed after the client reviewed it is rejected with
 * `selection_changed`, exactly like the tag batch.
 */
export class Favorites {
  constructor(
    private readonly favorites: FavoriteRepository,
    private readonly books: Pick<BookListReader, "byIds" | "count" | "matchingIds">,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  /** Idempotent; throws 404 when the book does not exist. */
  setOne(bookId: string, favorite: boolean): boolean {
    if (!this.favorites.set(bookId, favorite)) throw new NotFoundError("Book not found");
    return favorite;
  }

  apply(selection: BookSelection, favorite: boolean): FavoriteBatchResult {
    return this.unitOfWork.run(() => {
      const resolved = resolveSelection(selection, this.books, {
        maxIds: FAVORITE_LIMITS.maxIds,
        maxFilter: FAVORITE_LIMITS.maxFilter,
      });
      return { updated: this.favorites.setMany(resolved.ids, favorite) };
    });
  }
}
