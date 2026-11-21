import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { IgnoredBook } from "../../types";
import { ignoredFormat, ignoredReasonLabel } from "./ignoredApi";
import { useIgnoredBooks } from "./useIgnoredBooks";
import "./ignored.css";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** Settings card: books the library will not re-import until restored. */
export function IgnoredBooksCard({ api }: { api: ApiFn }) {
  const state = useIgnoredBooks(api);
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (location.hash !== "#ignored-books") return;
    const node = section.current;
    if (!node) return;
    const header = document.querySelector<HTMLElement>(".app > header");
    if (header) node.style.scrollMarginTop = `${Math.round(header.getBoundingClientRect().height + 12)}px`;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }, [location.hash]);

  if (state.unavailable) return null;

  async function restore(entry: IgnoredBook) {
    if (busy) return;
    setBusy(entry.id);
    setError("");
    setNotice("");
    try {
      await state.restore(entry.id);
      setNotice(`Restored “${entry.title}”. It comes back as a new book; notes and progress are not recovered.`);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="ignored-books"
      ref={section}
      tabIndex={-1}
      className="setting-card ignored-card"
      aria-labelledby="set-ignored"
    >
      <h2 id="set-ignored">Ignored books</h2>
      <p className="muted">
        Books you deleted stay here so a folder scan does not bring them back. Restoring brings them back as new entries.
      </p>

      {state.error && (
        <div className="error ignored-feedback" role="alert">
          <span>{state.error}</span>
          <button className="ghost bordered" onClick={state.reload}>
            Try again
          </button>
        </div>
      )}
      {error && (
        <div className="error ignored-feedback" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="notice ignored-feedback" role="status">
          {notice}
        </p>
      )}

      {state.loading && state.items.length === 0 ? (
        <p className="muted ignored-empty" role="status">
          Loading ignored books…
        </p>
      ) : state.items.length === 0 ? (
        <p className="muted ignored-empty">No ignored books. Books you delete from the library appear here.</p>
      ) : (
        <>
          <p className="ignored-count">
            {state.total} {state.total === 1 ? "book" : "books"} ignored
          </p>
          <ul className="ignored-list" aria-label="Ignored books">
            {state.items.map((entry) => (
              <li key={entry.id} className="ignored-row">
                <div className="ignored-info">
                  <strong>{entry.title}</strong>
                  <span className="muted">
                    {entry.author || "Unknown author"} · {ignoredFormat(entry.format)} ·{" "}
                    {(entry.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <span className="ignored-meta">
                    Removed {ignoredReasonLabel(entry.reason)} · {dateFormat.format(new Date(entry.ignoredAt))}
                    {entry.managed ? " · uploaded copy" : ""}
                  </span>
                  {entry.path && (
                    <code className="ignored-path" title={entry.path}>
                      {entry.path}
                    </code>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost bordered"
                  aria-label={`Restore ${entry.title}`}
                  disabled={busy !== null}
                  onClick={() => void restore(entry)}
                >
                  {busy === entry.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
          {state.items.length < state.total && (
            <button
              type="button"
              className="ghost bordered ignored-more"
              disabled={state.loadingMore}
              onClick={state.loadMore}
            >
              {state.loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          <p className="ignored-note muted">
            Restored books come back as new entries; notes and progress are not recovered.
          </p>
        </>
      )}
    </section>
  );
}
