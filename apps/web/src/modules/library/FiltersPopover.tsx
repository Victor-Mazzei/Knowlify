import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BookFacets, BookSort, Format, IndexFilter, ReadFilter, Source, TagWithCount } from "../../types";
import { tagColorClass } from "../tags/tagColors";
import {
  INDEX_FILTERS,
  INDEX_OPTION_LABELS,
  READ_FILTERS,
  READ_LABELS,
  activeFilterCount,
  clearFilters,
  formatChecked,
  setFavorite,
  setNotes,
  sourceName,
  toggleFormat,
  toggleIndex,
  toggleRead,
  toggleSource,
  toggleTag,
  type LibraryFilters,
} from "./libraryFilters";

const counts = new Intl.NumberFormat("en-US");
const FORMATS: readonly Format[] = ["pdf", "epub"];

function Option({
  checked,
  count,
  disabled = false,
  onChange,
  children,
}: {
  checked: boolean;
  count?: number;
  disabled?: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`filter-option${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span className="filter-option-label">{children}</span>
      {/* Keep a text separator so assistive tech announces "PDF 4", not "PDF4". */}
      {typeof count === "number" && (
        <>
          {" "}
          <span className="filter-count">{counts.format(count)}</span>
        </>
      )}
    </label>
  );
}

const zeroUnlessChecked = (count: number | undefined, checked: boolean) => count === 0 && !checked;

export function FiltersPopover({
  filters,
  facets,
  sources,
  tags = [],
  sort,
  onChange,
}: {
  filters: LibraryFilters;
  facets: BookFacets | null;
  sources: Source[];
  tags?: TagWithCount[];
  sort: BookSort;
  onChange: (next: LibraryFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const active = activeFilterCount(filters);
  const indexCounts = facets?.index ?? null;
  const tagCounts = new Map((facets?.tag ?? []).map((entry) => [entry.id, entry.count]));
  const needle = tagSearch.trim().toLocaleLowerCase();
  const visibleTags = needle ? tags.filter((tag) => tag.name.toLocaleLowerCase().includes(needle)) : tags;

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    // Focus the first available group, skipping disabled zero-count options.
    panelRef.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="filters">
      <button
        ref={triggerRef}
        type="button"
        className="ghost bordered filters-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={active > 0 ? `Filters, ${active} active` : "Filters"}
        onClick={() => setOpen((value) => !value)}
      >
        Filters
        {active > 0 && (
          <span className="filter-badge" aria-hidden="true">
            {active}
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} ref={panelRef} className="filters-panel" role="group" aria-label="Filters">
          <div className="filters-head">
            <strong>Filters</strong>
            <button type="button" className="ghost filters-close" aria-label="Close filters" onClick={() => close(true)}>
              ×
            </button>
          </div>
          <div className="filters-body">
            <fieldset className="filter-group">
              <legend>Format</legend>
              {FORMATS.map((format) => {
                const checked = formatChecked(filters, format);
                return (
                  <Option
                    key={format}
                    checked={checked}
                    count={facets?.format[format]}
                    disabled={zeroUnlessChecked(facets?.format[format], checked)}
                    onChange={() => onChange(toggleFormat(filters, format))}
                  >
                    {format.toUpperCase()}
                  </Option>
                );
              })}
            </fieldset>
            <fieldset className="filter-group">
              <legend>Reading</legend>
              {READ_FILTERS.map((read: ReadFilter) => {
                const checked = filters.read.includes(read);
                return (
                  <Option
                    key={read}
                    checked={checked}
                    count={facets?.read[read]}
                    disabled={zeroUnlessChecked(facets?.read[read], checked) || (sort === "lastRead" && read === "unread")}
                    onChange={() => onChange(toggleRead(filters, read))}
                  >
                    {READ_LABELS[read]}
                  </Option>
                );
              })}
            </fieldset>
            {indexCounts && (
              <fieldset className="filter-group">
                <legend>Indexing</legend>
                {INDEX_FILTERS.map((index: IndexFilter) => {
                  const checked = filters.index.includes(index);
                  return (
                    <Option
                      key={index}
                      checked={checked}
                      count={indexCounts[index]}
                      disabled={zeroUnlessChecked(indexCounts[index], checked)}
                      onChange={() => onChange(toggleIndex(filters, index))}
                    >
                      {INDEX_OPTION_LABELS[index]}
                    </Option>
                  );
                })}
              </fieldset>
            )}
            <fieldset className="filter-group">
              <legend>Folder</legend>
              <div className="filter-source-list">
                {(facets?.source ?? []).map((entry) => {
                  const checked = filters.source.includes(entry.id);
                  return (
                    <Option
                      key={entry.id}
                      checked={checked}
                      count={entry.count}
                      disabled={zeroUnlessChecked(entry.count, checked)}
                      onChange={() => onChange(toggleSource(filters, entry.id))}
                    >
                      {sourceName(entry.id, sources)}
                    </Option>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="filter-group">
              <legend>Notes</legend>
              <Option
                checked={filters.notes}
                count={facets?.notes.with}
                disabled={zeroUnlessChecked(facets?.notes.with, filters.notes)}
                onChange={() => onChange(setNotes(filters, !filters.notes))}
              >
                With notes
              </Option>
            </fieldset>
            {facets?.favorite && (
              <fieldset className="filter-group">
                <legend>Collection</legend>
                <Option
                  checked={filters.favorite}
                  count={facets.favorite.with}
                  disabled={zeroUnlessChecked(facets.favorite.with, filters.favorite)}
                  onChange={() => onChange(setFavorite(filters, !filters.favorite))}
                >
                  Favorites
                </Option>
              </fieldset>
            )}
            {tags.length > 0 && (
              <fieldset className="filter-group">
                <legend>Tags</legend>
                {tags.length > 8 && (
                  <input
                    className="filter-tag-search"
                    type="search"
                    aria-label="Search tags"
                    placeholder="Search tags"
                    value={tagSearch}
                    onChange={(event) => setTagSearch(event.target.value)}
                  />
                )}
                <div className="filter-tag-list">
                  {visibleTags.map((tag) => {
                    const count = tagCounts.get(tag.id) ?? 0;
                    const checked = filters.tag.includes(tag.id);
                    return (
                      <Option
                        key={tag.id}
                        checked={checked}
                        count={count}
                        disabled={zeroUnlessChecked(count, checked)}
                        onChange={() => onChange(toggleTag(filters, tag.id))}
                      >
                        <span className={`tag-dot ${tagColorClass(tag.color)}`} aria-hidden="true" />
                        {tag.name}
                      </Option>
                    );
                  })}
                  {visibleTags.length === 0 && <p className="muted filter-tag-empty">No tags match.</p>}
                </div>
                <Link className="filter-tag-manage" to="/settings/tags">
                  Manage tags
                </Link>
              </fieldset>
            )}
          </div>
          <div className="filters-footer">
            <button type="button" className="ghost" disabled={active === 0} onClick={() => onChange(clearFilters())}>
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
