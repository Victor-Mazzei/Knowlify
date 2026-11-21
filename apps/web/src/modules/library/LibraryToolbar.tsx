import type { BookFacets, BookSort, Source, TagWithCount } from "../../types";
import type { LibraryView } from "../settings/preferences";
import { AddBookButton } from "./AddBookButton";
import { FiltersPopover } from "./FiltersPopover";
import type { LibraryFilters } from "./libraryFilters";

export function LibraryToolbar({
  query,
  onQueryChange,
  available,
  filtersPending,
  filters,
  facets,
  sources,
  tags = [],
  sort,
  onSortChange,
  onFiltersChange,
  view,
  onViewChange,
  uploading,
  onUpload,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  available: boolean;
  /** Facets are still being probed; reserve the Filters control's space. */
  filtersPending: boolean;
  filters: LibraryFilters;
  facets: BookFacets | null;
  sources: Source[];
  tags?: TagWithCount[];
  sort: BookSort;
  onSortChange: (sort: BookSort) => void;
  onFiltersChange: (filters: LibraryFilters) => void;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="toolbar">
      <label className="search">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="Search titles or authors"
          placeholder="Search titles or authors"
          maxLength={200}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      {available ? (
        <FiltersPopover filters={filters} facets={facets} sources={sources} tags={tags} sort={sort} onChange={onFiltersChange} />
      ) : filtersPending ? (
        <span className="filters-trigger filters-slot" aria-hidden="true">
          Filters
        </span>
      ) : null}
      <label className="sort-control">
        <span className="visually-hidden">Sort books</span>
        <select aria-label="Sort books" value={sort} onChange={(event) => onSortChange(event.target.value as BookSort)}>
          <option value="reading">Reading</option>
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          {available && <option value="lastRead">Last read</option>}
          {available && <option value="author">Author</option>}
        </select>
      </label>
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={view === "grid"} onClick={() => onViewChange("grid")}>
          Grid
        </button>
        <button aria-pressed={view === "table"} onClick={() => onViewChange("table")}>
          Table
        </button>
      </div>
      <AddBookButton onUpload={onUpload} busy={uploading} />
    </div>
  );
}
