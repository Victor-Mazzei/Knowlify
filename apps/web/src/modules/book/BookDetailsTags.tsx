import { useId, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { useTags } from "../tags/useTags";
import { tagColorClass } from "../tags/tagColors";
import { applyTags } from "../tags/tagsApi";
import { TagPopover } from "../library/TagPopover";
import "../library/selection/selection.css";
import type { BookDetail } from "./types";

/**
 * Tag membership for one book. The popover is the same control the selection bar
 * uses (create, apply and remove), narrowed to a one-book selection.
 */
export function BookDetailsTags({
  book,
  api,
  onChange,
}: {
  book: BookDetail;
  api: ApiFn;
  onChange: (next: BookDetail) => void;
}) {
  const headingId = useId();
  const tags = useTags(api);
  const [open, setOpen] = useState(false);
  if (tags.unavailable) return null;

  const members = tags.tags.filter((tag) => book.tagIds.includes(tag.id));

  async function apply(add: string[], remove: string[]) {
    await applyTags(api, { selection: { ids: [book.id] }, add, remove });
    const ids = new Set(book.tagIds);
    for (const id of add) ids.add(id);
    for (const id of remove) ids.delete(id);
    onChange({ ...book, tagIds: [...ids] });
    tags.reload();
  }

  return (
    <section className="book-details-section book-details-tags" aria-labelledby={headingId}>
      <div className="book-details-section-head">
        <h2 id={headingId}>Tags</h2>
        <button
          type="button"
          className="ghost bordered book-details-tag-edit"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {members.length > 0 ? "Edit tags" : "Add tags"}
        </button>
      </div>
      <div className="book-details-tag-list">
        {tags.loading && members.length === 0 ? (
          <p className="muted">Loading tags…</p>
        ) : members.length === 0 ? (
          <p className="muted">No tags on this book.</p>
        ) : (
          <ul className="book-details-tag-chips">
            {members.map((tag) => (
              <li key={tag.id} className={`tag-chip ${tagColorClass(tag.color)}`}>
                {tag.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {tags.error && (
        <p className="error book-details-inline-error" role="alert">
          {tags.error}
        </p>
      )}
      {open && (
        <TagPopover
          tags={tags.tags}
          loading={tags.loading}
          selectedBooks={[book]}
          allMode={false}
          onApply={apply}
          onCreate={(name) => tags.create(name)}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
