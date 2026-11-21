import { useState } from "react";
import type { TagColor, TagWithCount } from "../../types";
import { isValidTagName, tagColorClass } from "./tagColors";
import { tagErrorMessage } from "./tagsApi";
import { TagColorPicker } from "./TagColorPicker";

/** One row of the manager: inline rename, palette and delete. */
export function TagRow({
  tag,
  onUpdate,
  onRemove,
}: {
  tag: TagWithCount;
  onUpdate: (change: { name?: string; color?: TagColor }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(tag.name);
  const [colors, setColors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(tagErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    if (name === tag.name) {
      setRenaming(false);
      return;
    }
    if (!isValidTagName(name)) {
      setError("Use 1–40 characters.");
      return;
    }
    await run(async () => {
      await onUpdate({ name });
      setRenaming(false);
    });
  }

  return (
    <li className="tag-row">
      <span className={`tag-dot ${tagColorClass(tag.color)}`} aria-hidden="true" />
      {renaming ? (
        <input
          className="tag-rename-input"
          aria-label={`Rename ${tag.name}`}
          value={name}
          maxLength={40}
          autoFocus
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveName();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setName(tag.name);
              setRenaming(false);
              setError("");
            }
          }}
          onBlur={(event) => {
            // Keep the editor open while focus moves to this row's Save button.
            if (event.currentTarget.closest("li")?.contains(event.relatedTarget as Node | null)) return;
            if (!busy) {
              setName(tag.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <strong className="tag-row-name">{tag.name}</strong>
      )}
      <span className="tag-row-count">
        {tag.count} {tag.count === 1 ? "book" : "books"}
      </span>
      <div className="tag-row-actions">
        {renaming ? (
          <button type="button" className="ghost bordered" disabled={busy} onClick={() => void saveName()}>
            Save
          </button>
        ) : (
          <button type="button" className="ghost" disabled={busy} onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        <button
          type="button"
          className="ghost"
          aria-expanded={colors}
          disabled={busy}
          onClick={() => setColors((value) => !value)}
        >
          Color
        </button>
        <button type="button" className="ghost danger-action" disabled={busy} onClick={() => void run(onRemove)}>
          Delete
        </button>
      </div>
      {colors && (
        <TagColorPicker
          value={tag.color}
          label={`Color for ${tag.name}`}
          disabled={busy}
          onChange={(color) =>
            void run(async () => {
              await onUpdate({ color });
              setColors(false);
            })
          }
        />
      )}
      {error && (
        <p className="tag-row-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
