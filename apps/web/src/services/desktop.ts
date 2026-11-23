/**
 * Desktop-only integration points used by the web UI.
 *
 * The web layer never touches the filesystem. Inside the Tauri shell it may
 * open the operating system's folder dialog so the local server can read the
 * chosen path. A remote server cannot see the client's disk, so the server's
 * folder picker is the only option there.
 */

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriGlobal = { core?: { invoke?: TauriInvoke } };

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export type FolderPick =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  /** Not the local desktop app, or the native dialog is unavailable or failed. */
  | { status: "unavailable" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True inside the Tauri webview; false in a normal browser and in tests. */
export function isDesktopShell(): boolean {
  return Boolean(window.__TAURI__);
}

function isLocalServer(): boolean {
  const base = window.__KNOWLIFY__?.apiBaseUrl;
  if (!base) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

/**
 * Opens the OS folder dialog when the desktop app is connected to its local
 * server. Callers fall back to the server-side picker on `unavailable`.
 *
 * `withGlobalTauri` exposes the core API but not the plugin's JS module, so the
 * dialog plugin is called through the command it registers. The payload is the
 * same one `@tauri-apps/plugin-dialog` sends: `{ options }`.
 */
export async function pickFolder(): Promise<FolderPick> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke || !isLocalServer()) return { status: "unavailable" };
  try {
    const selected = await invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "Choose a library folder" },
    });
    return typeof selected === "string" && selected.trim()
      ? { status: "selected", path: selected }
      : { status: "cancelled" };
  } catch {
    return { status: "unavailable" };
  }
}
