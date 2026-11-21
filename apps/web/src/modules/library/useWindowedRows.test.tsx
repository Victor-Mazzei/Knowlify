import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  columnsForWidth,
  FALLBACK_VISIBLE_ITEMS,
  useWindowedRows,
  windowedRange,
} from "./useWindowedRows";

function Harness({ count }: { count: number }) {
  const windowed = useWindowedRows(count, { rowHeight: 100 });
  return (
    <div ref={windowed.containerRef} data-testid="box">
      <span data-testid="state">
        {windowed.startIndex}-{windowed.endIndex}-{windowed.columns}-{String(windowed.measured)}
      </span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useWindowedRows", () => {
  it("computes responsive columns from the container width", () => {
    expect(columnsForWidth(360)).toBe(2);
    expect(columnsForWidth(900)).toBe(4);
    expect(columnsForWidth(1400)).toBe(7);
    expect(columnsForWidth(0)).toBe(4);
  });

  it("falls back to the first 60 items when the page has no layout", () => {
    render(<Harness count={11_000} />);
    const [start, end, columns, measured] = screen.getByTestId("state").textContent!.split("-");
    expect(start).toBe("0");
    expect(end).toBe(String(FALLBACK_VISIBLE_ITEMS));
    expect(Number(columns)).toBeGreaterThan(1);
    expect(measured).toBe("false");
  });

  it.each([
    [1226, 6],
    [375, 2],
  ])("uses the measured width before the first paint (%ipx -> %i columns)", (width, expected) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 0,
      left: 0,
      right: width,
      width,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    render(<Harness count={320} />);
    // The first committed frame must already use the container width, not FALLBACK_WIDTH.
    const [, , columns, measured] = screen.getByTestId("state").textContent!.split("-");
    expect(Number(columns)).toBe(expected);
    expect(measured).toBe("true");
  });

  it("windows around the scroll position once the container has a size", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: -500,
      bottom: 0,
      left: 0,
      right: 1200,
      width: 1200,
      height: 0,
      x: 0,
      y: -500,
      toJSON: () => ({}),
    });
    render(<Harness count={1000} />);
    const [start, end, columns, measured] = screen.getByTestId("state").textContent!.split("-");
    expect(Number(columns)).toBe(6);
    expect(Number(start)).toBeGreaterThan(0);
    expect(Number(end)).toBeLessThan(1000);
    expect(Number(end)).toBeGreaterThan(Number(start));
    expect(measured).toBe("true");
  });

  it("keeps a scrolled window covering the viewport and inside the list", () => {
    const range = windowedRange({
      top: -4000,
      viewport: 800,
      rowHeight: 396,
      totalRows: 100,
      columns: 6,
      itemCount: 600,
      overscan: 3,
    });
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeLessThanOrEqual(600);
    expect(range.end).toBeGreaterThan(range.start);
    // The last rendered row still reaches the bottom of the viewport.
    expect(Math.ceil(range.end / 6) * 396).toBeGreaterThanOrEqual(4000 + 800);
  });

  it("clamps a shrinking item set instead of rendering rows outside it", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: -4000,
      bottom: 0,
      left: 0,
      right: 1200,
      width: 1200,
      height: 0,
      x: 0,
      y: -4000,
      toJSON: () => ({}),
    });
    const { rerender } = render(<Harness count={1000} />);
    expect(Number(screen.getByTestId("state").textContent!.split("-")[0])).toBeGreaterThan(0);

    rerender(<Harness count={3} />);
    const [start, end] = screen.getByTestId("state").textContent!.split("-");
    expect(Number(start)).toBeLessThanOrEqual(3);
    expect(Number(end)).toBeLessThanOrEqual(3);
    expect(Number(end)).toBeGreaterThanOrEqual(Number(start));
  });
});
