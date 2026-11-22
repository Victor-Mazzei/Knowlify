import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** jsdom reports zero widths and heights; render a short first slice instead of everything. */
export const FALLBACK_VISIBLE_ITEMS = 60;
export const FALLBACK_WIDTH = 1024;

export function columnsForWidth(width: number, minColumnWidth = 176, gap = 16) {
  if (!Number.isFinite(width) || width <= 0) return 4;
  if (width < 768) return 2;
  return Math.max(2, Math.min(8, Math.floor((width + gap) / (minColumnWidth + gap))));
}

export type WindowedRangeInput = {
  /** Container top relative to the viewport (negative when scrolled past). */
  top: number;
  viewport: number;
  rowHeight: number;
  totalRows: number;
  columns: number;
  itemCount: number;
  overscan: number;
};

/**
 * Slice of items covering the viewport, padded with overscan rows. It is pure
 * so the clamping that keeps a shrinking list inside its own bounds can be
 * tested without a layout engine.
 */
export function windowedRange({
  top,
  viewport,
  rowHeight,
  totalRows,
  columns,
  itemCount,
  overscan,
}: WindowedRangeInput): { start: number; end: number } {
  const startRow = Math.max(0, Math.floor(-top / rowHeight) - overscan);
  const endRow = Math.min(totalRows, Math.ceil((viewport - top) / rowHeight) + overscan);
  const start = Math.min(itemCount, startRow * columns);
  const end = Math.min(itemCount, Math.max(start, endRow * columns));
  return { start, end };
}

export type WindowedRowsOptions = {
  /** Every rendered row is exactly this tall, in CSS pixels. */
  rowHeight: number;
  /** Use 1 for a table, where each item occupies a row. */
  fixedColumns?: number;
  minColumnWidth?: number;
  gap?: number;
  overscan?: number;
};

export type WindowedRows = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  columns: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalHeight: number;
  /** False when the page has no layout (tests) and only the fallback slice is rendered. */
  measured: boolean;
};

/** Rows are aligned to the top of the visible page and padded with overscan. */
export function useWindowedRows(itemCount: number, options: WindowedRowsOptions): WindowedRows {
  const { rowHeight, fixedColumns, minColumnWidth = 176, gap = 16, overscan = 3 } = options;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ start: 0, end: Math.min(itemCount, FALLBACK_VISIBLE_ITEMS) });
  const columns = fixedColumns ?? columnsForWidth(width || FALLBACK_WIDTH, minColumnWidth, gap);
  const totalRows = Math.ceil(itemCount / columns);

  // Layout effect: the grid must know the real column count before the browser paints.
  // Measuring in an effect paints one frame with FALLBACK_WIDTH columns and the next
  // one corrects it, which is a visible layout shift on every return to the library.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const update = useCallback(() => {
    const element = containerRef.current;
    if (!element || element.clientWidth === 0 || itemCount === 0) {
      const end = Math.min(itemCount, FALLBACK_VISIBLE_ITEMS);
      setRange((previous) => (previous.start === 0 && previous.end === end ? previous : { start: 0, end }));
      return;
    }
    const { start, end } = windowedRange({
      top: element.getBoundingClientRect().top,
      viewport: window.innerHeight,
      rowHeight,
      totalRows,
      columns,
      itemCount,
      overscan,
    });
    setRange((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, [columns, itemCount, overscan, rowHeight, totalRows]);

  useEffect(() => {
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [update]);

  // A list can shrink (search/filter) before the scroll clamp runs: never expose
  // a window outside the current item set, even for the frame before `update`.
  const startIndex = Math.min(range.start, itemCount);
  const endIndex = Math.min(Math.max(range.end, startIndex), itemCount);
  return {
    containerRef,
    columns,
    startIndex,
    endIndex,
    totalRows,
    totalHeight: totalRows * rowHeight,
    measured: width > 0,
  };
}
