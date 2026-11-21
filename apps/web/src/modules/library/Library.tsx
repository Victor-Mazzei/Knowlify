import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useScanStatusContextOptional } from "../../components/ScanStatusContext";
import type { ApiFn } from "../../components/dialogs";
import { useConfirm } from "../../components/dialogs";
import { useIndexStatusContextOptional } from "../indexing/IndexStatusContext";
import { useApi } from "../../services/api";
import type { Book, Credentials } from "../../types";
import { FilterChips } from "./FilterChips";
import {
  activeFilterCount,
  clearFilters,
  filtersKey as filtersKeyOf,
  parseLibrarySearch,
  selectionFilter,
  type LibraryFilters,
} from "./libraryFilters";
import { LibraryEmptyState } from "./LibraryEmptyState";
import { LibraryNotices } from "./LibraryNotices";
import { LibrarySelection } from "./LibrarySelection";
import { LibraryToolbar } from "./LibraryToolbar";
import { useFavoriteActions } from "../favorites/useFavoriteActions";
import { useTags } from "../tags/useTags";
import { devBooksApi } from "../book/devApi";
import { useLibraryReturnScroll } from "../book/libraryReturn";
import { useBooks } from "./useBooks";
import { useFileDrop } from "./useFileDrop";
import { useLibraryFacets } from "./useLibraryFacets";
import { useLibraryFilterGuards } from "./useLibraryFilterGuards";
import { useLibraryQueryState } from "./useLibraryQueryState";
import { useLibraryRevisions } from "./useLibraryRevisions";
import { useLegacyBookRemoval } from "./useLegacyBookRemoval";
import { useUpload } from "./useUpload";
import { VirtualBookList } from "./VirtualBookList";
import { useSelectionActions } from "./selection/useSelectionActions";
import { readLibraryView, saveLibraryView, type LibraryView } from "../settings/preferences";

const titleCount = new Intl.NumberFormat("en-US");
/** Opt-in dev fixture: render the library without a server. */
const devMock = devBooksApi();

