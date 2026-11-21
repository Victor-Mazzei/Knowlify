import { useCallback, useEffect, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";

export type IndexPauseState = {
  /** Optimistic value: flips before the request resolves and rolls back on failure. */
  paused: boolean;
  pending: boolean;
  error: string;
  toggle: () => Promise<void>;
};

/**
 * Shared pause/resume control. The server persists the flag, so the value is
 * only optimistic until the next status refresh confirms it.
 */
export function useIndexPause(
  api: ApiFn,
  serverPaused: boolean | undefined,
  refresh: () => Promise<unknown>,
): IndexPauseState {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const base = serverPaused ?? false;
  const paused = optimistic ?? base;

  useEffect(() => {
    if (!pending && optimistic !== null && optimistic === base) setOptimistic(null);
  }, [base, optimistic, pending]);

  const toggle = useCallback(async () => {
    if (pending) return;
    const wasPaused = paused;
    const next = !wasPaused;
    setOptimistic(next);
    setPending(true);
    setError("");
    try {
      const response = await api(next ? "/api/index/pause" : "/api/index/resume", { method: "POST" });
      let confirmed = next;
      try {
        const body: unknown = await response.json();
        if (typeof body === "object" && body !== null && "paused" in body && typeof body.paused === "boolean") {
          confirmed = body.paused;
        }
      } catch {
        // A response without a JSON body is unusual but the request itself succeeded.
      }
      setOptimistic(confirmed);
      await refresh().catch(() => undefined);
    } catch (cause) {
      setOptimistic(wasPaused);
      setError(formatError(cause));
    } finally {
      setPending(false);
    }
  }, [api, paused, pending, refresh]);

  return { paused, pending, error, toggle };
}
