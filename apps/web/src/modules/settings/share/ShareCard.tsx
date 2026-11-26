import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useConfirm } from "../../../components/dialogs";
import { formatSharePassword, pairingUrl } from "./pairing";
import { QrCode } from "./QrCode";
import { useShare, type ShareActionError, type SharePending } from "./useShare";
import type { ShareStatus } from "./shareApi";
import "./share.css";

const WARNING =
  "Anyone on this network who has the password can read and change your library. Traffic is not encrypted (HTTP). " +
  "Use only on networks you trust, never on public Wi-Fi. Works while Knowlify is open on this computer.";

const PORT_MIN = 1024;
const PORT_MAX = 65535;

const PENDING_LABEL: Record<Exclude<SharePending, null>, string> = {
  start: "Starting",
  stop: "Stopping",
  port: "Starting",
  rotate: "Rotating",
  refresh: "Checking",
};

const PENDING_TEXT: Record<Exclude<SharePending, null>, string> = {
  start: "Starting the local server…",
  stop: "Stopping sharing…",
  port: "Restarting the local server…",
  rotate: "Regenerating the password…",
  refresh: "Checking the network…",
};

/** Clipboard with the legacy fallback: `navigator.clipboard` is absent on plain HTTP. */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Denied permission or an insecure context falls through to the legacy path.
  }
  const input = document.createElement("input");
  input.value = value;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  try {
    input.select();
    if (typeof document.execCommand !== "function") return false;
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
  }
}

const COPY_FAILED = "Copy failed. Select the text and copy it.";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    const copied = await copyText(value);
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!copied) {
      setStatus("failed");
      return;
    }
    setStatus("copied");
    timer.current = window.setTimeout(() => {
      setStatus("idle");
      timer.current = null;
    }, 1500);
  }

  return (
    <div className="share-copy-wrap">
      <button
        type="button"
        className="ghost bordered share-copy"
        onClick={() => void copy()}
        aria-label={status === "copied" ? "Copied" : label}
      >
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      <span className={status === "failed" ? "share-copy-error" : "visually-hidden"} role="status">
        {status === "failed" ? COPY_FAILED : status === "copied" ? "Copied" : ""}
      </span>
    </div>
  );
}

function ShareValue({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return (
    <div className="copy-field share-field">
      <span className="copy-label">{label}</span>
      <code>{value}</code>
      <CopyButton value={value} label={copyLabel} />
    </div>
  );
}

function PasswordField({ password }: { password: string }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <div className="copy-field share-field">
      <span className="copy-label">Password</span>
      <code id={`${id}-value`} className="share-password-value" aria-live="polite">
        {visible ? formatSharePassword(password) : "••••-••••-••••-••••"}
      </code>
      <button
        type="button"
        className="ghost bordered share-reveal"
        aria-pressed={visible}
        aria-controls={`${id}-value`}
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? "Hide" : "Show"}
      </button>
      <CopyButton value={password} label="Copy password" />
    </div>
  );
}

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return port >= PORT_MIN && port <= PORT_MAX ? port : null;
}

function problemText(problem: ShareActionError, status: ShareStatus): string {
  switch (problem.code) {
    case "port_in_use":
      return `Port ${status.port} is in use. Choose another port in Advanced.`;
    case "no_network":
      return "No local network detected. Connect to Wi-Fi or Ethernet, then refresh.";
    case "start_failed":
      return "The local server did not start. Try again.";
    case "not_local":
      return "";
    default:
      return problem.message;
  }
}

