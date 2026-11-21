import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { formatError } from "../../services/api";
import { deleteNote, loadBookNotes, loadNoteFeed } from "./notesApi";
import type { Note, NoteGroup, NoteGroupsPage, NoteGroupStatus } from "./types";

type FeedState = {
  mode: "groups" | "legacy";
  groups: NoteGroup[];
  flatNotes: Note[];
  totalBooks: number;
  totalNotes: number;
  nextCursor: string | null;
};

const EMPTY: FeedState = {
  mode: "groups",
  groups: [],
  flatNotes: [],
  totalBooks: 0,
  totalNotes: 0,
  nextCursor: null,
};

const withoutDeleted = (notes: Note[], deleted: Set<string>) =>
  notes.filter((note) => !deleted.has(note.id));

/** Drops notes deleted in this session from a fresh server snapshot. */
function pruneGroups(groups: NoteGroup[], deleted: Set<string>) {
  let removedGroups = 0;
  let removedNotes = 0;
  const kept = groups.flatMap((group) => {
    const hidden = group.notes.filter((note) => deleted.has(note.id)).length;
    if (!hidden) return [group];
    removedNotes += hidden;
    const notes = group.notes.filter((note) => !deleted.has(note.id));
    const noteCount = Math.max(0, group.noteCount - hidden);
    if (!noteCount) {
      removedGroups += 1;
      return [];
    }
    return [{ ...group, notes, noteCount, hasMore: noteCount > notes.length }];
  });
  return { groups: kept, removedGroups, removedNotes };
}

function applyGroups(page: NoteGroupsPage, deleted: Set<string>): FeedState {
  const pruned = pruneGroups(page.items, deleted);
  return {
    mode: "groups",
    groups: pruned.groups,
    flatNotes: [],
    totalBooks: Math.max(0, page.totalBooks - pruned.removedGroups),
    totalNotes: Math.max(0, page.totalNotes - pruned.removedNotes),
    nextCursor: page.nextCursor,
  };
}

function applyLegacy(notes: Note[], deleted: Set<string>): FeedState {
  const visible = withoutDeleted(notes, deleted);
  return {
    mode: "legacy",
    groups: [],
    flatNotes: visible,
    totalBooks: 0,
    totalNotes: visible.length,
    nextCursor: null,
  };
}

function appendGroups(current: NoteGroup[], page: NoteGroupsPage, deleted: Set<string>) {
  const pruned = pruneGroups(page.items, deleted);
  const known = new Set(current.map((group) => group.book.id));
  return [...current, ...pruned.groups.filter((group) => !known.has(group.book.id))];
}

export function useNoteGroups(api: ApiFn, query: string) {
  const [state, setState] = useState<FeedState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [groupStatus, setGroupStatus] = useState<Record<string, NoteGroupStatus>>({});
  const deleted = useRef(new Set<string>());
  const generation = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    setGroupStatus({});
    setLoadingMore(false);
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError("");
      setMoreError("");
      loadNoteFeed(api, query)
        .then((feed) => {
          if (cancelled || current !== generation.current) return;
          setState(
            feed.mode === "groups"
              ? applyGroups(feed.page, deleted.current)
              : applyLegacy(feed.notes, deleted.current),
          );
        })
        .catch((reason) => {
          if (!cancelled && current === generation.current) setError(formatError(reason));
        })
        .finally(() => {
          if (!cancelled && current === generation.current) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [api, query, retryKey]);

  const loadMore = useCallback(async () => {
    if (!state.nextCursor || loading || loadingMore) return;
    const current = generation.current;
    const activeQuery = queryRef.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const feed = await loadNoteFeed(api, activeQuery, state.nextCursor);
      if (current !== generation.current || activeQuery !== queryRef.current) return;
      if (feed.mode !== "groups") return;
      // Merge into the latest state: deletions and expanded groups may have changed
      // while the page was in flight, and the page totals predate those updates.
      setState((previous) => {
        if (previous.mode !== "groups") return previous;
        return {
          ...previous,
          groups: appendGroups(previous.groups, feed.page, deleted.current),
          nextCursor: feed.page.nextCursor,
        };
      });
    } catch (reason) {
      if (current === generation.current) setMoreError(formatError(reason));
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }, [api, loading, loadingMore, state.nextCursor]);

  const loadAllNotes = useCallback(
    async (bookId: string) => {
      const current = generation.current;
      const activeQuery = queryRef.current;
      setGroupStatus((previous) => ({ ...previous, [bookId]: { loading: true, error: "" } }));
      try {
        const notes = await loadBookNotes(api, bookId, activeQuery);
        if (current !== generation.current || activeQuery !== queryRef.current) return;
        const visible = withoutDeleted(notes, deleted.current);
        setState((previous) => ({
          ...previous,
          groups: previous.groups.map((group) =>
            group.book.id === bookId
              ? { ...group, notes: visible, noteCount: visible.length, hasMore: false }
              : group,
          ),
        }));
        setGroupStatus((previous) => ({ ...previous, [bookId]: { loading: false, error: "" } }));
      } catch (reason) {
        if (current !== generation.current) return;
        setGroupStatus((previous) => ({
          ...previous,
          [bookId]: { loading: false, error: formatError(reason) },
        }));
      }
    },
    [api],
  );

  const remove = useCallback(
    async (note: Note): Promise<boolean> => {
      if (deleting) return false;
      setDeleting(note.id);
      setDeleteError(null);
      try {
        await deleteNote(api, note.id);
      } catch (reason) {
        setDeleteError({ id: note.id, message: formatError(reason) });
        setDeleting(null);
        return false;
      }
      deleted.current.add(note.id);
      setState((previous) => {
        if (previous.mode === "legacy") {
          const flatNotes = previous.flatNotes.filter((item) => item.id !== note.id);
          return { ...previous, flatNotes, totalNotes: flatNotes.length };
        }
        let removedGroup = false;
        const groups = previous.groups.flatMap((group) => {
          if (group.book.id !== note.bookId) return [group];
          const notes = group.notes.filter((item) => item.id !== note.id);
          const noteCount = Math.max(0, group.noteCount - 1);
          if (!noteCount) {
            removedGroup = true;
            return [];
          }
          return [{ ...group, notes, noteCount, hasMore: noteCount > notes.length }];
        });
        return {
          ...previous,
          groups,
          totalBooks: Math.max(0, previous.totalBooks - (removedGroup ? 1 : 0)),
          totalNotes: Math.max(0, previous.totalNotes - 1),
        };
      });
      setDeleting(null);
      return true;
    },
    [api, deleting],
  );

  const retry = useCallback(() => setRetryKey((value) => value + 1), []);

  return {
    state,
    loading,
    loadingMore,
    error,
    moreError,
    deleting,
    deleteError,
    groupStatus,
    loadMore,
    loadAllNotes,
    remove,
    retry,
  };
}
