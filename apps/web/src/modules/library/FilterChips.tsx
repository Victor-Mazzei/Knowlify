import type { Source, TagWithCount } from "../../types";
import { clearFilters, filterChips, type LibraryFilters } from "./libraryFilters";

export function FilterChips({
  filters,
  sources,
  tags = [],
  onChange,
}: {
  filters: LibraryFilters;
  sources: Source[];
  tags?: TagWithCount[];
  onChange: (next: LibraryFilters) => void;
}) {
  const chips = filterChips(filters, sources, tags);
  if (chips.length === 0) return null;
  return (
    <div className="filter-chips" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="filter-chip"
          aria-label={`Remove filter: ${chip.label}`}
          onClick={() => onChange(chip.next)}
        >
          <span>{chip.label}</span>
          <span aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="ghost filter-clear" onClick={() => onChange(clearFilters())}>
        Clear filters
      </button>
    </div>
  );
}
