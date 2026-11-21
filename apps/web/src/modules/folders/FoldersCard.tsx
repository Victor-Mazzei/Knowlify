import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { FolderPicker, useConfirm } from "../../components/dialogs";
import type { ApiFn } from "../../components/dialogs";
import { useScanStatusContext } from "../../components/ScanStatusContext";
import { formatError } from "../../services/api";
import { pickFolder } from "../../services/desktop";
import type { Source } from "../../types";

async function addFolder(api: ApiFn, folder: string, onChanged: () => Promise<void>) {
  await api("/api/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
  await onChanged();
}

/** Settings card: read-only library folders, their state and a manual rescan. */
export function FoldersCard({ api }: { api: ApiFn }) {
  const scan = useScanStatusContext();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const { ask, dialog: confirmDialog } = useConfirm();
  const { sources, sourcesLoading, sourcesError } = scan;
  const [picking, setPicking] = useState(false);
  const [path, setPath] = useState("");
  const [showPath, setShowPath] = useState(false);
  const [adding, setAdding] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [error, setError] = useState("");
  const [scanError, setScanError] = useState("");
  useEffect(() => {
    if (location.hash !== "#folders") return;
    const node = section.current;
    if (!node) return;
    let cancelled = false;
    let initialApplied = false;
    let userEngaged = false;
    let ignoreScroll = false;
    let frame = 0;
    let clearScrollFrame = 0;
    let watch: ResizeObserver | undefined;
    const header = document.querySelector<HTMLElement>(".app > header");

    const updateScrollMargin = () => {
      if (header) node.style.scrollMarginTop = `${Math.round(header.getBoundingClientRect().height + 12)}px`;
    };

    const apply = () => {
      if (cancelled) return;
      updateScrollMargin();
      if (userEngaged) return;
      const ownsFocus = document.activeElement === node || document.activeElement === document.body;
      if (initialApplied && !ownsFocus) return;
      if (typeof node.scrollIntoView === "function") {
        ignoreScroll = true;
        node.scrollIntoView({ block: "start" });
        cancelAnimationFrame(clearScrollFrame);
        clearScrollFrame = requestAnimationFrame(() => {
          ignoreScroll = false;
        });
      }
      node.focus({ preventScroll: true });
      initialApplied = true;
    };

    // Late applies only move the user when the anchor still owns focus and the
    // user has not taken over in the meantime.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== node) userEngaged = true;
    };
    const onScroll = () => {
      if (!ignoreScroll) userEngaged = true;
    };
    const onPointerDown = () => {
      userEngaged = true;
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("pointerdown", onPointerDown, true);

    // The mobile header grows when the async Ask item or the fonts arrive; keep the
    // anchor clear while the section still owns focus, but never fight the user.
    if (header && typeof ResizeObserver === "function") {
      watch = new ResizeObserver(apply);
      watch.observe(header);
    }

    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(apply);
    });
    void document.fonts?.ready.then(apply).catch(() => undefined);
    return () => {
      cancelled = true;
      watch?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(clearScrollFrame);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [location.hash]);

  async function reloadAfterChange() {
    await scan.refreshSources();
    void scan.refresh().catch(() => undefined);
    scan.wake();
  }

  function closePicker() {
    setPicking(false);
    addRef.current?.focus();
  }

  async function chooseFolder() {
    setError("");
    const picked = await pickFolder();
    if (picked.status === "cancelled") return;
    if (picked.status === "unavailable") {
      setPicking(true);
      return;
    }
    setAdding(true);
    try {
      await addFolder(api, picked.path, reloadAfterChange);
      setPath("");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setAdding(false);
    }
  }

  async function addTypedPath(event: FormEvent) {
    event.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) {
      setError("Enter a folder path.");
      return;
    }
    setAdding(true);
    setError("");
    try {
      await addFolder(api, trimmed, reloadAfterChange);
      setPath("");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setAdding(false);
    }
  }

  async function removeSource(source: Source) {
    const ok = await ask({
      title: "Remove this folder?",
      message: (
        <>
          <strong>{source.path}</strong> will be removed from the library index. Your files are never deleted.
        </>
      ),
      confirmLabel: "Remove folder",
      danger: true,
    });
    if (!ok) return;
    setError("");
    try {
      await api(`/api/sources/${source.id}`, { method: "DELETE" });
      await reloadAfterChange();
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function rescan() {
    setScanLoading(true);
    setScanError("");
    try {
      await scan.rescan();
    } catch (e) {
      setScanError(formatError(e));
    } finally {
      setScanLoading(false);
    }
  }

  return (
    <section
      ref={section}
      id="folders"
      className="setting-card folders-card"
      aria-labelledby="set-folders"
      tabIndex={-1}
    >
      <h2 id="set-folders">Folders</h2>
      <p className="muted">Where your books come from. Knowlify reads them in place and never changes their files.</p>
      {(error || sourcesError) && (
        <p className="error" role="alert">
          {error || sourcesError}
        </p>
      )}
      <div className="source-add">
        <button ref={addRef} className="primary" onClick={() => void chooseFolder()} disabled={adding}>
          {adding ? "Adding…" : "Add folder…"}
        </button>
        <p className="muted">Choose a folder Knowlify can read. Book files stay where they are.</p>
      </div>
      <button
        className="ghost path-toggle"
        aria-expanded={showPath}
        aria-controls="source-path-form"
        onClick={() => setShowPath((shown) => !shown)}
      >
        Enter a path instead
      </button>
      {showPath && (
        <form id="source-path-form" className="source-form" onSubmit={addTypedPath}>
          <label htmlFor="source-path">Folder path</label>
          <div>
            <input
              id="source-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/path/to/library"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="primary" disabled={adding}>
              {adding ? "Adding…" : "Add folder"}
            </button>
          </div>
        </form>
      )}
      <div className="source-list" aria-busy={sourcesLoading}>
        {sourcesLoading && sources.length === 0 ? (
          <p className="muted source-loading" role="status">
            Loading folders…
          </p>
        ) : sources.length ? (
          sources.map((source) => (
            <div className="source-row" key={source.id}>
              <div>
                <strong>{source.path}</strong>
                <span className={source.accessible ? "source-state" : "source-state offline"}>
                  {source.accessible ? "Accessible" : "Offline"} · {source.books} {source.books === 1 ? "book" : "books"}
                </span>
              </div>
              <button
                className="ghost danger-action"
                aria-label={`Remove library folder ${source.path}`}
                onClick={() => void removeSource(source)}
              >
                Remove
              </button>
            </div>
          ))
        ) : (
          <div className="source-empty">
            <strong>No library folders yet</strong>
            <p className="muted">Add a folder with PDF or EPUB files to start your library.</p>
          </div>
        )}
      </div>
      <div className="scan-controls">
        {scanError ? (
          <span className="scan-error" role="alert">
            {scanError}
          </span>
        ) : (
          <span className="muted">{scan.status.scanning ? "Scan in progress…" : "Keep the index up to date."}</span>
        )}
        <button className="ghost bordered" onClick={() => void rescan()} disabled={scan.status.scanning || scanLoading}>
          {scanLoading ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {confirmDialog}
      {picking && (
        <FolderPicker
          api={api}
          initialPath={path.trim() || undefined}
          onSelect={async (selected) => {
            await addFolder(api, selected, reloadAfterChange);
            setPath("");
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </section>
  );
}
