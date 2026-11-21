import { useEffect, useMemo, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { Logo } from "../../components/Logo";
import { ApiError, formatError } from "../../services/api";
import { aboutApi, type AboutApi } from "./aboutApi";
import type { AboutInfo } from "./aboutTypes";
import { CopyField } from "./CopyField";
import "./about.css";

/** Build-time version of this web bundle; the fallback keeps tests and plain dev usable. */
const WEB_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";

const isKnownVersion = (version: string) => version !== "0.0.0-dev";

const versionLabel = (info: AboutInfo) => (info.commit ? `${info.version} (${info.commit})` : info.version);

/** Only web links are rendered; the server value is otherwise treated as plain text. */
const sourceHref = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

const formatBuiltAt = (value: string | null) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; info: AboutInfo }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export function AboutCard({
  api,
  webVersion = WEB_VERSION,
  onReload = () => window.location.reload(),
}: {
  api: ApiFn;
  webVersion?: string;
  onReload?: () => void;
}) {
  const client = useMemo<AboutApi>(() => aboutApi(api), [api]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    client.get().then(
      (info) => {
        if (active) setState({ status: "ready", info });
      },
      (reason: unknown) => {
        if (!active) return;
        // A server older than the route answers 404: show the web build alone.
        if (reason instanceof ApiError && reason.status === 404) setState({ status: "unavailable" });
        else setState({ status: "error", message: formatError(reason) });
      },
    );
    return () => {
      active = false;
    };
  }, [client, attempt]);

  const staleVersion =
    state.status === "ready" && isKnownVersion(webVersion) && state.info.version !== webVersion
      ? webVersion
      : null;
  const source = state.status === "ready" ? sourceHref(state.info.sourceUrl) : null;

  return (
    <section className="setting-card about-card" aria-labelledby="set-about">
      <div className="about-brand">
        <Logo size={32} />
        <div>
          <h2 id="set-about">About</h2>
          <p className="muted">Build details for this Knowlify instance.</p>
        </div>
      </div>

      {state.status === "loading" && (
        <p className="muted about-status" role="status">
          Loading version…
        </p>
      )}

      {state.status === "error" && (
        <div className="about-status">
          <p className="error" role="alert">{state.message}</p>
          <button className="ghost bordered" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}

      {state.status === "unavailable" && (
        <>
          <CopyField label="Web UI" value={webVersion} />
          <p className="about-note">This server does not report its version. Showing the web interface build.</p>
        </>
      )}

      {state.status === "ready" && (
        <>
          {staleVersion && (
            <div className="about-stale">
              <p role="status">Web UI is out of date (v{staleVersion}).</p>
              <button className="ghost bordered" onClick={onReload}>
                Reload
              </button>
            </div>
          )}
          <CopyField
            label="Server version"
            value={versionLabel(state.info)}
            action={
              source ? (
                <a
                  className="about-source"
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source code
                </a>
              ) : undefined
            }
          />
          <dl className="about-meta">
            <div>
              <dt>Built</dt>
              <dd>{formatBuiltAt(state.info.builtAt)}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{state.info.node}</dd>
            </div>
          </dl>
          <p className="about-note">Reported by the app server.</p>
        </>
      )}
    </section>
  );
}
