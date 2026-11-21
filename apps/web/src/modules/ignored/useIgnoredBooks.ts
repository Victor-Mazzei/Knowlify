import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { IgnoredBook } from "../../types";
import { listIgnored, restoreIgnored } from "./ignoredApi";

export type IgnoredBooksState = {
  items: IgnoredBook[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  /** The server predates the ignored-books contract. */
  unavailable: boolean;
  reload: () => void;
  loadMore: () => void;
  restore: (id: string) => Promise<{ restored: number; scanStarted: boolean }>;
};

export function useIgnoredBooks(api: ApiFn): IgnoredBooksState {
  const [items, setItems] = useState<IgnoredBook[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const page = await listIgnored((path, init) => api(path, { ...init, signal: controller.signal }), 0);
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        setError("");
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && "status" in e && (e as { status?: unknown }).status === 404) {
          setUnavailable(true);
        } else {
          setError(formatError(e));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [api, token]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await listIgnored(api, items.length);
        setItems((current) => [...current, ...page.items.filter((entry) => !current.some((item) => item.id === entry.id))]);
        setTotal(page.total);
      } catch (e) {
        setError(formatError(e));
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [api, items.length, loadingMore]);

  const restore = useCallback(
    async (id: string) => {
      const result = await restoreIgnored(api, [id]);
      setItems((current) => current.filter((entry) => entry.id !== id));
      setTotal((current) => Math.max(0, current - result.restored));
      return result;
    },
    [api],
  );

  return useMemo(
    () => ({ items, total, loading, loadingMore, error, unavailable, reload, loadMore, restore }),
    [error, items, loadMore, loading, loadingMore, reload, restore, total, unavailable],
  );
}
