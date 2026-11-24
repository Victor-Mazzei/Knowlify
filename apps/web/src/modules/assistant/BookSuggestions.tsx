import { Link } from "react-router-dom";
import type { ApiFn } from "../../components/dialogs";
import { useCover } from "../library/useCoverQueue";
import { bookOpenLabel, matchesLabel, readingLabel } from "./suggestionText";
import type { ChatRecommendations, RecommendedBook } from "./types";
import "./suggestions.css";

function SuggestionCover({ book, api }: { book: RecommendedBook; api: ApiFn }) {
  const url = useCover(
    { id: book.bookId, hasCover: book.hasCover, status: "ready", coverRev: book.coverRev },
    api,
  );
  return url ? (
    <img className="asst-suggestion-cover" src={url} alt="" loading="lazy" decoding="async" />
  ) : (
    <span className="asst-suggestion-cover placeholder" aria-hidden="true">
      {book.format.toUpperCase()}
    </span>
  );
}

function SuggestionCard({
  book,
  api,
  onOpenBook,
}: {
  book: RecommendedBook;
  api: ApiFn;
  onOpenBook?: () => void;
}) {
  return (
    <li className="asst-suggestion">
      <SuggestionCover book={book} api={api} />
      <div className="asst-suggestion-body">
        <Link
          className="asst-suggestion-title"
          to={`/book/${encodeURIComponent(book.bookId)}`}
          aria-label={bookOpenLabel(book)}
          title={book.title}
          onClick={onOpenBook}
        >
          {book.title}
        </Link>
        <p className="asst-suggestion-author">{book.author || "Unknown author"}</p>
        <p className="asst-suggestion-meta">
          <span>{book.format.toUpperCase()}</span>
          <span className="asst-suggestion-state">{readingLabel(book.progress)}</span>
        </p>
        <p className="asst-suggestion-match">{matchesLabel(book)}</p>
      </div>
    </li>
  );
}

/**
 * The cards under an Ask answer. They are rendered only from `done.recommended`,
 * so a failed, stopped or still streaming turn never shows one; the payload only
 * exists once the turn reached `done`.
 */
export function BookSuggestions({
  recommendations,
  recommended,
  api,
  useLibrary,
  onEnableLibrary,
  onOpenBook,
}: {
  recommendations?: ChatRecommendations;
  recommended?: number[];
  api: ApiFn;
  /** Ask switch state: the "Turn on Search my books" action is hidden when it is already on. */
  useLibrary: boolean;
  onEnableLibrary?: () => void;
  onOpenBook?: () => void;
}) {
  if (!recommendations) return null;

  if (recommendations.status === "unavailable") {
    return (
      <p className="asst-suggestions-unavailable" role="status">
        Book suggestions are not available right now.
      </p>
    );
  }

  if (recommendations.status === "library_off") {
    return (
      <div className="asst-suggestions-off" role="status">
        <p>Book suggestions need Search my books.</p>
        {!useLibrary && onEnableLibrary && (
          <button type="button" className="ghost bordered" onClick={onEnableLibrary}>
            Turn on Search my books
          </button>
        )}
      </div>
    );
  }

  if (recommendations.status !== "ready" || !recommended?.length) return null;

  const byNumber = new Map(recommendations.books.map((book) => [book.n, book]));
  const seen = new Set<number>();
  const books: RecommendedBook[] = [];
  for (const n of recommended) {
    if (seen.has(n)) continue;
    seen.add(n);
    const book = byNumber.get(n);
    if (book) books.push(book);
  }
  if (books.length === 0) return null;

  return (
    <div className="asst-suggestions">
      <p className="asst-suggestions-context">
        {recommendations.intent === "detected"
          ? "You asked for books, so I looked in your library."
          : "Books from your library."}
      </p>
      <ul className="asst-suggestion-list" aria-label="Books from your library">
        {books.map((book) => (
          <SuggestionCard key={book.n} book={book} api={api} onOpenBook={onOpenBook} />
        ))}
      </ul>
      <p className="asst-suggestions-foot">Cards show books from your library.</p>
    </div>
  );
}
