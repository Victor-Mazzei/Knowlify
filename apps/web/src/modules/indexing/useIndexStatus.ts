import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { isCurrentSession, useSessionScope, type SessionScope } from "../../components/useSessionScope";
import { ApiError } from "../../services/api";
import type { IndexStatusResponse } from "./types";

/** The queue moves in seconds; polling only runs while there is work. */
export const INDEX_POLL_MS = 3000;

export type IndexStatusState = {
  status: IndexStatusResponse | null;
  /** False when the server predates the knowledge API (404). */
  available: boolean;
  refresh: () => Promise<IndexStatusResponse | null>;
};

type IndexRequest = {
  scope: SessionScope;
  controller: AbortController;
  promise: Promise<IndexStatusResponse | null>;
};

/**
 * Keeps the search-index status fresh: every 3 s while importing or queueing,
 * once on mount and on window focus when idle. An explicit `refresh` also wakes
 * the poller when its response reports queued work (for example, after upload).
 */
export function useIndexStatus(api: ApiFn, scanning: boolean, onRevision?: () => void | Promise<void>): IndexStatusState {
  const [status, setStatus] = useState<IndexStatusResponse | null>(null);
  const [available, setAvailable] = useState(true);
  const revision = useRef<number | null>(null);
  const scope = useSessionScope(api);
  const request = useRef<IndexRequest | null>(null);
  const availableRef = useRef(true);
  const revisionCallback = useRef(onRevision);
  revisionCallback.current = onRevision;

  const refresh = useCallback(() => {
    const controller = scope.controller;
    if (!scope.isActive()) return Promise.resolve(null);
    const inFlight = request.current;
    if (inFlight && inFlight.scope === scope && inFlight.controller === controller) return inFlight.promise;
    const promise = (async (): Promise<IndexStatusResponse | null> => {
      try {
        const next = (await (await api("/api/index/status", { signal: controller.signal })).json()) as IndexStatusResponse;
        // A reply from a previous credentials closure must not touch this session.
        if (!isCurrentSession(scope, controller)) return null;
        const previous = revision.current;
        revision.current = next.revision;
        availableRef.current = true;
        setAvailable(true);
        setStatus(next);
        if (previous !== null && previous !== next.revision) void revisionCallback.current?.();
        return next;
      } catch (error) {
        if (!isCurrentSession(scope, controller)) return null;
        if (error instanceof ApiError && error.status === 404) {
          availableRef.current = false;
          setAvailable(false);
          setStatus(null);
          return null;
        }
        throw error;
      }
    })();
    request.current = { scope, controller, promise };
    const clear = () => {
      if (request.current?.promise === promise) request.current = null;
    };
    void promise.then(clear, clear);
    return promise;
  }, [api, scope]);

  const refreshInBackground = useCallback(() => {
    // Polling is best effort: a failed request keeps the last known status on screen.
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    refreshInBackground();
  }, [refreshInBackground]);

  const busy = scanning || (status !== null && status.counts.pending + status.counts.indexing > 0);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(refreshInBackground, INDEX_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, refreshInBackground]);

  useEffect(() => {
    const onFocus = () => {
      if (!availableRef.current) return;
      refreshInBackground();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInBackground]);

  return { status, available, refresh };
}