export function ShareCard() {
  const share = useShare();
  const { ask, dialog } = useConfirm();
  const switchStateId = useId();
  const [portDraft, setPortDraft] = useState("");
  const [portError, setPortError] = useState("");
  const statusPort = share.status?.port;

  useEffect(() => {
    if (statusPort !== undefined) setPortDraft(String(statusPort));
  }, [statusPort]);

  if (share.loading) {
    return (
      <section className="setting-card share-card" aria-labelledby="set-network">
        <div className="share-head">
          <div>
            <h2 id="set-network">Share on my network</h2>
            <p className="muted">Open your library on a phone or tablet on the same network.</p>
          </div>
        </div>
        <p className="muted" role="status">
          Loading sharing settings…
        </p>
        <div className="share-skeleton" aria-hidden="true">
          <span />
          <span />
        </div>
      </section>
    );
  }

  const status = share.status;
  if (!status) return null;

  const problem: ShareActionError | null = share.actionError ?? status.error;
  const problemMessage = problem && problem.code !== "not_local" ? problemText(problem, status) : "";
  const state = share.pending
    ? "starting"
    : problemMessage
      ? "attention"
      : status.running
        ? "on"
        : status.enabled
          ? "starting"
          : "off";
  const stateLabel = share.pending
    ? PENDING_LABEL[share.pending]
    : problemMessage
      ? "Attention"
      : status.running
        ? "On"
        : status.enabled
          ? "Starting"
          : "Off";
  const firstUrl = status.urls[0];
  const pairUrl =
    firstUrl && status.password ? pairingUrl(firstUrl, { user: status.user, pass: status.password }) : null;
  const sharingEnabled = status.enabled;

  async function toggle(next: boolean) {
    if (next) {
      const ok = await ask({
        title: "Turn on sharing?",
        message: (
          <>
            <p>{WARNING}</p>
            <p>The local server restarts. Open uploads and indexing stop.</p>
          </>
        ),
        confirmLabel: "Turn on sharing",
        danger: true,
      });
      if (!ok) return;
    }
    await share.setEnabled(next);
  }

  async function regenerate() {
    const ok = await ask({
      title: "Regenerate password?",
      message: "Phones and other devices with the old password must sign in again. The local server restarts.",
      confirmLabel: "Regenerate password",
      danger: true,
    });
    if (ok) await share.rotatePassword();
  }

  async function savePort(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const port = parsePort(portDraft);
    if (port === null) {
      setPortError(`Enter a port between ${PORT_MIN} and ${PORT_MAX}.`);
      return;
    }
    setPortError("");
    await share.setEnabled(sharingEnabled, port);
  }

  return (
    <section className="setting-card share-card" aria-labelledby="set-network" aria-busy={share.pending !== null}>
      <div className="share-head">
        <div className="share-head-copy">
          <h2 id="set-network">Share on my network</h2>
          <p className="muted">Open your library on a phone or tablet on the same network.</p>
        </div>
        <div className="share-switch-wrap">
          <button
            type="button"
            className="share-switch"
            role="switch"
            aria-checked={status.enabled}
            aria-label="Share on my network"
            aria-describedby={switchStateId}
            disabled={share.pending !== null}
            onClick={() => void toggle(!status.enabled)}
          >
            <span aria-hidden="true" />
          </button>
          <span id={switchStateId} className="share-state" data-state={state}>
            {stateLabel}
          </span>
        </div>
      </div>

      <div className="share-safety">
        <p className="share-warning">{WARNING}</p>
        <p className="share-tip">
          Tip: for encrypted access, use Tailscale on both devices and open the 100.x address.
        </p>
      </div>

      {share.pending && (
        <p className="muted share-busy" role="status">
          {PENDING_TEXT[share.pending]}
        </p>
      )}

      {problemMessage && (
        <div className="error share-error" role="alert">
          <span>{problemMessage}</span>
          {problem?.code === "no_network" ? (
            <button type="button" className="ghost bordered" onClick={() => void share.refresh()} disabled={share.pending !== null}>
              Refresh
            </button>
          ) : (
            <button type="button" className="ghost bordered" onClick={() => void share.setEnabled(true)} disabled={share.pending !== null}>
              Try again
            </button>
          )}
        </div>
      )}

      {!status.enabled && (
        <p className="muted share-off-copy">Sharing is off. Your library is reachable only from this computer.</p>
      )}

      {status.enabled && !status.running && !problemMessage && (
        <p className="notice share-not-running" role="status">
          Sharing is on, but the local server is not listening.
        </p>
      )}

      {status.running && (
        <div className="share-on">
          <div className="share-details">
            <div className="share-block">
              <div className="share-block-head">
                <h3>Address</h3>
                <button
                  type="button"
                  className="ghost share-refresh"
                  onClick={() => void share.refresh()}
                  disabled={share.pending !== null}
                >
                  Refresh
                </button>
              </div>
              {status.urls.length > 0 ? (
                status.urls.map((url) => (
                  <ShareValue key={url} label="URL" value={url} copyLabel={`Copy address ${url}`} />
                ))
              ) : (
                <p className="muted">No address to display.</p>
              )}
            </div>

            <div className="share-block">
              <h3>Sign-in</h3>
              <ShareValue label="Username" value={status.user} copyLabel="Copy username" />
              {status.password ? (
                <PasswordField password={status.password} />
              ) : (
                <p className="muted">No password yet. Regenerate it.</p>
              )}
            </div>
          </div>

          {pairUrl && (
            <div className="share-qr-block">
              <QrCode value={pairUrl} label="QR code with the sign-in link" />
              <p className="share-qr-copy">Scan this code with your phone camera. It contains the password, so do not share it.</p>
            </div>
          )}
        </div>
      )}

      {status.enabled && (
        <div className="share-actions">
          <button
            type="button"
            className="ghost bordered"
            onClick={() => void regenerate()}
            disabled={share.pending !== null}
          >
            Regenerate password
          </button>
          <span className="muted">Phones with the old password must sign in again.</span>
        </div>
      )}

      <details className="share-advanced">
        <summary>Advanced</summary>
        <form className="share-port-form" onSubmit={(event) => void savePort(event)} noValidate>
          <label htmlFor="share-port">Port</label>
          <div className="share-port-row">
            <input
              id="share-port"
              type="number"
              inputMode="numeric"
              min={PORT_MIN}
              max={PORT_MAX}
              step={1}
              value={portDraft}
              disabled={share.pending !== null}
              aria-invalid={portError ? true : undefined}
              aria-describedby="share-port-help"
              onChange={(event) => {
                setPortDraft(event.target.value);
                setPortError("");
              }}
            />
            <button
              type="submit"
              className="ghost bordered"
              disabled={share.pending !== null || parsePort(portDraft) === status.port}
            >
              Save port
            </button>
          </div>
          <p id="share-port-help" className="muted">
            Default: {status.defaultPort}. Both devices use the same address after a restart.
          </p>
          {portError && (
            <p className="error" role="alert">
              {portError}
            </p>
          )}
        </form>
      </details>

      <details className="share-help">
        <summary>Can't connect from your phone?</summary>
        <ul>
          <li>
            <strong>Windows:</strong> allow <code>knowlify-node.exe</code> on Private networks in the Defender prompt.
          </li>
          <li>
            <strong>macOS:</strong> allow incoming connections for <code>knowlify-node</code> when macOS asks.
          </li>
          <li>
            <strong>Linux:</strong> open TCP port {status.port} in ufw or firewalld.
          </li>
        </ul>
        <p className="muted">
          Both devices must be on the same network. Guest and public networks often block devices from reaching each
          other.
        </p>
      </details>

      {dialog}
    </section>
  );
}
