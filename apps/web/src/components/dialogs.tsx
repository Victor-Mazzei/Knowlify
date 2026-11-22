import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FolderListing } from "../modules/folders/types";

export type ApiFn = (path: string, init?: RequestInit) => Promise<Response>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Open dialogs, oldest first. Only the last one (the topmost) may react to the keyboard. */
const openDialogs: symbol[] = [];

/** Keeps Tab inside the dialog and closes it on Escape. Nested dialogs: only the topmost reacts. */
export function useDialogKeys(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const id = Symbol("dialog");
    openDialogs.push(id);
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== id) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, [href], [tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      openDialogs.splice(openDialogs.indexOf(id), 1);
    };
  }, [ref]);
}

type ConfirmOptions = {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};

export function ConfirmDialog({ options, onResult }: { options: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<Element | null>(document.activeElement);
  const cancel = useCallback(() => onResult(false), [onResult]);
  useDialogKeys(ref, cancel);
  useEffect(() => {
    cancelRef.current?.focus();
    const opener = previous.current as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div ref={ref} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{options.title}</h2>
        <div id="confirm-message" className="confirm-message">
          {options.message}
        </div>
        <div className="confirm-actions">
          <button ref={cancelRef} className="ghost bordered" onClick={cancel}>
            Cancel
          </button>
          <button className={options.danger ? "primary danger" : "primary"} onClick={() => onResult(true)}>
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise-based replacement for window.confirm:
 *   const { ask, dialog } = useConfirm();   ...   if (await ask({ title, message })) ...   {dialog}
 */
export function useConfirm() {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void }>();
  const ask = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );
  const dialog = pending ? (
    <ConfirmDialog
      options={pending.options}
      onResult={(ok) => {
        pending.resolve(ok);
        setPending(undefined);
      }}
    />
  ) : null;
  return { ask, dialog };
}

/**
 * Browses the folders the server allows so a library folder can be picked.
 * `onSelect` may reject (for example when the folder cannot be added); the
 * picker then shows the reason and stays open.
 */
export function FolderPicker({
  api,
  initialPath,
  onSelect,
  onClose,
}: {
  api: ApiFn;
  initialPath?: string;
  onSelect: (path: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lastRequest = useRef(initialPath?.trim() || undefined);
  const requestId = useRef(0);
  const firstListing = useRef(true);
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  useDialogKeys(ref, onClose);

  const go = useCallback(
    async (path?: string) => {
      const request = ++requestId.current;
      lastRequest.current = path;
      setLoading(true);
      setError("");
      try {
        const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
        const response = await api(`/api/fs${query}`);
        const next = (await response.json()) as FolderListing;
        if (request !== requestId.current) return;
        setListing(next);
      } catch (e) {
        if (request !== requestId.current) return;
        setError(errorText(e));
      } finally {
        if (request === requestId.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void go(initialPath?.trim() || undefined);
    cancelRef.current?.focus();
  }, [go, initialPath]);

  // Keep keyboard focus in the list after navigating; the first listing leaves
  // the initial focus on Cancel.
  useEffect(() => {
    if (!listing) return;
    if (firstListing.current) {
      firstListing.current = false;
      return;
    }
    ref.current?.querySelector<HTMLElement>(".folder-row")?.focus();
  }, [listing]);

  async function select() {
    if (!listing?.path || selecting) return;
    setSelecting(true);
    setError("");
    try {
      await onSelect(listing.path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSelecting(false);
    }
  }

  const restricted = listing?.restricted === true;
  const crumbs = listing ? breadcrumbs(listing.path, restricted) : [];
  return (
    <div className="dialog-backdrop centered" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className="confirm-dialog folder-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" aria-describedby="picker-copy">
        <h2 id="picker-title">{restricted && !listing?.path ? "Choose an allowed folder" : "Choose a library folder"}</h2>
        <p className="panel-copy" id="picker-copy">
          {restricted ? "Only folders mounted into the Knowlify container are available." : "Folders on the machine running Knowlify."} Books are indexed in place and never modified.
        </p>
        <nav className="crumbs" aria-label="Current folder">
          {crumbs.map((crumb, index) => (
            <button key={crumb.path || "root"} className={`crumb${index === 0 ? " crumb-root" : ""}`} onClick={() => void go(crumb.path)} aria-current={index === crumbs.length - 1 ? "location" : undefined}>
              {crumb.label}
            </button>
          ))}
        </nav>
        {error && (
          <div className="error picker-error" role="alert">
            <span>{error}</span>
            <button className="ghost" onClick={() => void go(lastRequest.current)}>Try again</button>
          </div>
        )}
        <ul className="folder-list" aria-busy={loading} aria-label="Folders">
          {loading && !listing && <li className="muted folder-empty" role="status">Loading folders…</li>}
          {listing && listing.parent !== null && (
            <li>
              <button className="folder-row" onClick={() => void go(listing.parent ?? "")}><span aria-hidden="true">↑</span> Up one level</button>
            </li>
          )}
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button className="folder-row" onClick={() => void go(entry.path)}>
                <span aria-hidden="true">▸</span> {entry.name}
              </button>
            </li>
          ))}
          {listing && !loading && listing.entries.length === 0 && !error && (
            <li className="muted folder-empty">
              {restricted
                ? "No folders inside this one. Knowlify can browse only folders mounted into its container."
                : "No subfolders here. Select this folder to add it."}
            </li>
          )}
        </ul>
        <div className="confirm-actions picker-actions">
          <small>{listing?.path ? `${listing.books} ${listing.books === 1 ? "book" : "books"} directly in this folder` : ""}</small>
          <button ref={cancelRef} className="ghost bordered" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!listing?.path || loading || selecting} onClick={() => void select()}>
            {selecting ? "Adding…" : "Select this folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

function breadcrumbs(path: string, restricted: boolean) {
  if (!path) return [{ label: restricted ? "Allowed folders" : "Drives", path: "" }];
  const windows = /^[A-Za-z]:/.test(path);
  const sep = windows ? /[\\/]+/ : /\/+/;
  const parts = path.split(sep).filter(Boolean);
  const crumbs: { label: string; path: string }[] = windows ? [{ label: "Drives", path: "" }] : [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc = windows ? (acc ? `${acc}\\${part}` : `${part}\\`) : `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}
