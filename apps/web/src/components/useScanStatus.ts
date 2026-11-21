import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "./dialogs";
import { isCurrentSession, useSessionScope } from "./useSessionScope";
import type { ScanStatus } from "../types";

const POLL_INTERVAL_MS = 3000;
/** Retry delays after consecutive failures: 3 s, 6 s, 12 s, then 30 s. */
const RETRY_DELAYS_MS = [3000, 6000, 12000, 30000] as const;
const FAILURES_BEFORE_WARNING = 3;

export function useScanStatus(
  api: ApiFn,
  onLibraryChange?: () => void | Promise<void>,
  onSourcesChange?: () => void,
) {
  const [status, setStatus] = useState<ScanStatus>({ scanning: false, pending: 0, lastScanAt: null });
  /** True after repeated polling failures, until the server answers again. */
  const [error, setError] = useState(false);
  const scope = useSessionScope(api);
  const statusRef = useRef(status);
  const changeRef = useRef(onLibraryChange);
  changeRef.current = onLibraryChange;
  const sourcesChangeRef = useRef(onSourcesChange);
  sourcesChangeRef.current = onSourcesChange;
  const wakeRef = useRef<() => void>(() => undefined);
  const failuresRef = useRef(0);

  const refresh = useCallback(async () => {
    const controller = scope.controller;
    const next: ScanStatus = await (await api("/api/scan", { signal: controller.signal })).json();
    // A reply from a previous credentials closure must not touch this session.
    if (!isCurrentSession(scope, controller)) return next;
    failuresRef.current = 0;
    setError(false);
    const previous = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if ((previous.scanning || previous.pending > 0) && !next.scanning && next.pending === 0) {
      void changeRef.current?.();
      sourcesChangeRef.current?.();
    }
    return next;
  }, [api, scope]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | undefined;
    let inFlight = false;
    const schedule = (delay: number) => {
      if (!cancelled) timeout = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      timeout = undefined;
      try {
        const next = await refresh();
        if (!cancelled && (next.scanning || next.pending > 0)) schedule(POLL_INTERVAL_MS);
      } catch {
        // A transient failure (network drop or server restart) must not freeze the header; retry
        // with backoff and tell the user once the outage stops looking transient.
        if (cancelled) return;
        failuresRef.current += 1;
        if (failuresRef.current >= FAILURES_BEFORE_WARNING) setError(true);
        const delay = RETRY_DELAYS_MS[Math.min(failuresRef.current, RETRY_DELAYS_MS.length) - 1];
        schedule(delay);
      } finally {
        inFlight = false;
      }
    };
    wakeRef.current = () => {
      if (!cancelled && !timeout && !inFlight) void poll();
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout) window.clearTimeout(timeout);
      wakeRef.current = () => undefined;
    };
  }, [refresh]);

  const rescan = useCallback(async () => {
    const controller = scope.controller;
    const next: ScanStatus = await (await api("/api/scan", { method: "POST", signal: controller.signal })).json();
    if (!isCurrentSession(scope, controller)) return;
    statusRef.current = next;
    setStatus(next);
    wakeRef.current();
    await changeRef.current?.();
  }, [api, scope]);

  const wake = useCallback(() => wakeRef.current(), []);

  return { status, error, refresh, rescan, wake };
}
