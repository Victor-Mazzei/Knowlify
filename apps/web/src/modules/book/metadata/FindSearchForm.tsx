import type { FormEvent, RefObject } from "react";

export type SearchMode = "isbn" | "title";

/** The explicit, pre-search half of the lookup dialog: mode, query and privacy notice. */
export function FindSearchForm({
  mode,
  onMode,
  isbn,
  title,
  author,
  isbnRef,
  titleRef,
  queryError,
  searching,
  applying,
  onIsbn,
  onTitle,
  onAuthor,
  onSubmit,
}: {
  mode: SearchMode;
  onMode: (mode: SearchMode) => void;
  isbn: string;
  title: string;
  author: string;
  isbnRef: RefObject<HTMLInputElement>;
  titleRef: RefObject<HTMLInputElement>;
  queryError: string;
  searching: boolean;
  applying: boolean;
  onIsbn: (value: string) => void;
  onTitle: (value: string) => void;
  onAuthor: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="metadata-search"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="seg metadata-mode" role="group" aria-label="Search by">
        <button type="button" aria-pressed={mode === "isbn"} disabled={applying} onClick={() => onMode("isbn")}>
          ISBN
        </button>
        <button type="button" aria-pressed={mode === "title"} disabled={applying} onClick={() => onMode("title")}>
          Title and author
        </button>
      </div>
      {mode === "isbn" ? (
        <div className="metadata-field">
          <label htmlFor="find-metadata-isbn">ISBN</label>
          <input
            ref={isbnRef}
            id="find-metadata-isbn"
            value={isbn}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={queryError ? true : undefined}
            aria-describedby={queryError ? "find-metadata-query-error" : undefined}
            onChange={(event) => onIsbn(event.target.value)}
          />
        </div>
      ) : (
        <div className="metadata-search-pair">
          <div className="metadata-field">
            <label htmlFor="find-metadata-title">Title</label>
            <input
              ref={titleRef}
              id="find-metadata-title"
              value={title}
              maxLength={200}
              autoComplete="off"
              aria-invalid={queryError ? true : undefined}
              aria-describedby={queryError ? "find-metadata-query-error" : undefined}
              onChange={(event) => onTitle(event.target.value)}
            />
          </div>
          <div className="metadata-field">
            <label htmlFor="find-metadata-author">Author</label>
            <input
              id="find-metadata-author"
              value={author}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => onAuthor(event.target.value)}
            />
          </div>
        </div>
      )}
      <p className="metadata-privacy">
        When you search, the title, author and ISBN in this form are sent to Open Library and, only if it finds nothing or fails, to Google Books.
        Nothing is sent until you press Search.
      </p>
      {queryError && (
        <p className="metadata-field-error" id="find-metadata-query-error" role="alert">
          {queryError}
        </p>
      )}
      <button type="submit" className="primary metadata-search-button" disabled={searching || applying}>
        {searching ? "Searching…" : "Search online"}
      </button>
    </form>
  );
}
