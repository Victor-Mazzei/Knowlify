import { useEffect, useRef, useState } from "react";
import { useConfirm, useDialogKeys } from "../../components/dialogs";
import { formatError } from "../../services/api";
import type { Feed } from "./types";

type FeedsDialogProps = {
  feeds: Feed[];
  onAdd: (url: string) => Promise<void>;
  onUpdate: (id: string, body: { title?: string; enabled?: boolean }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
};

export function FeedsDialog({ feeds, onAdd, onUpdate, onRemove, onClose }: FeedsDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  const { ask, dialog } = useConfirm();

  useDialogKeys(ref, onClose);

  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>("input,button")?.focus();
    return () => (opener.current as HTMLElement | null)?.focus();
  }, []);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onAdd(url.trim());
      setUrl("");
    } catch (value) {
      setError(formatError(value));
    } finally {
      setBusy(false);
    }
  }

  function startEditing(feed: Feed) {
    setEditing(feed.id);
    setTitle(feed.title);
    setError("");
  }

  function cancelEditing() {
    setEditing(undefined);
    setTitle("");
  }

  async function saveTitle(feed: Feed) {
    if (!title.trim()) return;
    try {
      await onUpdate(feed.id, { title: title.trim() });
      cancelEditing();
    } catch (value) {
      setError(formatError(value));
    }
  }

  async function toggle(feed: Feed) {
    try {
      await onUpdate(feed.id, { enabled: !feed.enabled });
    } catch (value) {
      setError(formatError(value));
    }
  }

  async function remove(feed: Feed) {
    const confirmed = await ask({
      title: "Remove this feed?",
      message: feed.title,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await onRemove(feed.id);
    } catch (value) {
      setError(formatError(value));
    }
  }

  return (
    <div
      className="dialog-backdrop centered"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="confirm-dialog feeds-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feeds-title"
      >
        <div className="panel-heading">
          <h2 id="feeds-title">Manage feeds</h2>
          <button className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form onSubmit={add} className="feed-add">
          <label>
            RSS feed URL
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/feed.xml"
            />
          </label>
          <button className="primary" disabled={busy}>
            Add feed
          </button>
        </form>
        {error && <div className="error" role="alert">{error}</div>}
        <ul className="feed-manage-list">
          {feeds.map((feed) => (
            <li key={feed.id}>
              <div>
                {editing === feed.id ? (
                  <div className="feed-rename">
                    <input
                      aria-label={`Rename ${feed.title}`}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveTitle(feed);
                        }
                      }}
                    />
                    <button className="ghost" onClick={() => void saveTitle(feed)}>Save</button>
                    <button className="ghost" onClick={cancelEditing}>Cancel</button>
                  </div>
                ) : (
                  <strong>{feed.title}</strong>
                )}
                <small>{feed.kind === "topic" ? `Topic: ${feed.query}` : feed.url}</small>
              </div>
              <div className="feed-manage-actions">
                {editing !== feed.id && (
                  <button className="ghost" onClick={() => startEditing(feed)}>Rename</button>
                )}
                <button className="ghost" onClick={() => void toggle(feed)}>
                  {feed.enabled ? "Disable" : "Enable"}
                </button>
                <button className="ghost danger-action" onClick={() => void remove(feed)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        {dialog}
      </div>
    </div>
  );
}
