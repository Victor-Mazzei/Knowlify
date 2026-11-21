import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Book, Tag, TagWithCount } from "../../types";
import { tagColorClass } from "../tags/tagColors";
import { tagErrorMessage } from "../tags/tagsApi";

/** Tri-state from the loaded selected rows; `all` mode offers explicit Add/Remove. */
export function tagSelectionState(tagId: string, books: Book[]): "all" | "some" | "none" {
  if (books.length === 0) return "none";
  const withTag = books.filter((book) => (book.tagIds ?? []).includes(tagId)).length;
  if (withTag === books.length) return "all";
  return withTag === 0 ? "none" : "some";
}

export function TagPopover({
  tags,
  loading,
  selectedBooks,
  allMode,
  onApply,
  onCreate,
  onClose,
}: {
  tags: TagWithCount[];
  loading: boolean;
  selectedBooks: Book[];
  allMode: boolean;
  onApply: (add: string[], remove: string[]) => Promise<void>;
  onCreate: (name: string) => Promise<Tag>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const visible = useMemo(
    () => (needle ? tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle)) : tags),
    [needle, tags],
  );
  const exact = tags.some((tag) => tag.name.toLocaleLowerCase() === needle) || needle.length === 0;
  const normalized = search.trim().replace(/\s+/g, " ");

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
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

  async function createAndApply() {
    await run(async () => {
      const tag = await onCreate(normalized);
      await onApply([tag.id], []);
      setSearch("");
    });
  }

  return (
    <div ref={ref} className="tag-popover" role="group" aria-label="Tag selected books">
      <label className="tag-search">
        <span className="visually-hidden">Search tags</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search or create a tag"
          value={search}
          maxLength={40}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {error && <p className="tag-popover-error" role="alert">{error}</p>}
      <div className="tag-popover-list">
        {loading && <p className="muted">Loading tags…</p>}
        {!loading && visible.length === 0 && needle.length === 0 && (
          <p className="muted">No tags yet. Create the first one below.</p>
        )}
        {visible.map((tag) => {
          const state = tagSelectionState(tag.id, selectedBooks);
          return (
            <div key={tag.id} className="tag-popover-row">
              <span className={`tag-dot ${tagColorClass(tag.color)}`} aria-hidden="true" />
              <span className="tag-popover-name">{tag.name}</span>
              {allMode || selectedBooks.length === 0 ? (
                <span className="tag-popover-actions">
                  <button
                    type="button"
                    className="ghost bordered"
                    disabled={busy}
                    onClick={() => void run(() => onApply([tag.id], []))}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void run(() => onApply([], [tag.id]))}
                  >
                    Remove
                  </button>
                </span>
              ) : (
                <label className="tag-tri">
                  <input
                    type="checkbox"
                    checked={state === "all"}
                    ref={(node) => {
                      if (node) node.indeterminate = state === "some";
                    }}
                    disabled={busy}
                    aria-label={`${tag.name}: ${state === "all" ? "applied to all selected books" : state === "some" ? "applied to some selected books" : "not applied"}`}
                    onChange={() =>
                      void run(() => (state === "all" ? onApply([], [tag.id]) : onApply([tag.id], [])))
                    }
                  />
                </label>
              )}
            </div>
          );
        })}
        {!loading && needle.length > 0 && !exact && (
          <button type="button" className="tag-create" disabled={busy} onClick={() => void createAndApply()}>
            Create tag “{normalized}”
          </button>
        )}
      </div>
      <div className="tag-popover-foot">
        <Link to="/settings/tags" onClick={onClose}>
          Manage tags
        </Link>
        <button type="button" className="ghost" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
