/**
 * Favorite flag persistence (ADR-1). The flag is a column on `books`, so it dies with
 * the book; rescan does not rewrite it because the scanner UPSERT never sets it.
 */
export interface FavoriteRepository {
  /** Sets one book and returns false when the book does not exist. */
  set(bookId: string, favorite: boolean): boolean;
  /** Sets every existing id in one transaction and returns the number of rows changed. */
  setMany(bookIds: string[], favorite: boolean): number;
}
