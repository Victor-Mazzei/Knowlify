import { useCallback, useMemo, useState } from "react";
import type { BookSelection, BookSelectionFilter } from "../../../types";

export type SelectionModifiers = { shift?: boolean; meta?: boolean };

type SelectionState = {
  ids: Set<string>;
  anchorId: string | null;
  /** Set while "select all N results" is active; the filter is re-evaluated server-side. */
  all: { filterKey: string; total: number } | null;
};

export type Selection = {
  ids: ReadonlySet<string>;
  anchorId: string | null;
  all: { filterKey: string; total: number } | null;
  /** Distinct selection size; in all-mode it is the server total. */
  count: number;
  empty: boolean;
  isSelected: (id: string) => boolean;
  /** Plain, Ctrl/Cmd and Shift clicks. `orderedIds` are the currently displayed ids. */
  toggle: (id: string, modifiers?: SelectionModifiers, orderedIds?: readonly string[]) => void;
  toggleLoaded: (loadedIds: readonly string[], filterKey: string, total: number) => void;
  selectAllResults: (filterKey: string, total: number) => void;
  /** Replaces the id set, used when a partial deletion leaves a known remainder. */
  replace: (ids: readonly string[]) => void;
  clear: () => void;
};

const EMPTY = new Set<string>();

export function rangeBetween(ordered: readonly string[], from: string, to: string): string[] {
  const start = ordered.indexOf(from);
  const end = ordered.indexOf(to);
  if (start === -1 || end === -1) return [to];
  const [low, high] = start < end ? [start, end] : [end, start];
  return ordered.slice(low, high + 1);
}

/**
 * Selection keyed by book id, independent of the virtualizer. Rows may enter and
 * leave the DOM while the person scrolls or loads another page; the set does not.
 */
export function useSelection(): Selection {
  const [state, setState] = useState<SelectionState>({ ids: new Set(), anchorId: null, all: null });

  const toggle = useCallback((id: string, modifiers: SelectionModifiers = {}, orderedIds: readonly string[] = []) => {
    setState((current) => {
      // A concrete row click always leaves the server-side "everything" mode.
      if (current.all) return { ids: new Set([id]), anchorId: id, all: null };
      const ids = new Set(current.ids);
      if (modifiers.shift && current.anchorId !== null) {
        for (const rangeId of rangeBetween(orderedIds, current.anchorId, id)) ids.add(rangeId);
        return { ids, anchorId: current.anchorId, all: null };
      }
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchorId: id, all: null };
    });
  }, []);

  const toggleLoaded = useCallback((loadedIds: readonly string[], filterKey: string, total: number) => {
    setState((current) => {
      if (current.all) return { ids: new Set(), anchorId: null, all: null };
      const everyLoaded = loadedIds.length > 0 && loadedIds.every((id) => current.ids.has(id));
      const ids = new Set(current.ids);
      for (const id of loadedIds) {
        if (everyLoaded) ids.delete(id);
        else ids.add(id);
      }
      return { ids, anchorId: null, all: null };
    });
  }, []);

  const selectAllResults = useCallback((filterKey: string, total: number) => {
    setState({ ids: new Set(), anchorId: null, all: { filterKey, total } });
  }, []);

  const replace = useCallback((nextIds: readonly string[]) => {
    setState({ ids: new Set(nextIds), anchorId: null, all: null });
  }, []);

  const clear = useCallback(() => setState({ ids: new Set(), anchorId: null, all: null }), []);

  const ids: ReadonlySet<string> = state.all ? EMPTY : state.ids;
  const count = state.all ? state.all.total : state.ids.size;
  const isSelected = useCallback(
    (id: string) => (state.all ? true : state.ids.has(id)),
    [state.all, state.ids],
  );

  return useMemo(
    () => ({
      ids,
      anchorId: state.anchorId,
      all: state.all,
      count,
      empty: count === 0,
      isSelected,
      toggle,
      toggleLoaded,
      selectAllResults,
      replace,
      clear,
    }),
    [clear, count, ids, isSelected, replace, selectAllResults, state.all, state.anchorId, toggle, toggleLoaded],
  );
}

/** Payload for the bulk endpoints; null when nothing is selected. */
export function toBookSelection(selection: Selection, filter: BookSelectionFilter | null): BookSelection | null {
  if (selection.all) {
    return filter ? { filter, expectedTotal: selection.all.total } : null;
  }
  if (selection.ids.size === 0) return null;
  return { ids: [...selection.ids] };
}
