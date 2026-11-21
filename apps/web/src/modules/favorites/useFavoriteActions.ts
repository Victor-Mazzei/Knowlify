import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Book } from "../../types";
import { setBookFavorite } from "./favoritesApi";

export type FavoriteActions = {
  /** Book ids whose favorite request is still in flight. */
  pendingIds: ReadonlySet<string>;
  toggleFavorite: (book: Book) => void;
};

/**
 * One-book favorite toggle for a list. The loaded row flips immediately and is
 * restored on failure; concurrent clicks on the same book are ignored. The caller
 * owns the list mutation and the facet refresh, so the same helper serves the grid
 * and the table without a second source of truth.
 */
export function useFavoriteActions({
  api,
  patchFavorites,
  onChanged,
  onError,
  refreshAfterChange = false,
  refresh,
}: {
  api: ApiFn;
  patchFavorites: (predicate: (book: Book) => boolean, favorite: boolean) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  /** Active `favorite=1` filter: a successful unfavorite changes the result set. */
  refreshAfterChange?: boolean;
  refresh?: () => Promise<void> | void;
}): FavoriteActions {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const latest = useRef({ onChanged, onError, refreshAfterChange, refresh });
  latest.current = { onChanged, onError, refreshAfterChange, refresh };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggleFavorite = useCallback(
    (book: Book) => {
      if (inFlight.current.has(book.id)) return;
      const previous = Boolean(book.favorite);
      const next = !previous;
      inFlight.current.add(book.id);
      setPendingIds(new Set(inFlight.current));
      patchFavorites((entry) => entry.id === book.id, next);

      void (async () => {
        try {
          const saved = await setBookFavorite(api, book.id, next);
          if (!mounted.current) return;
          patchFavorites((entry) => entry.id === book.id, saved);
          latest.current.onChanged();
          if (latest.current.refreshAfterChange) await latest.current.refresh?.();
        } catch (caught) {
          if (!mounted.current) return;
          patchFavorites((entry) => entry.id === book.id, previous);
          latest.current.onError(formatError(caught));
          latest.current.onChanged();
        } finally {
          inFlight.current.delete(book.id);
          if (mounted.current) setPendingIds(new Set(inFlight.current));
        }
      })();
    },
    [api, patchFavorites],
  );

  return { pendingIds, toggleFavorite };
}
