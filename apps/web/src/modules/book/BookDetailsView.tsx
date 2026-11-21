import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { FavoriteButton } from "../../components/ui/FavoriteButton";
import { useFavorite } from "../favorites/useFavorite";
import { BookIndexAction } from "../indexing/BookIndexAction";
import { BookIndexNote } from "../indexing/BookIndexNote";
import { ProgressBar } from "../library/ProgressBar";
import { readingStatusOf } from "../library/readingStatus";
import { useCover } from "../library/useCoverQueue";
import { BookDetailsNotes } from "./BookDetailsNotes";
import { BookDetailsTags } from "./BookDetailsTags";
import type { BookDetail, MetadataSource } from "./types";
import type { MetadataCapability } from "./useMetadataCapability";

const SOURCE_LABELS: Record<MetadataSource, string> = {
  manual: "Edited manually",
  googlebooks: "Google Books",
  openlibrary: "Open Library",
};

const addedLabel = (value: number | string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

const readAction = (status: ReturnType<typeof readingStatusOf>) => {
  if (status === "finished") return "Read again";
  return status === "reading" ? "Continue" : "Start reading";
};

export function BookDetailsView({
  book,
  api,
  capability,
  readHref,
  onBookChange,
  onEdit,
  onFind,
  onDelete,
}: {
  book: BookDetail;
  api: ApiFn;
  capability: MetadataCapability;
  readHref: string;
  onBookChange: (next: BookDetail) => void;
  onEdit: () => void;
  onFind: () => void;
  onDelete: () => void;
}) {
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cover = useCover(book, api, "full");
  const favorite = useFavorite(api, book.id, book.favorite);
  const [announcement, setAnnouncement] = useState("");
  const [expanded, setExpanded] = useState(false);
  const firstFavorite = useRef(true);
  const latestBook = useRef(book);
  latestBook.current = book;
  const status = readingStatusOf(book.progress?.percentage);
  const metadata = book.metadata;
  const edited = Object.values(metadata.overridden).some(Boolean);
  const isbn = metadata.isbn13 ?? metadata.isbn10;
  const description = metadata.description ?? "";
  const longDescription = description.length > 420;
  const series = metadata.series
    ? `${metadata.series}${metadata.seriesIndex !== null ? ` · Book ${metadata.seriesIndex}` : ""}`
    : "";
  const facts = [
    { label: "Format", value: book.format.toUpperCase() },
    { label: "Size", value: `${(book.size / 1024 / 1024).toFixed(1)} MB` },
    { label: "Added", value: addedLabel(book.addedAt) },
    { label: "Source", value: book.source ? "Library folder" : "Upload" },
    ...(metadata.year !== null ? [{ label: "Year", value: String(metadata.year) }] : []),
    ...(metadata.publisher ? [{ label: "Publisher", value: metadata.publisher }] : []),
    ...(metadata.language ? [{ label: "Language", value: metadata.language.toUpperCase() }] : []),
    ...(isbn ? [{ label: "ISBN", value: isbn }] : []),
  ];

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [book.id]);

  useEffect(() => {
    if (firstFavorite.current) {
      firstFavorite.current = false;
      return;
    }
    setAnnouncement(favorite.favorite ? "Added to favorites." : "Removed from favorites.");
    // Keep the page's copy in sync so a later tag edit does not resend the old flag.
    if (latestBook.current.favorite !== favorite.favorite) {
      onBookChange({ ...latestBook.current, favorite: favorite.favorite });
    }
  }, [favorite.favorite, onBookChange]);

  return (
    <article className="book-details-grid">
      <div className="book-details-cover">
        <div className="book-details-cover-frame">
          {cover ? (
            <img
              className="book-details-cover-image"
              src={cover}
              alt={`Cover of ${book.title}`}
              decoding="async"
            />
          ) : (
            <div
              className="book-details-cover-placeholder"
              aria-label={`${book.format.toUpperCase()} cover unavailable`}
            >
              <span aria-hidden="true">{book.format.toUpperCase()}</span>
            </div>
          )}
        </div>
      </div>

      <div className="book-details-body">
        <div className="book-details-head">
          <h1 ref={headingRef} tabIndex={-1}>
            {book.title}
          </h1>
          <p className="book-details-author">{book.author || "Unknown author"}</p>
          {series && <p className="book-details-series">{series}</p>}
          {edited && (
            <p className="book-details-edited">
              <span className="book-details-badge">Edited</span>
              {metadata.source && metadata.source !== "manual" && (
                <span>from {SOURCE_LABELS[metadata.source]}</span>
              )}
            </p>
          )}
          <div className="book-details-primary">
            <Link className="primary book-details-read" to={readHref}>
              {readAction(status)}
            </Link>
            <FavoriteButton
              favorite={favorite.favorite}
              onToggle={() => void favorite.toggle()}
              bookTitle={book.title}
              showLabel
              disabled={favorite.pending}
              className="book-details-favorite"
            />
          </div>
          <div className="book-details-progress">
            {status === "unread" ? (
              <p className="muted">Not started</p>
            ) : (
              <ProgressBar percentage={book.progress?.percentage} />
            )}
          </div>
          <span role="status" aria-live="polite" className="visually-hidden">
            {announcement}
          </span>
          {favorite.error && (
            <p className="error book-details-favorite-error" role="alert">
              {favorite.error}
            </p>
          )}
          {book.index && (
            <div className="book-details-index">
              <BookIndexNote book={book} />
              <BookIndexAction book={book} api={api} />
            </div>
          )}
        </div>

        {description && (
          <section className="book-details-section book-details-description" aria-labelledby={descriptionId}>
            <h2 id={descriptionId}>Description</h2>
            <p className={`book-details-description-text${longDescription && !expanded ? " is-clamped" : ""}`}>
              {description}
            </p>
            {longDescription && (
              <button
                type="button"
                className="ghost bordered book-details-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </section>
        )}

        <section className="book-details-section book-details-facts-section" aria-label="Book details">
          <ul className="book-details-facts">
            {facts.map((fact) => (
              <li key={fact.label} className="book-details-fact">
                <span className="book-details-fact-label">{fact.label}</span>
                <span className="book-details-fact-value">{fact.value}</span>
              </li>
            ))}
          </ul>
        </section>

        <BookDetailsTags book={book} api={api} onChange={onBookChange} />
        <BookDetailsNotes api={api} bookId={book.id} />

        <div className="book-details-actions" role="group" aria-label="Book actions">
          {capability.available && (
            <button type="button" className="ghost bordered" onClick={onEdit}>
              Edit metadata
            </button>
          )}
          {capability.available && capability.lookupEnabled && (
            <button type="button" className="ghost bordered" onClick={onFind}>
              Search online
            </button>
          )}
          <button type="button" className="ghost danger-action" onClick={onDelete}>
            Delete book
          </button>
        </div>
      </div>
    </article>
  );
}
