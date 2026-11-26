import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { updateApi } from "./updateApi";
import type { UpdateInfo } from "./updateTypes";
import { isDismissedVersion } from "./updateVersion";

/** Release version this browser chose not to see again. Local to the device. */
export const UPDATE_DISMISSED_KEY = "knowlify.update.dismissed";

/** Internal notification so the banner and the card never disagree after an action. */
const UPDATE_CHANGED_EVENT = "knowlify:update-changed";

export function publishUpdate(info: UpdateInfo) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<UpdateInfo>(UPDATE_CHANGED_EVENT, { detail: info }));
}

function subscribeUpdate(listener: (info: UpdateInfo) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<UpdateInfo>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(UPDATE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(UPDATE_CHANGED_EVENT, handler);
}

export function readDismissedVersion(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissVersion(version: string) {
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
    /* storage unavailable: the notice stays visible for this session */
  }
}

export type UpdateNotice = {
  info: UpdateInfo | null;
  visible: boolean;
  dismiss: () => void;
};

/**
 * One read of `/api/update` when the shell mounts; the server owns the network
 * schedule, so the web never polls. A missing route or a failed read renders
 * nothing.
 */
export function useUpdateNotice(api: ApiFn): UpdateNotice {
  const client = useMemo(() => updateApi(api), [api]);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissedVersion);

  useEffect(() => {
    let active = true;
    const apply = (next: UpdateInfo | null) => {
      if (active) setInfo(next);
    };
    client.get().then(apply, () => apply(null));
    const unsubscribe = subscribeUpdate((next) => setInfo(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const dismiss = useCallback(() => {
    const version = info?.latest?.version;
    if (!version) return;
    dismissVersion(version);
    setDismissed(version);
  }, [info]);

  const visible = Boolean(
    info &&
      info.enabled &&
      info.canManage &&
      info.available &&
      info.latest &&
      !isDismissedVersion(info.latest.version, dismissed),
  );

  return { info, visible, dismiss };
}
