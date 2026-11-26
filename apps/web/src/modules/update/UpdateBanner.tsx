import type { ApiFn } from "../../components/dialogs";
import { isDesktopShell } from "../../services/desktop";
import { releaseUrl } from "./linkPolicy";
import { useUpdateNotice } from "./useUpdateNotice";
import "./update.css";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Same set of servers that show the Network section: the desktop's own sidecar. */
function isLocalDesktop(): boolean {
  if (!isDesktopShell()) return false;
  const base = window.__KNOWLIFY__?.apiBaseUrl;
  if (!base) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

function contextCopy(): string {
  return isLocalDesktop()
    ? "Download the new installer from the release page."
    : "Update your server. If you use Docker, pull the new image.";
}

function openExternal(url: string) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  // The desktop bridge validates the scheme and opens the default browser.
  void invoke("open_external", { url }).catch(() => {});
}

/**
 * Quiet strip under the header. It is a status, not an alert: no modal, no
 * focus change and no animation. It never renders inside the full-screen
 * reader, which lives outside the shell's route tree.
 */
export function UpdateBanner({ api }: { api: ApiFn }) {
  const { info, visible, dismiss } = useUpdateNotice(api);
  if (!info || !info.latest || !visible) return null;

  const url = releaseUrl(info.latest.url);
  const desktop = isDesktopShell();

  return (
    <div className="update-banner" role="status">
      <p className="update-banner-copy">
        <strong>Knowlify {info.latest.version} is available.</strong> You have {info.current}.{" "}
        {contextCopy()}
      </p>
      <div className="update-banner-actions">
        {url &&
          (desktop ? (
            <button type="button" className="update-banner-link" onClick={() => openExternal(url)}>
              View release
            </button>
          ) : (
            <a
              className="update-banner-link"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View release
            </a>
          ))}
        <button type="button" className="ghost" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
