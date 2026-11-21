import type { ReactNode } from "react";
import { formatBytes, formatCount } from "./format";
import type { DuplicateBook, DuplicateGroup } from "./types";

const SOURCE_FALLBACK = "Added manually";

function Trait({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="dup-trait" role="img" aria-label={label} title={label}>
      {children}
    </span>
  );
}

function BookTraits({ book }: { book: DuplicateBook }) {
  return (
    <span className="dup-traits">
      {book.canonical && <span className="dup-suggested">Suggested</span>}
      {book.hasNotes && (
        <Trait label="Has notes">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
            <path d="M4 2.5h6l2 2v9H4z" />
            <path d="M6 6h4M6 8.5h4M6 11h2" />
          </svg>
        </Trait>
      )}
      {book.hasProgress && (
        <Trait label="Has reading progress">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 4.5V8l2.5 1.5" />
          </svg>
        </Trait>
      )}
      {book.indexed && (
        <Trait label="Indexed for search">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
        </Trait>
      )}
    </span>
  );
}

/**
 * One fieldset per duplicate group: the radios pick the copy to keep. The
 * group title follows the selection so the heading always names the survivor.
 */
export function DuplicateGroupList({
  groups,
  choices,
  onChoose,
  disabled = false,
}: {
  groups: DuplicateGroup[];
  choices: Record<string, string>;
  onChoose: (groupKey: string, bookId: string) => void;
  disabled?: boolean;
}) {
  return (
    <ul className="dup-groups" aria-label="Duplicate groups">
      {groups.map((group) => {
        const chosen = group.books.some((book) => book.id === choices[group.key])
          ? (choices[group.key] as string)
          : group.canonicalId;
        const canonical = group.books.find((book) => book.id === chosen) ?? group.books[0];
        if (!canonical) return null;
        return (
          <li key={group.key}>
            <fieldset className="dup-group" disabled={disabled}>
              <legend className="dup-group-head">
                <span className="dup-group-title">{canonical.title || "Untitled"}</span>
                <span className="dup-group-meta">
                  {formatCount(group.books.length)} {group.books.length === 1 ? "copy" : "copies"} ·{" "}
                  {canonical.format.toUpperCase()} · {formatBytes(group.size)}
                </span>
              </legend>
              <ul className="dup-books">
                {group.books.map((book) => (
                  <li key={book.id}>
                    <label className="dup-book">
                      <input
                        type="radio"
                        name={`canonical-${group.key}`}
                        value={book.id}
                        checked={chosen === book.id}
                        onChange={() => onChoose(group.key, book.id)}
                      />
                      <span className="dup-book-body">
                        <span className="dup-book-title" title={book.title}>
                          {book.title || "Untitled"}
                        </span>
                        <span className="dup-book-meta" title={book.path}>
                          {book.format.toUpperCase()} · {book.sourceLabel || SOURCE_FALLBACK}
                        </span>
                      </span>
                      <BookTraits book={book} />
                    </label>
                  </li>
                ))}
              </ul>
              {group.aliases.length > 0 && (
                <p className="dup-aliases">
                  {formatCount(group.aliases.length)} more {group.aliases.length === 1 ? "file" : "files"} already{" "}
                  {group.aliases.length === 1 ? "points" : "point"} here.
                </p>
              )}
            </fieldset>
          </li>
        );
      })}
    </ul>
  );
}
