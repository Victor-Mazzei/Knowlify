import { Link } from "react-router-dom";
import { Logo } from "../../components/Logo";
import type { BookSort } from "../../types";

/** Directions for the three empty results: filters, search and a truly empty library. */
export function LibraryEmptyState({
  activeFilters,
  query,
  sort,
  onClearFilters,
}: {
  activeFilters: number;
  query: string;
  sort: BookSort;
  onClearFilters: () => void;
}) {
  const title = activeFilters
    ? "No books match these filters."
    : query
      ? "No matching books."
      : sort === "lastRead"
        ? "No books with reading progress yet."
        : "Your library is empty.";
  const hint = activeFilters
    ? "Remove a filter or clear them to see more titles."
    : query
      ? "Try another title or author."
      : sort === "lastRead"
        ? "Open a book to start tracking it."
        : "Add a PDF or EPUB, or add a library folder.";
  const isEmptyLibrary = activeFilters === 0 && !query && sort !== "lastRead";
  return (
    <div className="empty">
      {isEmptyLibrary && (
        // The mark is part of the first empty render (inline SVG, no async load),
        // so it cannot shift the copy after paint. Inline layout keeps the shared
        // empty-state CSS untouched.
        <span style={{ alignSelf: "center", marginBottom: "var(--space-2)" }}>
          <Logo size={48} variant="mono" />
        </span>
      )}
      <strong>{title}</strong>
      <span>{hint}</span>
      {activeFilters > 0 && (
        <button className="ghost bordered empty-action" onClick={onClearFilters}>
          Clear filters
        </button>
      )}
      {isEmptyLibrary && (
        <Link className="ghost bordered empty-action" to="/settings/folders">
          Add a library folder
        </Link>
      )}
    </div>
  );
}
