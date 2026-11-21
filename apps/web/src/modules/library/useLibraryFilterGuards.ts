import { useEffect } from "react";
import type { BookSort } from "../../types";
import type { LibraryFilters, LibrarySearchState } from "./libraryFilters";

/**
 * Keeps the URL filters compatible with what the current server and sort can
 * actually show: unknown tag ids are dropped and `lastRead` never asks for
 * "Not started" (the two are contradictory).
 */
export function useLibraryFilterGuards({
  available,
  favoritesAvailable,
  selectable,
  tagsLoading,
  tags,
  visibleTags,
  rawFilters,
  sort,
  updateSearch,
}: {
  /** Facets have answered; only then can unsupported dimensions be recognised. */
  available: boolean;
  favoritesAvailable: boolean;
  selectable: boolean;
  tagsLoading: boolean;
  tags: readonly { id: string }[];
  /** Effective tags sent to the list (already empty when unsupported). */
  visibleTags: string[];
  /** URL filters, the source for the rewritten query. */
  rawFilters: LibraryFilters;
  sort: BookSort;
  updateSearch: (changes: Partial<LibrarySearchState>, replace: boolean) => void;
}) {
  useEffect(() => {
    if (!selectable || tagsLoading) return;
    const known = new Set(tags.map((tag) => tag.id));
    const kept = visibleTags.filter((id) => known.has(id));
    if (kept.length === visibleTags.length) return;
    updateSearch({ filters: { ...rawFilters, tag: kept } }, true);
  }, [rawFilters, selectable, tags, tagsLoading, updateSearch, visibleTags]);

  useEffect(() => {
    if (!available || favoritesAvailable || !rawFilters.favorite) return;
    updateSearch({ filters: { ...rawFilters, favorite: false } }, true);
  }, [available, favoritesAvailable, rawFilters, updateSearch]);

  useEffect(() => {
    if (sort !== "lastRead" || !rawFilters.read.includes("unread")) return;
    updateSearch(
      { filters: { ...rawFilters, read: rawFilters.read.filter((value) => value !== "unread") } },
      true,
    );
  }, [rawFilters, sort, updateSearch]);
}
