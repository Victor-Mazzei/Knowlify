/**
 * Desktop IPC for "Share on my network".
 *
 * The browser build never mounts the card, so these commands only run inside
 * the Tauri webview. The contract is frozen in the desktop LAN sharing plan:
 * `share_status`, `set_share(enabled, port)` and `rotate_share_password`.
 * No password is logged or kept after the component unmounts.
 */

export type ShareErrorCode = "port_in_use" | "no_network" | "start_failed" | "not_local";

export type ShareStatusError = { code: ShareErrorCode; message: string };

export type ShareStatus = {
  /** Local desktop mode with a running sidecar. */
  available: boolean;
  /** Persisted intent. */
  enabled: boolean;
  /** The sidecar is listening on all interfaces. */
  running: boolean;
  port: number;
  defaultPort: number;
  urls: string[];
  user: string;
  /** Share password; only present while sharing is enabled. */
  password: string | null;
  error: ShareStatusError | null;
};

declare global {
  interface Window {
    /** Set by the desktop bootstrap after a share command restarts the sidecar. */
    __KNOWLIFY_RECONNECT__?: () => void;
  }
}

const ERROR_CODES: readonly ShareErrorCode[] = ["port_in_use", "no_network", "start_failed", "not_local"];

export class ShareCommandError extends Error {
  constructor(
    message: string,
    public readonly code?: ShareErrorCode,
  ) {
    super(message);
    this.name = "ShareCommandError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;

const isErrorCode = (value: unknown): value is ShareErrorCode =>
  typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);

const isStatusError = (value: unknown): value is ShareStatusError =>
  isRecord(value) && isErrorCode(value.code) && typeof value.message === "string";

/** Narrowing guard for the frozen `ShareStatus` payload. */
export function isShareStatus(value: unknown): value is ShareStatus {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    typeof value.enabled === "boolean" &&
    typeof value.running === "boolean" &&
    isPort(value.port) &&
    isPort(value.defaultPort) &&
    Array.isArray(value.urls) &&
    value.urls.every((url) => typeof url === "string") &&
    typeof value.user === "string" &&
    (value.password === null || typeof value.password === "string") &&
    (value.error === null || isStatusError(value.error))
  );
}

/** True inside the Tauri webview, where the share commands exist. */
export function hasDesktopInvoke(): boolean {
  return typeof window.__TAURI__?.core?.invoke === "function";
}

function toCommandError(reason: unknown): ShareCommandError {
  if (isRecord(reason)) {
    const message = typeof reason.message === "string" ? reason.message : "";
    const code = isErrorCode(reason.code)
      ? reason.code
      : ERROR_CODES.find((candidate) => message.includes(candidate));
    if (code || message) return new ShareCommandError(message || "The desktop app rejected the request.", code);
  }
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const code = ERROR_CODES.find((candidate) => raw === candidate || raw.includes(candidate));
  return new ShareCommandError(raw || "The desktop app rejected the request.", code);
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const call = window.__TAURI__?.core?.invoke;
  if (!call) throw new ShareCommandError("Sharing is available only in the desktop app.", "not_local");
  try {
    return await call(command, args);
  } catch (reason) {
    throw toCommandError(reason);
  }
}

function expectStatus(value: unknown): ShareStatus {
  if (!isShareStatus(value)) {
    throw new ShareCommandError("The desktop app returned an unexpected share status.");
  }
  return value;
}

export const shareApi = {
  async status(): Promise<ShareStatus> {
    return expectStatus(await invoke("share_status"));
  },
  async setShare(enabled: boolean, port?: number): Promise<ShareStatus> {
    const args: Record<string, unknown> = { enabled };
    if (port !== undefined) args.port = port;
    return expectStatus(await invoke("set_share", args));
  },
  async rotatePassword(): Promise<ShareStatus> {
    return expectStatus(await invoke("rotate_share_password"));
  },
};

/**
 * The sidecar restarted, so the session points at a dead address. The desktop
 * bootstrap replaces the page and reconnects from `connection.json`; in tests
 * and the browser build the helper does not exist.
 */
export function reconnectApp(): void {
  try {
    window.__KNOWLIFY_RECONNECT__?.();
  } catch {
    // A failed reload leaves the old session; the next navigation retries.
  }
}
