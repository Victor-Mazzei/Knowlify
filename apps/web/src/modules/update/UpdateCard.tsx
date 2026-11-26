import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError, isLocalOnlyError } from "../../services/api";
import { updateApi } from "./updateApi";
import type { UpdateInfo } from "./updateTypes";
import { publishUpdate } from "./useUpdateNotice";
import "./update.css";

type CardState =
  | { status: "loading" }
  | { status: "absent" }
  | { status: "ready"; info: UpdateInfo };

type Pending = "check" | "toggle" | null;

const PRIVACY_ON =
  "When this is on, your Knowlify server asks GitHub for the latest release about once a day. " +
  "GitHub can see the IP address of the server. Knowlify sends no version, no library data, and no ID.";
const PRIVACY_OFF = "Update checks are off. Knowlify does not contact GitHub.";

const TITLE_ID = "update-check-title";
const LABEL_ID = "update-check-label";
const PRIVACY_ID = "update-privacy";
const MANAGED_ID = "update-managed-note";

function statusOf(info: UpdateInfo): { kind: string; label: string } {
  if (!info.enabled) return { kind: "off", label: "Update checks are off" };
  if (!info.checkedAt) return { kind: "unchecked", label: "Not checked yet" };
  if (info.available && info.latest) {
    return { kind: "available", label: `Version ${info.latest.version} is available` };
  }
  return { kind: "current", label: "Up to date" };
}

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Settings → About: the readable state, an explicit Check now and the opt-out.
 * A server without `/api/update` (404) or an unreadable answer mounts nothing;
 * a failed read stays silent (only the explicit action reports a failure).
 */
export function UpdateCard({ api }: { api: ApiFn }) {
  const client = useMemo(() => updateApi(api), [api]);
  const [state, setState] = useState<CardState>({ status: "loading" });
  const [pending, setPending] = useState<Pending>(null);
  const [result, setResult] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    client.get().then(
      (info) => {
        if (!active) return;
        setState(info ? { status: "ready", info } : { status: "absent" });
      },
      () => {
        if (active) setState({ status: "absent" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  if (state.status !== "ready") return null;
  const info = state.info;
  const status = statusOf(info);
  const busy = pending !== null;
  const toggleDisabled = busy || info.locked || !info.canManage;
  const managedNote = info.locked
    ? "Set by the server administrator."
    : !info.canManage
      ? "Only available on the computer that runs Knowlify."
      : null;

  async function checkNow() {
    if (pending !== null || !info.enabled) return;
    const before = info.checkedAt;
    setPending("check");
    setResult("");
    try {
      const next = await client.check();
      if (!mounted.current) return;
      if (!next) {
        setResult("Could not check just now.");
        return;
      }
      setState({ status: "ready", info: next });
      // A 2xx with a valid DTO is always a normal result: the server also
      // returns its cache inside the 60 s cooldown (or when an upstream check
      // fails). checkedAt only tells us whether a real check ran; it never
      // turns a valid answer into a failure.
      setResult(next.checkedAt !== before ? "Checked just now." : "Checked a moment ago.");
      publishUpdate(next);
    } catch (reason) {
      if (mounted.current) {
        // A local-only 403 keeps the message the rest of Settings already uses.
        setResult(isLocalOnlyError(reason) ? formatError(reason) : "Could not check just now.");
      }
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function toggle() {
    if (pending !== null || info.locked || !info.canManage) return;
    setPending("toggle");
    setSaveError(null);
    setResult("");
    let enabled: boolean;
    try {
      const saved = await client.setEnabled(!info.enabled);
      enabled = saved.enabled;
    } catch (reason) {
      if (mounted.current) {
        setSaveError(formatError(reason));
        setPending(null);
      }
      return;
    }

    let next: UpdateInfo | null = null;
    try {
      next = await client.get();
    } catch {
      // The setting was saved; a failed refresh must not look like a failed save.
    }
    if (!mounted.current) return;
    const resolved: UpdateInfo =
      next ??
      {
        ...info,
        enabled,
        latest: enabled ? info.latest : null,
        available: enabled ? info.available : false,
        checkedAt: enabled ? info.checkedAt : null,
      };
    setState({ status: "ready", info: resolved });
    publishUpdate(resolved);
    setPending(null);
  }

  return (
    <section className="setting-card update-card" aria-labelledby={TITLE_ID}>
      <div className="update-card-head">
        <div className="update-card-intro">
          <h2 id={TITLE_ID}>Updates</h2>
          <p className="muted">Knowlify can tell you when a new release is available.</p>
        </div>
        <span className="update-state" data-state={status.kind}>
          {status.label}
        </span>
      </div>

      {info.checkedAt && (
        <p className="update-checked">
          Last checked:{" "}
          <time dateTime={info.checkedAt}>{formatCheckedAt(info.checkedAt)}</time>
        </p>
      )}

      <div className="update-actions">
        <button
          type="button"
          className="ghost bordered"
          disabled={!info.enabled || busy}
          aria-busy={pending === "check"}
          onClick={checkNow}
        >
          Check now
        </button>
        <p className="update-result" role="status">
          {result}
        </p>
      </div>

      <div className="update-toggle-row">
        <div className="update-toggle-copy">
          <strong id={LABEL_ID}>Check for new versions</strong>
          <p className="muted">The server decides how often it asks.</p>
        </div>
        <button
          type="button"
          className="update-switch"
          role="switch"
          aria-checked={info.enabled}
          aria-labelledby={LABEL_ID}
          aria-describedby={managedNote ? `${PRIVACY_ID} ${MANAGED_ID}` : PRIVACY_ID}
          aria-busy={pending === "toggle"}
          disabled={toggleDisabled}
          onClick={toggle}
        >
          <span aria-hidden="true" />
          <span className="visually-hidden">{info.enabled ? "On" : "Off"}</span>
        </button>
      </div>

      {managedNote && (
        <p id={MANAGED_ID} className="update-note">
          {managedNote}
        </p>
      )}
      <p id={PRIVACY_ID} className="update-privacy">
        {info.enabled ? PRIVACY_ON : PRIVACY_OFF}
      </p>

      {saveError && (
        <p className="error update-save-error" role="alert">
          {saveError}
        </p>
      )}
    </section>
  );
}
