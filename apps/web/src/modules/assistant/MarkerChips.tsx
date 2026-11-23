import { Link } from "react-router-dom";
import { bookOpenLabel, shortBookTitle } from "./suggestionText";
import type { Citation, RecommendedBook } from "./types";

export const citationHref = (citation: Citation) =>
  `/read/${encodeURIComponent(citation.bookId)}${citation.page === null ? "" : `?at=${citation.page}`}`;

export function CitationChip({ citation }: { citation: Citation }) {
  return (
    <Link
      className="asst-cite"
      to={citationHref(citation)}
      title={`${citation.bookTitle}${citation.page === null ? "" : `, page ${citation.page}`}`}
      aria-label={`Source ${citation.n}: ${citation.bookTitle}${citation.page === null ? "" : `, page ${citation.page}`}`}
    >
      {citation.n}
    </Link>
  );
}

export function BookChip({ book, onOpenBook }: { book: RecommendedBook; onOpenBook?: () => void }) {
  return (
    <Link
      className="asst-book-chip"
      to={`/book/${encodeURIComponent(book.bookId)}`}
      title={book.title}
      aria-label={bookOpenLabel(book)}
      onClick={onOpenBook}
    >
      {shortBookTitle(book.title)}
    </Link>
  );
}