export function Library({
  credentials,
  onLogout,
  apiOverride,
}: {
  credentials: Credentials;
  onLogout: () => void;
  /** Test seam: inject a fixture API without changing the auth hook. */
  apiOverride?: ApiFn;
}) {
  const liveApi = useApi(credentials, onLogout);
  const api = apiOverride ?? devMock ?? liveApi;
  const indexState = useIndexStatusContextOptional();
  const scanState = useScanStatusContextOptional();
  const { ask, dialog: confirmDialog } = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const search = useMemo(() => parseLibrarySearch(searchKey), [searchKey]);
  const facetsState = useLibraryFacets(api, { query: search.query, filters: search.filters });
  const { invalidate: invalidateFacets, invalidateSources } = facetsState;
  const available = facetsState.availability === "available";
  const indexEnabled = facetsState.facets?.index != null;
  // The tags contract is the marker for every bulk endpoint this UI relies on;
  // an older server keeps the single-book controls and hides the new ones.
  const selectable = available && Array.isArray(facetsState.facets?.tag);
  const favoritesAvailable = facetsState.facets?.favorite != null;
  const { toolbarSort, sort, filters, order, listIdentity, updateSearch, changeSort, changeFilters } =
    useLibraryQueryState({
      search,
      searchKey,
      searchParams,
      setSearchParams,
      available,
      unavailable: facetsState.availability === "unavailable",
      indexEnabled,
      selectable,
      favoritesAvailable,
    });
  const {
    books,
    total,
    loading,
    loadingMore,
    hasMore,
    notice,
    setNotice,
    error,
    setError,
    loadMore,
    refresh,
    retry,
    hydrateVisible,
    removeBook,
    patchTagIds,
    patchFavorites,
  } = useBooks(api, { query: search.query, sort, order, filters });
  const { pendingIds: favoritePendingIds, toggleFavorite } = useFavoriteActions({
    api,
    patchFavorites,
    onChanged: invalidateFacets,
    onError: setError,
    refreshAfterChange: filters.favorite,
    refresh,
  });
  const toggleFavoriteBook = useCallback(
    (book: Book) => {
      setError("");
      toggleFavorite(book);
    },
    [setError, toggleFavorite],
  );
  // Coming back from a book: claim the pending return for this URL and consume it
  // once the first page settles, even when the result set is empty.
  const returnPending = useLibraryReturnScroll({
    search: searchKey,
    loaded: !loading,
    empty: total === 0,
  });
  const tagsState = useTags(api, { enabled: selectable });
  const visible = useRef<Book[]>([]);
  const rememberVisible = useCallback((next: Book[]) => {
    visible.current = next;
  }, []);
  const { uploading, upload, duplicate, dismissDuplicate } = useUpload(
    api,
    async (file) => {
      setNotice(`${file.name} added to your library.`);
      void indexState?.refresh().catch(() => undefined);
      invalidateFacets();
      await refresh();
    },
    setError,
  );
  const [view, setView] = useState<LibraryView>(readLibraryView);
  const dragging = useFileDrop((file) => void handleUpload(file), !uploading);
  const activeFilters = activeFilterCount(filters);
  const selectionScope = `${filtersKeyOf(filters)}|${search.query}`;
  const filterSelection = useMemo(() => selectionFilter(search.query, filters), [filters, search.query]);
  const removeBooks = useCallback(
    (ids: string[]) => {
      for (const id of ids) removeBook(id);
    },
    [removeBook],
  );
  const {
    selection,
    tagOpen,
    setTagOpen,
    deleteTarget,
    setDeleteTarget,
    toggleBook,
    toggleAllLoaded,
    selectAllResults,
    requestDelete,
    requestDeleteBook,
    applyTagChange,
    applyFavoriteChange,
    favoriteBusy,
    applyDeleteProgress,
    completeDelete,
  } = useSelectionActions({
    api,
    books,
    total,
    scope: selectionScope,
    selectable,
    filterSelection,
    patchTagIds,
    patchFavorites,
    onRemoveBooks: removeBooks,
    onInvalidateFacets: invalidateFacets,
    onRefresh: refresh,
    onNotice: setNotice,
    onError: setError,
    refreshAfterFavorite: filters.favorite,
  });

  useEffect(() => {
    // The matched return owns the scroll until it is restored or consumed; every
    // other list change (and a stale entry for another URL) starts at the top.
    if (returnPending.current) return;
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "auto" });
  }, [listIdentity, returnPending]);

  useLibraryFilterGuards({
    available,
    favoritesAvailable,
    selectable,
    tagsLoading: tagsState.loading,
    tags: tagsState.tags,
    visibleTags: filters.tag,
    rawFilters: search.filters,
    sort,
    updateSearch,
  });

  async function handleUpload(file: File) {
    setNotice("");
    setError("");
    await upload(file);
  }

  function changeView(next: LibraryView) {
    setView(next);
    saveLibraryView(next);
  }

  const remove = useLegacyBookRemoval({
    api,
    selectable,
    ask,
    requestDeleteBook,
    removeBook,
    invalidateFacets,
    onError: setError,
    onNotice: setNotice,
  });

  useLibraryRevisions({
    indexRevision: indexState?.status?.revision,
    libraryRevision: scanState?.libraryRevision ?? 0,
    visible,
    hydrateVisible,
    invalidateFacets,
    invalidateSources,
    refresh,
  });

  const showSkeleton = loading && books.length === 0;
  const count = `${titleCount.format(total)} ${total === 1 ? "title" : "titles"}`;
  const filterSummary = activeFilters > 0 ? ` · ${activeFilters} ${activeFilters === 1 ? "filter" : "filters"}` : "";
  return (
    <>
      <main className={`library${selectable && selection.count > 0 ? " has-selection" : ""}`}>
        <section className="intro">
          <h1>
            Library <span className="title-count">{showSkeleton ? "Loading…" : count}</span>
          </h1>
        </section>
        <LibraryToolbar
          query={search.query}
          onQueryChange={(value) => updateSearch({ query: value }, true)}
          available={available}
          filtersPending={facetsState.availability === "unknown"}
          filters={filters}
          facets={facetsState.facets}
          sources={facetsState.sources}
          tags={tagsState.tags}
          sort={toolbarSort}
          onSortChange={changeSort}
          onFiltersChange={changeFilters}
          view={view}
          onViewChange={changeView}
          uploading={uploading}
          onUpload={(file) => void handleUpload(file)}
        />
        <FilterChips filters={filters} sources={facetsState.sources} tags={tagsState.tags} onChange={changeFilters} />
        <p className="visually-hidden" role="status" aria-live="polite">
          {loading
            ? "Loading books…"
            : error
              ? ""
              : `${count}${filterSummary}${search.query ? ` matching “${search.query}”` : ""}`}
        </p>
        <LibraryNotices
          dragging={dragging}
          notice={notice}
          duplicate={duplicate}
          onDismissDuplicate={dismissDuplicate}
          error={error}
          onRetry={() => void retry()}
        />
        {showSkeleton ? (
          <div className="library-skeleton" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index} className="skeleton-card" />
            ))}
          </div>
        ) : error && books.length === 0 ? null : total === 0 && !loading ? (
          <LibraryEmptyState
            activeFilters={activeFilters}
            query={search.query}
            sort={sort}
            onClearFilters={() => changeFilters(clearFilters())}
          />
        ) : (
          <VirtualBookList
            key={`${view}:${listIdentity}`}
            books={books}
            total={total}
            view={view}
            api={api}
            onDelete={(book) => void remove(book)}
            onLoadMore={() => void loadMore()}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onVisibleChange={rememberVisible}
            selectable={selectable}
            allSelected={selection.all !== null}
            selectedIds={selection.ids}
            onSelect={toggleBook}
            onToggleAll={toggleAllLoaded}
            tags={tagsState.tags}
            showTags={selectable}
            favoritePendingIds={favoritePendingIds}
            onToggleFavorite={favoritesAvailable ? toggleFavoriteBook : undefined}
          />
        )}
      </main>
      <LibrarySelection
        selectable={selectable}
        selection={selection}
        books={books}
        total={total}
        tags={tagsState.tags}
        tagsLoading={tagsState.loading}
        tagOpen={tagOpen}
        deleteTarget={deleteTarget}
        api={api}
        favoriteBusy={favoriteBusy}
        onSelectAll={selectAllResults}
        onToggleTag={() => setTagOpen((value) => !value)}
        onFavorite={(favorite) => void applyFavoriteChange(favorite)}
        onDelete={requestDelete}
        onClear={() => {
          setTagOpen(false);
          selection.clear();
        }}
        onApplyTags={applyTagChange}
        onCreateTag={(name) => tagsState.create(name)}
        onDeleted={(result, target) => void completeDelete(result, target)}
        onPartial={applyDeleteProgress}
        onCloseTag={() => setTagOpen(false)}
        onCloseDelete={() => setDeleteTarget(null)}
      />
      {confirmDialog}
    </>
  );
}
