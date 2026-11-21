import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import type { BookSort } from "../../types";
import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  buildLibrarySearch,
  filtersKey as filtersKeyOf,
  isExtendedSort,
  orderForSort,
  parseExplicitBookSort,
  type LibraryFilters,
  type LibrarySearchState,
} from "./libraryFilters";
import { readLibrarySort, saveLibrarySort } from "../settings/preferences";

export type LibraryQueryState = {
  search: LibrarySearchState;
  explicitSort: BookSort | null;
  resolvedSort: BookSort;
  sort: BookSort;
  toolbarSort: BookSort;
  filters: LibraryFilters;
  order: ReturnType<typeof orderForSort>;
  listIdentity: string;
  updateSearch: (changes: Partial<LibrarySearchState>, replace: boolean) => void;
  changeSort: (next: BookSort) => void;
  changeFilters: (next: LibraryFilters) => void;
};

/**
 * URL-backed query state with the default sort resolved synchronously. The saved
 * sort seeds only the first entry; later history entries are owned by the URL.
 * `available` is the facets probe: it decides whether extended sorts can reach
 * the server and whether the unsupported filter dimensions are dropped.
 */
export function useLibraryQueryState({
  search,
  searchKey,
  searchParams,
  setSearchParams,
  available,
  unavailable,
  indexEnabled,
  selectable,
  favoritesAvailable,
}: {
  search: LibrarySearchState;
  searchKey: string;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  available: boolean;
  /** Confirmed older server: only then does the control stop offering `reading`. */
  unavailable: boolean;
  indexEnabled: boolean;
  selectable: boolean;
  /** Facets carry `favorite` only after the favorites contract. */
  favoritesAvailable: boolean;
}): LibraryQueryState {
  const [initialSort] = useState<BookSort | null>(() =>
    parseExplicitBookSort(searchParams) === null ? readLibrarySort() : null,
  );
  const initialSearchKey = useRef(searchKey);
  const leftInitialEntry = useRef(false);
  if (searchKey !== initialSearchKey.current) leftInitialEntry.current = true;
  const explicitSort = useMemo(() => parseExplicitBookSort(searchKey), [searchKey]);
  const resolvedSort = explicitSort ?? (leftInitialEntry.current ? DEFAULT_SORT : initialSort ?? DEFAULT_SORT);
  const sort = available ? resolvedSort : isExtendedSort(resolvedSort) ? "added" : resolvedSort;
  // Keep the control honest without flipping through a bogus value while the
  // facets probe is still in flight: only a confirmed old server loses `reading`.
  const toolbarSort = unavailable && isExtendedSort(resolvedSort) ? "added" : resolvedSort;

  useEffect(() => {
    if (explicitSort !== null) saveLibrarySort(explicitSort);
  }, [explicitSort]);

  // Once the server confirms facets, materialize the initial preference so the URL
  // itself is deterministic for sharing, back and forward.
  const materializedInitialSort = useRef(false);
  useEffect(() => {
    if (materializedInitialSort.current || !available) return;
    materializedInitialSort.current = true;
    if (leftInitialEntry.current || initialSort === null || initialSort === DEFAULT_SORT || explicitSort !== null) return;
    setSearchParams(
      buildLibrarySearch(
        { query: search.query, sort: initialSort, filters: search.filters },
        { explicitSort: true },
      ),
      { replace: true },
    );
  }, [available, explicitSort, initialSort, search.filters, search.query, setSearchParams]);

  const filters = useMemo(() => {
    if (!available) return EMPTY_FILTERS;
    const indexed = indexEnabled ? search.filters : { ...search.filters, index: [] };
    const supported = favoritesAvailable ? indexed : { ...indexed, favorite: false };
    const base = selectable ? supported : { ...supported, tag: [] };
    return sort === "lastRead" && base.read.includes("unread")
      ? { ...base, read: base.read.filter((value) => value !== "unread") }
      : base;
  }, [available, favoritesAvailable, indexEnabled, search.filters, selectable, sort]);
  const order = orderForSort(sort);
  // Every input that defines the list belongs here: a new result set remounts the
  // virtualized list (fresh window offsets) and returns the page to the top.
  const listIdentity = `${filtersKeyOf(filters)}|${sort}|${order}|${search.query}`;

  const updateSearch = useCallback(
    (changes: Partial<LibrarySearchState>, replace: boolean) => {
      // Before facets are known the URL may not carry an extended sort, because an
      // older server would reject it; keep the effective sort instead.
      const fallbackSort = available || !isExtendedSort(resolvedSort) ? resolvedSort : search.sort;
      const nextSort = changes.sort ?? fallbackSort;
      // Only the untouched initial entry may omit `sort`. Every entry created by an
      // interaction keeps its sort explicit, including `added`.
      const explicit = changes.sort !== undefined || explicitSort !== null || nextSort !== DEFAULT_SORT;
      const next = buildLibrarySearch(
        {
          query: changes.query ?? search.query,
          sort: nextSort,
          filters: changes.filters ?? search.filters,
        },
        { explicitSort: explicit },
      );
      setSearchParams(next, { replace });
    },
    [available, explicitSort, resolvedSort, search.filters, search.query, search.sort, setSearchParams],
  );

  const changeSort = useCallback(
    (next: BookSort) => {
      saveLibrarySort(next);
      const nextFilters =
        next === "lastRead" && filters.read.includes("unread")
          ? { ...filters, read: filters.read.filter((value) => value !== "unread") }
          : filters;
      updateSearch({ sort: next, filters: nextFilters }, false);
    },
    [filters, updateSearch],
  );

  const changeFilters = useCallback((next: LibraryFilters) => updateSearch({ filters: next }, false), [updateSearch]);

  return {
    search,
    explicitSort,
    resolvedSort,
    sort,
    toolbarSort,
    filters,
    order,
    listIdentity,
    updateSearch,
    changeSort,
    changeFilters,
  };
}
