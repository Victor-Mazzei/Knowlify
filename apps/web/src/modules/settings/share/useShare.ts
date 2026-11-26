import { useCallback, useEffect, useRef, useState } from "react";
import { hasDesktopInvoke, reconnectApp, ShareCommandError, shareApi, type ShareStatus } from "./shareApi";

export type SharePending = "start" | "stop" | "port" | "rotate" | "refresh" | null;

export type ShareActionError = { code?: string; message: string };

export type ShareController = {
  loading: boolean;
  status: ShareStatus | null;
  pending: SharePending;
  actionError: ShareActionError | null;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean, port?: number) => Promise<boolean>;
  rotatePassword: () => Promise<boolean>;
};

const toActionError = (reason: unknown): ShareActionError => ({
  code: reason instanceof ShareCommandError ? reason.code : undefined,
  message:
    reason instanceof Error && reason.message ? reason.message : "Something went wrong. Please try again.",
});

/**
 * State for the share card. Every `set_share` restarts the sidecar, so a
 * successful command reconnects the webview through the desktop bootstrap.
 */
export function useShare(): ShareController {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<SharePending>(null);
  const [actionError, setActionError] = useState<ShareActionError | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((next: ShareStatus) => {
    const visible = next.available && next.error?.code !== "not_local";
    setStatus(visible ? next : null);
    return visible;
  }, []);

  useEffect(() => {
    if (!hasDesktopInvoke()) {
      setLoading(false);
      return;
    }
    const request = ++requestId.current;
    void shareApi
      .status()
      .then((next) => {
        if (!mounted.current || request !== requestId.current) return;
        apply(next);
        setLoading(false);
      })
      .catch(() => {
        if (!mounted.current || request !== requestId.current) return;
        setStatus(null);
        setLoading(false);
      });
    return () => {
      requestId.current += 1;
    };
  }, [apply]);

  const refresh = useCallback(async () => {
    if (!hasDesktopInvoke()) return;
    const request = ++requestId.current;
    setPending("refresh");
    setActionError(null);
    try {
      const next = await shareApi.status();
      if (!mounted.current || request !== requestId.current) return;
      apply(next);
    } catch (reason) {
      if (!mounted.current || request !== requestId.current) return;
      setActionError(toActionError(reason));
    } finally {
      if (mounted.current && request === requestId.current) setPending(null);
    }
  }, [apply]);

  const run = useCallback(
    async (action: Exclude<SharePending, "refresh" | null>, command: () => Promise<ShareStatus>) => {
      setPending(action);
      setActionError(null);
      try {
        const next = await command();
        if (!mounted.current) return false;
        const visible = apply(next);
        if (visible) reconnectApp();
        return visible;
      } catch (reason) {
        if (!mounted.current) return false;
        const error = toActionError(reason);
        if (error.code === "not_local") setStatus(null);
        else setActionError(error);
        return false;
      } finally {
        if (mounted.current) setPending(null);
      }
    },
    [apply],
  );

  const setEnabled = useCallback(
    (enabled: boolean, port?: number) => {
      const action = enabled ? (port === undefined ? "start" : "port") : "stop";
      return run(action, () => shareApi.setShare(enabled, port));
    },
    [run],
  );

  const rotatePassword = useCallback(() => run("rotate", () => shareApi.rotatePassword()), [run]);

  return { loading, status, pending, actionError, refresh, setEnabled, rotatePassword };
}

/**
 * Whether the Settings menu should list the Network section: only the desktop
 * shell in local mode answers `share_status` with `available`.
 */
export function useShareAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!hasDesktopInvoke()) return;
    let active = true;
    void shareApi
      .status()
      .then((next) => {
        if (active) setAvailable(next.available && next.error?.code !== "not_local");
      })
      .catch(() => {
        // No sidecar: keep the section hidden.
      });
    return () => {
      active = false;
    };
  }, []);
  return available;
}
