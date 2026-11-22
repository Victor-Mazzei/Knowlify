import { memo, type MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { FavoriteButton } from "../../components/ui/FavoriteButton";
import { BookIndexAction } from "../indexing/BookIndexAction";
import { BookIndexNote } from "../indexing/BookIndexNote";
import type { Book, TagWithCount } from "../../types";
import { rememberLibraryReturn } from "../book/libraryReturn";
import { ProgressBar } from "./ProgressBar";
import { SelectCheckbox } from "./selection/SelectCheckbox";
import { CardTagDots } from "./TagChips";
import { useCover } from "./useCoverQueue";

function Cover({ book, api }: { book: Book; api: ApiFn }) {
  const url = useCover(book, api);
  const description =
    book.status === "pending" ? ", importing" : book.status === "error" ? ", unavailable" : "";
  return url ? (
    <img className="cover" src={url} alt={`Cover of ${book.title}`} loading="lazy" decoding="async" />
  ) : (
    <div
      className={`cover placeholder ${book.format} ${book.status}`}
      aria-label={`${book.format.toUpperCase()} cover${description}`}
    >
      {book.status === "error" && <span aria-hidden="true">!</span>}
    </div>
  );
}

export const BookCard = memo(function BookCard({
  book,
  api,
  onDelete,
  selectable = false,
  selected = false,
  selecting = false,
  tags = [],
  favoritePending = false,
  onSelect,
  onToggleFavorite,
}: {
  book: Book;
  api: ApiFn;
  onDelete: (book: Book) => void;
  selectable?: boolean;
  selected?: boolean;
  /** True while at least one row is selected: a card click then toggles instead of opening. */
  selecting?: boolean;
  tags?: TagWithCount[];
  favoritePending?: boolean;
  onSelect?: (event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => void;
  /** Absent on older servers, which hides the star. */
  onToggleFavorite?: (book: Book) => void;
}) {
  const meta = `${book.format.toUpperCase()} · ${(book.size / 1024 / 1024).toFixed(1)} MB`;
  const search = useLocation().search;
  return (
    <article className={`card${selected ? " selected" : ""}${selecting ? " selecting" : ""}`}>
      {selectable && (
        <SelectCheckbox
          className="card-select"
          checked={selected}
          label={`Select ${book.title}`}
          onChange={(modifiers) => onSelect?.(modifiers)}
        />
      )}
      {onToggleFavorite && (
        <FavoriteButton
          compact
          className="card-favorite"
          favorite={Boolean(book.favorite)}
          bookTitle={book.title}
          disabled={favoritePending}
          onToggle={() => onToggleFavorite(book)}
        />
      )}
      <Link
        to={`/book/${book.id}`}
        state={{ from: search }}
        className="card-link"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (selecting && onSelect && event.detail !== 0) {
            // Keyboard activation still opens the details; only a pointer click toggles.
            event.preventDefault();
            onSelect(event);
            return;
          }
          rememberLibraryReturn(search);
        }}
      >
        <Cover book={book} api={api} />
        <div className="card-info">
          <h2>{book.title}</h2>
          <p>{book.author || "Unknown author"}</p>
          <span className="card-meta">
            <span>{meta}</span>
            <CardTagDots tags={tags} />
          </span>
          <BookIndexNote book={book} />
          <ProgressBar percentage={book.progress?.percentage} />
        </div>
      </Link>
      {book.status === "error" && <span className="book-status error-status">Unavailable</span>}
      {!selecting && (
        <div className="card-actions">
          <BookIndexAction book={book} api={api} compact />
          {!book.source && book.status !== "pending" && (
            <button
              className="delete"
              aria-label={`Delete ${book.title}`}
              onClick={(event) => {
                event.preventDefault();
                onDelete(book);
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
    </article>
  );
});
