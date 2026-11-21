import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import type { TagColor, TagWithCount } from "../../types";
import { DEFAULT_TAG_COLOR, isValidTagName, TAG_NAME_MAX } from "./tagColors";
import { tagErrorMessage } from "./tagsApi";
import { useTags } from "./useTags";
import { TagColorPicker } from "./TagColorPicker";
import { TagRow } from "./TagRow";
import "./tags.css";

/** Settings card: create, rename, recolor and remove tags (never books). */
export function TagsCard({ api }: { api: ApiFn }) {
  const state = useTags(api);
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>(DEFAULT_TAG_COLOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");

  useEffect(() => {
    if (location.hash !== "#tags") return;
    const node = section.current;
    if (!node) return;
    const header = document.querySelector<HTMLElement>(".app > header");
    if (header) node.style.scrollMarginTop = `${Math.round(header.getBoundingClientRect().height + 12)}px`;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }, [location.hash]);

  if (state.unavailable) return null;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!isValidTagName(name)) {
      setError("Use 1–40 characters.");
      return;
    }
    setBusy(true);
    setError("");
    setOutcome("");
    try {
      await state.create(name, color);
      setName("");
      setColor(DEFAULT_TAG_COLOR);
      setOutcome("Tag created.");
    } catch (e) {
      setError(tagErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: TagWithCount) {
    const ok = await ask({
      title: `Delete the tag “${tag.name}”?`,
      message: (
        <>
          The tag will be removed from {tag.count} {tag.count === 1 ? "book" : "books"}. Books are not deleted.
        </>
      ),
      confirmLabel: "Delete tag",
      danger: true,
    });
    if (!ok) return;
    setError("");
    try {
      await state.remove(tag.id);
      setOutcome("Tag removed from every book.");
    } catch (e) {
      setError(tagErrorMessage(e));
    }
  }

  const canCreate = state.tags.length < 200;

  return (
    <section id="tags" ref={section} tabIndex={-1} className="setting-card tags-card" aria-labelledby="set-tags">
      <h2 id="set-tags">Tags</h2>
      <p className="muted">Group books across folders. Removing a tag never deletes a book.</p>

      {state.error && (
        <div className="error tags-feedback" role="alert">
          <span>{state.error}</span>
          <button className="ghost bordered" onClick={state.reload}>
            Try again
          </button>
        </div>
      )}
      {outcome && (
        <p className="notice tags-feedback" role="status">
          {outcome}
        </p>
      )}

      <form className="tag-create-form" onSubmit={(event) => void create(event)}>
        <label className="tag-name-field">
          <span>Name</span>
          <input
            value={name}
            maxLength={TAG_NAME_MAX}
            placeholder="New tag"
            disabled={busy || !canCreate}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </label>
        <TagColorPicker value={color} onChange={setColor} label="New tag color" disabled={busy || !canCreate} />
        <button className="primary" type="submit" disabled={busy || !canCreate || name.trim().length === 0}>
          {busy ? "Creating…" : "Create tag"}
        </button>
      </form>
      {error && (
        <p className="tag-create-error" role="alert">
          {error}
        </p>
      )}
      {!canCreate && <p className="muted tag-limit">You reached the limit of 200 tags.</p>}

      {state.loading ? (
        <p className="muted tags-loading" role="status">
          Loading tags…
        </p>
      ) : state.tags.length === 0 ? (
        <p className="muted tags-empty">No tags yet. Create one above and apply it from the library selection bar.</p>
      ) : (
        <ul className="tag-list" aria-label="Tags">
          {state.tags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              onUpdate={async (change) => {
                await state.update(tag.id, change);
              }}
              onRemove={() => remove(tag)}
            />
          ))}
        </ul>
      )}
      {dialog}
    </section>
  );
}
