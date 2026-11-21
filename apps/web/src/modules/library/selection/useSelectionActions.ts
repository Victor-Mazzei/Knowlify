import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../../components/dialogs";
import type { Book, BookSelection, BookSelectionFilter, DeleteResult } from "../../../types";
import { favoriteErrorMessage, setBookFavorites } from "../../favorites/favoritesApi";
import { applyTags } from "../../tags/tagsApi";
import type { DeleteProgress } from "../deleteBooksApi";
import { toBookSelection, useSelection, type Selection } from "./useSelection";

export type SelectionActions = {
  selection: Selection;
  tagOpen: boolean;
  setTagOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  deleteTarget: BookSelection | null;
  setDeleteTarget: (selection: BookSelection | null) => void;
  toggleBook: (book: Book, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  toggleAllLoaded: () => void;
  selectAllResults: () => void;
  requestDelete: () => void;
  requestDeleteBook: (book: Book) => void;
  applyTagChange: (add: string[], remove: string[]) => Promise<void>;
  /** Favorite/unfavorite the whole selection; a 409 keeps it for review. */
  applyFavoriteChange: (favorite: boolean) => Promise<void>;
  favoriteBusy: boolean;
  /** Drops already-committed ids and keeps only the remainder selected. */
  applyDeleteProgress: (progress: DeleteProgress) => void;
  /** Closes the dialog, clears the selection and reports the outcome. */
  completeDelete: (result: DeleteResult, target: BookSelection) => Promise<void>;
};

export function deletedMessage(result: DeleteResult): string {
  const parts = [result.removed === 1 ? "Book deleted." : `Removed ${result.removed} books.`];
  if (result.ignored > 0) {
    parts.push(
      `${result.ignored} folder ${result.ignored === 1 ? "book" : "books"} will not be re-imported; restore from Settings → Ignored books.`,
    );
  }
  if (result.fileErrors > 0) {
    parts.push(`${result.fileErrors} uploaded ${result.fileErrors === 1 ? "file" : "files"} could not be removed.`);
  }
  if (result.remaining > 0) {
    parts.push(`${result.remaining} books remain; delete again to continue.`);
  }
  return parts.join(" ");
}

/**
 * Selection state plus every action that leaves the list: scope invalidation,
 * tag batches, the delete confirmation and the keyboard shortcuts. The page
 * keeps rendering and notices; this hook owns the interaction rules.
 */
export function useSelectionActions({
  api,
  books,
  total,
  scope,
  selectable,
  filterSelection,
  patchTagIds,
  patchFavorites,
  onRemoveBooks,
  onInvalidateFacets,
  onRefresh,
  onNotice,
  onError,
  refreshAfterFavorite = false,
}: {
  api: ApiFn;
  books: Book[];
  total: number;
  /** Filters and search term; a change invalidates the selected ids. */
  scope: string;
  selectable: boolean;
  filterSelection: BookSelectionFilter;
  patchTagIds: (predicate: (book: Book) => boolean, add: string[], remove: string[]) => void;
  patchFavorites: (predicate: (book: Book) => boolean, favorite: boolean) => void;
  /** Drops rows already deleted by a partial bulk operation. */
  onRemoveBooks: (ids: string[]) => void;
  onInvalidateFacets: () => void;
  onRefresh: () => Promise<void> | void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** Active `favorite=1` filter: the result set changes after a successful batch. */
  refreshAfterFavorite?: boolean;
}): SelectionActions {
  const selection = useSelection();
  const [tagOpen, setTagOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BookSelection | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const favoriteBusyRef = useRef(false);
  const scopeRef = useRef(scope);

  useEffect(() => {
    if (scope === scopeRef.current) return;
    scopeRef.current = scope;
    if (selection.count === 0) return;
    selection.clear();
    onNotice("Selection cleared.");
  }, [scope, selection, onNotice]);

  useEffect(() => {
    if (selectable) return;
    if (selection.count > 0) selection.clear();
  }, [selectable, selection]);

  useEffect(() => {
    if (tagOpen && selection.count === 0) setTagOpen(false);
  }, [selection.count, tagOpen]);

  const toggleBook = useCallback(
    (book: Book, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
      selection.toggle(
        book.id,
        { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey },
        books.map((entry) => entry.id),
      );
    },
    [books, selection],
  );

  const toggleAllLoaded = useCallback(() => {
    selection.toggleLoaded(books.map((book) => book.id), scope, total);
  }, [books, scope, selection, total]);

  const selectAllResults = useCallback(() => selection.selectAllResults(scope, total), [scope, selection, total]);

  const requestDelete = useCallback(() => {
    if (selection.count === 0) return;
    const target = toBookSelection(selection, filterSelection);
    if (target) setDeleteTarget(target);
  }, [filterSelection, selection]);

  const requestDeleteBook = useCallback(
    (book: Book) => {
      if (selectable) setDeleteTarget({ ids: [book.id] });
    },
    [selectable],
  );

  const applyDeleteProgress = useCallback(
    ({ removedIds, remaining }: DeleteProgress) => {
      if (removedIds !== undefined && removedIds.length > 0) onRemoveBooks(removedIds);
      if (remaining === null) selection.clear();
      else if ("ids" in remaining) selection.replace(remaining.ids);
      else selection.selectAllResults(scope, remaining.expectedTotal);
      onInvalidateFacets();
      // A filtered remainder, or an exhausted id selection, needs the fresh total;
      // explicit ids that remain are already reflected by the row removal.
      if (remaining === null || "filter" in remaining) void onRefresh();
    },
    [onInvalidateFacets, onRefresh, onRemoveBooks, scope, selection],
  );

  const completeDelete = useCallback(
    async (result: DeleteResult, target: BookSelection) => {
      setDeleteTarget(null);
      setTagOpen(false);
      if ("ids" in target) onRemoveBooks(target.ids);
      selection.clear();
      onInvalidateFacets();
      onNotice(deletedMessage(result));
      // A partial run reports more removals than the remainder, so reload the page
      // and its total; a plain id deletion is already reflected by the rows.
      if (!("ids" in target) || result.removed !== target.ids.length) await onRefresh();
    },
    [onInvalidateFacets, onNotice, onRefresh, onRemoveBooks, selection],
  );

  const applyTagChange = useCallback(
    async (add: string[], remove: string[]) => {
      const payload = toBookSelection(selection, filterSelection);
      if (!payload) return;
      // Optimistic on the loaded rows; a failed request refreshes from the server.
      patchTagIds((book) => selection.isSelected(book.id), add, remove);
      try {
        const result = await applyTags(api, {
          selection: payload,
          ...(add.length ? { add } : {}),
          ...(remove.length ? { remove } : {}),
        });
        const changed = result.added + result.removed;
        onNotice(
          `Tags updated on ${result.matched} ${result.matched === 1 ? "book" : "books"}${changed ? "" : " (no change)"}.`,
        );
        onInvalidateFacets();
        if (selection.all) await onRefresh();
      } catch (e) {
        onInvalidateFacets();
        await onRefresh();
        throw e;
      }
    },
    [api, filterSelection, onInvalidateFacets, onNotice, onRefresh, patchTagIds, selection],
  );

  const applyFavoriteChange = useCallback(
    async (favorite: boolean) => {
      if (favoriteBusyRef.current) return;
      const payload = toBookSelection(selection, filterSelection);
      if (!payload) return;
      const previous = new Map(
        books.filter((book) => selection.isSelected(book.id)).map((book) => [book.id, Boolean(book.favorite)]),
      );
      favoriteBusyRef.current = true;
      setFavoriteBusy(true);
      onError("");
      // Optimistic on the loaded rows; a failed request restores each row and reloads.
      patchFavorites((book) => selection.isSelected(book.id), favorite);
      try {
        const updated = await setBookFavorites(api, payload, favorite);
        onNotice(
          updated === 0
            ? "No books changed."
            : `${favorite ? "Added" : "Removed"} ${updated} ${updated === 1 ? "book" : "books"} ${
                favorite ? "to" : "from"
              } favorites.`,
        );
        onInvalidateFacets();
        if (selection.all || refreshAfterFavorite) await onRefresh();
      } catch (e) {
        for (const [id, value] of previous) patchFavorites((book) => book.id === id, value);
        onInvalidateFacets();
        await onRefresh();
        onError(favoriteErrorMessage(e));
      } finally {
        favoriteBusyRef.current = false;
        setFavoriteBusy(false);
      }
    },
    [
      api,
      books,
      filterSelection,
      onError,
      onInvalidateFacets,
      onNotice,
      onRefresh,
      patchFavorites,
      refreshAfterFavorite,
      selection,
    ],
  );

  useEffect(() => {
    if (!selectable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Escape" && selection.count > 0) {
        selection.clear();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "a") {
        event.preventDefault();
        toggleAllLoaded();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selection.count > 0) {
        event.preventDefault();
        requestDelete();
      }
      if (event.key.toLocaleLowerCase() === "t" && selection.count > 0) {
        event.preventDefault();
        setTagOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return {
    selection,
    tagOpen,
    setTagOpen,
    deleteTarget,
    setDeleteTarget,
    toggleBook,
    toggleAllLoaded,
    selectAllResults,
    requestDelete,
    requestDeleteBook,
    applyTagChange,
    applyFavoriteChange,
    favoriteBusy,
    applyDeleteProgress,
    completeDelete,
  };
}
