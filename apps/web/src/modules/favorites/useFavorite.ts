import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import { setBookFavorite } from "./favoritesApi";

export type FavoriteState = {
  favorite: boolean;
  /** A request is in flight; further toggles are ignored until it settles. */
  pending: boolean;
  /** Last failure, already formatted for the UI; cleared by the next toggle. */
  error: string;
  toggle: () => Promise<void>;
};

/**
 * Optimistic favorite toggle for one book. The UI flips immediately; a failed request
 * rolls back to the previous value and exposes the error. `initialFavorite` may arrive
 * later than the hook (the detail is still loading): it re-syncs while no request is in
 * flight, and a new `bookId` always resets the controller.
 */
export function useFavorite(api: ApiFn, bookId: string, initialFavorite: boolean): FavoriteState {
  const [favorite, setFavorite] = useState(initialFavorite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(initialFavorite);
  const pendingRef = useRef(false);
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    requestId.current += 1;
    current.current = initialFavorite;
    pendingRef.current = false;
    setFavorite(initialFavorite);
    setPending(false);
    setError("");
    // Only a different book resets the controller; `initialFavorite` is that book's value.
  }, [bookId]);

  useEffect(() => {
    if (pendingRef.current || current.current === initialFavorite) return;
    current.current = initialFavorite;
    setFavorite(initialFavorite);
  }, [initialFavorite]);

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    const previous = current.current;
    const next = !previous;
    const id = ++requestId.current;
    pendingRef.current = true;
    current.current = next;
    setPending(true);
    setError("");
    setFavorite(next);
    try {
      const saved = await setBookFavorite(api, bookId, next);
      if (!mounted.current || id !== requestId.current) return;
      current.current = saved;
      setFavorite(saved);
    } catch (caught) {
      if (!mounted.current || id !== requestId.current) return;
      current.current = previous;
      setFavorite(previous);
      setError(formatError(caught));
    } finally {
      if (mounted.current && id === requestId.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [api, bookId]);

  return { favorite, pending, error, toggle };
}
