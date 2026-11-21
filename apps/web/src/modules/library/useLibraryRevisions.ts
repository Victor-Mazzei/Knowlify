import { useEffect, useRef, type MutableRefObject } from "react";
import type { Book } from "../../types";

/**
 * The shell survives route changes, so indexing and scans arrive as revisions
 * instead of remounts. The first revision describes the page just loaded; only
 * later ones refresh counts and the visible rows.
 */
export function useLibraryRevisions({
  indexRevision,
  libraryRevision,
  visible,
  hydrateVisible,
  invalidateFacets,
  invalidateSources,
  refresh,
}: {
  indexRevision: number | undefined;
  libraryRevision: number;
  visible: MutableRefObject<Book[]>;
  hydrateVisible: (ids: string[]) => Promise<void>;
  invalidateFacets: () => void;
  invalidateSources: () => void;
  refresh: () => Promise<void>;
}) {
  const seenIndexRevision = useRef<number | null>(null);
  useEffect(() => {
    if (indexRevision === undefined) return;
    if (seenIndexRevision.current === null) {
      seenIndexRevision.current = indexRevision;
      return;
    }
    if (seenIndexRevision.current === indexRevision) return;
    seenIndexRevision.current = indexRevision;
    invalidateFacets();
    void hydrateVisible(visible.current.map((book) => book.id));
  }, [hydrateVisible, indexRevision, invalidateFacets, visible]);

  const seenLibraryRevision = useRef(libraryRevision);
  useEffect(() => {
    if (libraryRevision === seenLibraryRevision.current) return;
    seenLibraryRevision.current = libraryRevision;
    invalidateFacets();
    invalidateSources();
    void refresh();
  }, [invalidateFacets, invalidateSources, libraryRevision, refresh]);
}
