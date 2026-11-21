import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { FavoriteButton } from "../../components/ui/FavoriteButton";
import { BookIndexAction } from "../indexing/BookIndexAction";
import { BookIndexNote } from "../indexing/BookIndexNote";
import type { Book, TagWithCount } from "../../types";
import { rememberLibraryReturn } from "../book/libraryReturn";
import { ProgressBar } from "./ProgressBar";
import { SelectCheckbox } from "./selection/SelectCheckbox";
import { TableTags, tagsForBook } from "./TagChips";

/** Must match `.books-table tbody tr` in library-table.css. */
export const TABLE_ROW_HEIGHT = 44;
const BASE_COLUMNS = 6;

export type TableSelectEvent = { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

export type TableSelection = {
  /** True on servers that understand the tags/selection contract. */
  selectable: boolean;
  /** True in "all results" mode: every loaded row is selected. */
  allSelected: boolean;
  selectedIds: ReadonlySet<string>;
  allLoadedSelected: boolean;
  someLoadedSelected: boolean;
  onToggle: (book: Book, event: TableSelectEvent) => void;
  onToggleAll: () => void;
};

function TableColumns({ selectable, showTags }: { selectable: boolean; showTags: boolean }) {
  return (
    <colgroup>
      {selectable && <col className="col-select" />}
      <col className="col-title" />
      <col className="col-author" />
      <col className="col-type" />
      {showTags && <col className="col-tags" />}
      <col className="col-progress" />
      <col className="col-added" />
      <col className="col-actions" />
    </colgroup>
  );
}

function TableHeader({
  selection,
  showTags = false,
  interactive = true,
}: {
  selection?: TableSelection;
  showTags?: boolean;
  interactive?: boolean;
}) {
  return (
    <thead>
      <tr>
        {selection?.selectable && (
          <th scope="col" className="select-col">
            <SelectCheckbox
              label="Select loaded books"
              checked={selection.allLoadedSelected}
              indeterminate={selection.someLoadedSelected && !selection.allLoadedSelected}
              tabIndex={interactive ? undefined : -1}
              onChange={selection.onToggleAll}
            />
          </th>
        )}
        <th scope="col">Title</th>
        <th scope="col">Author</th>
        <th scope="col">Type</th>
        {showTags && <th scope="col" className="tags-col">Tags</th>}
        <th scope="col" className="progress-col">Progress</th>
        <th scope="col">Added</th>
        <th scope="col" />
      </tr>
    </thead>
  );
}

/**
 * The page, not the table wrapper, scrolls vertically. A wrapper with
 * `overflow-x: auto` would be the sticky containing block, so the visible
 * header lives in its own sticky element above the horizontal scroller. Its
 * horizontal position mirrors the body scroller, keeping the fixed columns
 * aligned.
 */
export function BookTable({
  books,
  api,
  total = books.length,
  startIndex = 0,
  loadedCount = startIndex + books.length,
  onDelete,
  selection,
  tags = [],
  showTags = false,
  favoritePendingIds,
  onToggleFavorite,
}: {
  books: Book[];
  api: ApiFn;
  /** Total matching the current search, used for `aria-rowcount` and page numbers. */
  total?: number;
  /** Index of the first rendered row in the full result set. */
  startIndex?: number;
  /** Number of items currently loaded; drives the bottom spacer. */
  loadedCount?: number;
  onDelete: (book: Book) => void;
  selection?: TableSelection;
  tags?: TagWithCount[];
  /** Adds the Tags column; hidden below the mobile breakpoint by CSS. */
  showTags?: boolean;
  favoritePendingIds?: ReadonlySet<string>;
  /** Absent on older servers, which hides the star. */
  onToggleFavorite?: (book: Book) => void;
}) {
  const columns = BASE_COLUMNS + (selection?.selectable ? 1 : 0) + (showTags ? 1 : 0);
  const search = useLocation().search;
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const topSpacer = startIndex * TABLE_ROW_HEIGHT;
  const bottomSpacer = Math.max(0, loadedCount - startIndex - books.length) * TABLE_ROW_HEIGHT;
  const stickyHeadRef = useRef<HTMLDivElement>(null);
  const headScrollRef = useRef<HTMLDivElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const isSelected = (book: Book) => Boolean(selection && (selection.allSelected || selection.selectedIds.has(book.id)));

  // The app header wraps on narrow screens, so its height is measured rather
  // than hard-coded: the table header must stick below it, never underneath.
  useLayoutEffect(() => {
    const sticky = stickyHeadRef.current;
    const appHeader = sticky?.closest(".app")?.querySelector("header");
    if (!sticky || !(appHeader instanceof HTMLElement)) return;
    const updateOffset = () => {
      sticky.style.setProperty("--books-table-sticky-top", `${appHeader.getBoundingClientRect().height}px`);
    };
    updateOffset();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOffset);
      return () => window.removeEventListener("resize", updateOffset);
    }
    const observer = new ResizeObserver(updateOffset);
    observer.observe(appHeader);
    return () => observer.disconnect();
  }, []);

  // The visual header sits outside the horizontal scroller, so keep both
  // scroll positions equal when a narrow viewport pans the table.
  useEffect(() => {
    const body = bodyScrollRef.current;
    if (!body) return;
    const sync = () => {
      if (headScrollRef.current) headScrollRef.current.scrollLeft = body.scrollLeft;
    };
    sync();
    body.addEventListener("scroll", sync, { passive: true });
    return () => body.removeEventListener("scroll", sync);
  }, []);

  return (
    <div className={`table-wrap${selection?.selectable ? " has-selection" : ""}`}>
      <div className="table-sticky-head" aria-hidden="true" ref={stickyHeadRef}>
        <div className="table-sticky-head-scroll" ref={headScrollRef}>
          <table className="books-table books-table-head">
            <TableColumns selectable={Boolean(selection?.selectable)} showTags={showTags} />
            <TableHeader selection={selection} showTags={showTags} interactive={false} />
          </table>
        </div>
      </div>
      <div className="table-scroll" ref={bodyScrollRef}>
        <table
          className="books-table books-table-body"
          role={selection?.selectable ? "grid" : undefined}
          aria-multiselectable={selection?.selectable ? true : undefined}
          aria-rowcount={total + 1}
          aria-label="Books"
        >
          <TableColumns selectable={Boolean(selection?.selectable)} showTags={showTags} />
          <TableHeader selection={selection} showTags={showTags} />
          <tbody>
            {topSpacer > 0 && (
              <tr className="spacer-row" aria-hidden="true">
                <td colSpan={columns} style={{ height: topSpacer }} />
              </tr>
            )}
            {books.map((book, index) => {
              const selected = isSelected(book);
              return (
                <tr
                  key={book.id}
                  aria-rowindex={startIndex + index + 2}
                  aria-selected={selection?.selectable ? selected : undefined}
                  className={selected ? "selected" : undefined}
                >
                  {selection?.selectable && (
                    <td className="select-cell">
                      <SelectCheckbox
                        label={`Select ${book.title}`}
                        checked={selected}
                        onChange={(modifiers) => selection.onToggle(book, modifiers)}
                      />
                    </td>
                  )}
                  <td className="title-cell">
                    <Link
                      to={`/book/${book.id}`}
                      state={{ from: search }}
                      title={book.title}
                      onClick={() => rememberLibraryReturn(search)}
                    >
                      {book.title}
                    </Link>
                    {book.status === "pending" && <small> · importing…</small>}
                    {book.status === "error" && <small className="error-status"> · unavailable</small>}
                    <BookIndexNote book={book} />
                  </td>
                  <td title={book.author || undefined}>{book.author || "—"}</td>
                  <td>
                    <span className="type">
                      <span className="format">{book.format.toUpperCase()}</span>
                      <span className="num">{(book.size / 1024 / 1024).toFixed(1)} MB</span>
                    </span>
                  </td>
                  {showTags && (
                    <td className="tags-cell">
                      <TableTags tags={tagsForBook(book.tagIds, tags)} />
                    </td>
                  )}
                  <td className="progress-cell">
                    <ProgressBar percentage={book.progress?.percentage} />
                  </td>
                  <td className="num">{new Date(book.addedAt).toLocaleDateString()}</td>
                  <td className="actions">
                    <span className="row-actions">
                      {onToggleFavorite && (
                        <FavoriteButton
                          compact
                          className="row-favorite"
                          favorite={Boolean(book.favorite)}
                          bookTitle={book.title}
                          disabled={favoritePendingIds?.has(book.id)}
                          onToggle={() => onToggleFavorite(book)}
                        />
                      )}
                      <BookIndexAction book={book} api={api} className="row-action" />
                      {!book.source && book.status !== "pending" && (
                        <button className="ghost danger-action row-action" aria-label={`Delete ${book.title}`} onClick={() => onDelete(book)}>
                          Delete
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {bottomSpacer > 0 && (
              <tr className="spacer-row" aria-hidden="true">
                <td colSpan={columns} style={{ height: bottomSpacer }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
