import { useEffect, useMemo } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { Book, TagWithCount } from "../../types";
import { readBookGridMetrics } from "./bookGrid";
import { BookCard } from "./BookCard";
import { BookTable, TABLE_ROW_HEIGHT, type TableSelectEvent } from "./BookTable";
import { tagsForBook } from "./TagChips";
import { useWindowedRows } from "./useWindowedRows";

export function VirtualBookList({
  books,
  total,
  view,
  api,
  onDelete,
  onLoadMore,
  hasMore,
  loadingMore,
  onVisibleChange,
  selectable = false,
  allSelected = false,
  selectedIds,
  onSelect,
  onToggleAll,
  tags = [],
  showTags = false,
  favoritePendingIds,
  onToggleFavorite,
}: {
  books: Book[];
  total: number;
  view: "grid" | "table";
  api: ApiFn;
  onDelete: (book: Book) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onVisibleChange?: (books: Book[]) => void;
  selectable?: boolean;
  /** "Select all results" is active: every row counts as selected. */
  allSelected?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelect?: (book: Book, event: TableSelectEvent) => void;
  onToggleAll?: () => void;
  tags?: TagWithCount[];
  showTags?: boolean;
  favoritePendingIds?: ReadonlySet<string>;
  onToggleFavorite?: (book: Book) => void;
}) {
  const grid = useMemo(() => readBookGridMetrics(), []);
  const rowHeight = view === "grid" ? grid.rowHeight : TABLE_ROW_HEIGHT;
  const windowed = useWindowedRows(
    books.length,
    view === "grid"
      ? { rowHeight, minColumnWidth: 176, gap: grid.gap }
      : { rowHeight, fixedColumns: 1 },
  );
  const visible = books.slice(windowed.startIndex, windowed.endIndex);
  const isSelected = (book: Book) => Boolean(allSelected || selectedIds?.has(book.id));
  const loadedSelected = books.length > 0 && books.every(isSelected);
  const loadedPartial = !loadedSelected && books.some(isSelected);

  useEffect(() => {
    onVisibleChange?.(visible);
  }, [books, onVisibleChange, windowed.endIndex, windowed.startIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!windowed.measured || !hasMore || loadingMore) return;
    if (windowed.endIndex >= books.length) onLoadMore();
  }, [books.length, hasMore, loadingMore, onLoadMore, windowed.endIndex, windowed.measured]);

  if (view === "table") {
    return (
      <div ref={windowed.containerRef} aria-busy={loadingMore}>
        <BookTable
          books={visible}
          api={api}
          total={total}
          startIndex={windowed.startIndex}
          loadedCount={books.length}
          onDelete={onDelete}
          tags={tags}
          showTags={showTags}
          favoritePendingIds={favoritePendingIds}
          onToggleFavorite={onToggleFavorite}
          selection={{
            selectable,
            allSelected,
            selectedIds: selectedIds ?? new Set(),
            allLoadedSelected: loadedSelected,
            someLoadedSelected: loadedPartial,
            onToggle: (book, event) => onSelect?.(book, event),
            onToggleAll: () => onToggleAll?.(),
          }}
        />
        {loadingMore && (
          <p className="muted loading-more" role="status">
            Loading more books…
          </p>
        )}
      </div>
    );
  }

  const startRow = Math.floor(windowed.startIndex / windowed.columns);
  const endRow = Math.ceil(windowed.endIndex / windowed.columns);
  const rows = Array.from({ length: Math.max(0, endRow - startRow) }, (_, offset) => startRow + offset);
  return (
    <>
      <div
        ref={windowed.containerRef}
        className={`grid virtual-grid${selectable ? " is-selectable" : ""}`}
        role="grid"
        aria-multiselectable={selectable ? true : undefined}
        aria-rowcount={Math.ceil(total / windowed.columns)}
        aria-colcount={windowed.columns}
        aria-label={`${total} ${total === 1 ? "book" : "books"}`}
        aria-busy={loadingMore}
        style={{ height: windowed.totalHeight }}
      >
        {rows.map((rowIndex) => {
          const from = rowIndex * windowed.columns;
          const rowBooks = books.slice(from, from + windowed.columns);
          return (
            <div
              key={rowIndex}
              className="grid-row"
              role="row"
              aria-rowindex={rowIndex + 1}
              style={{
                top: rowIndex * rowHeight,
                height: rowHeight,
                gridTemplateColumns: `repeat(${windowed.columns}, minmax(0, 1fr))`,
              }}
            >
              {rowBooks.map((book, index) => {
                const selected = isSelected(book);
                return (
                  <div
                    key={book.id}
                    role="gridcell"
                    aria-colindex={index + 1}
                    aria-selected={selectable ? selected : undefined}
                    data-index={from + index + 1}
                  >
                    <BookCard
                      book={book}
                      api={api}
                      onDelete={onDelete}
                      selectable={selectable}
                      selected={selected}
                      selecting={selectable && (allSelected || (selectedIds?.size ?? 0) > 0)}
                      tags={tagsForBook(book.tagIds, tags)}
                      favoritePending={favoritePendingIds?.has(book.id)}
                      onSelect={(event) => onSelect?.(book, event)}
                      onToggleFavorite={onToggleFavorite}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {loadingMore && (
        <p className="muted loading-more" role="status">
          Loading more books…
        </p>
      )}
    </>
  );
}
