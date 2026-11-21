import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Source } from "../../types";

export type SourcesState = {
  sources: Source[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
};

/**
 * Reads the configured library folders once for the signed-in session. The shell
 * owns the request so opening Settings never inserts a half-loaded card.
 */
export function useSources(api: ApiFn, revision = 0): SourcesState {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const next = (await (await api("/api/sources")).json()) as Source[];
      if (current !== request.current) return;
      setSources(next);
      setError("");
    } catch (e) {
      if (current !== request.current) return;
      setError(formatError(e));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  return { sources, loading, error, refresh };
}
