import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectionBar } from "./SelectionBar";
import { SELECTION_LIMIT } from "./useSelection";

function setup(overrides: Partial<Parameters<typeof SelectionBar>[0]> = {}) {
  const props = {
    count: 3,
    total: 100,
    loadedCount: 60,
    allMode: false,
    onSelectAll: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
  render(<SelectionBar {...props} />);
  return props;
}

describe("SelectionBar", () => {
  it("shows the count, announces it and offers the filtered bulk selection", () => {
    const props = setup();
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument();
    expect(screen.getByText("3 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 selected");

    fireEvent.click(screen.getByRole("button", { name: "Select all 100 results" }));
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("hides the select-all hint when every result is already loaded", () => {
    setup({ total: 12, loadedCount: 12 });
    expect(screen.queryByRole("button", { name: /Select all/ })).not.toBeInTheDocument();
  });

  it("replaces the hint with the all-results state", () => {
    setup({ count: 100, allMode: true, total: 100 });
    expect(screen.getByText("All 100 results selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select all/ })).not.toBeInTheDocument();
  });

  it("shows the limit, warns, and points to the filtered selection", () => {
    const onSelectAll = vi.fn();
    setup({ count: SELECTION_LIMIT, total: 120, loadedCount: 60, onSelectAll });

    expect(screen.getByText("100 of 100 selected", { selector: ".selection-count" })).toBeInTheDocument();
    const warning = screen.getByText(/Selection limit reached/, { selector: ".selection-limit" });
    expect(warning).toHaveTextContent(
      "Selection limit reached (100 books). Deselect some books, or select every result of the current filter.",
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(
      "100 of 100 selected. Selection limit reached (100 books). Deselect some books, or select every result of the current filter.",
    );

    fireEvent.click(screen.getByRole("button", { name: "select every result of the current filter" }));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("drops the filtered advice when every result is already selected", () => {
    setup({ count: SELECTION_LIMIT, total: SELECTION_LIMIT, loadedCount: SELECTION_LIMIT });
    expect(screen.getByText(/Selection limit reached/, { selector: ".selection-limit" })).toHaveTextContent(
      "Deselect some books to select more.",
    );
    expect(screen.queryByRole("button", { name: /every result/i })).not.toBeInTheDocument();
  });

  it("still offers the filtered selection when every result is loaded", () => {
    setup({ count: SELECTION_LIMIT, total: 120, loadedCount: 120 });
    expect(screen.getByRole("button", { name: "select every result of the current filter" })).toBeInTheDocument();
  });

  it("drops the warning when the selection goes below the limit", () => {
    const props = {
      count: SELECTION_LIMIT,
      total: 120,
      loadedCount: 60,
      allMode: false,
      onSelectAll: vi.fn(),
      onDelete: vi.fn(),
      onClear: vi.fn(),
    };
    const { rerender } = render(<SelectionBar {...props} />);
    expect(screen.getByText(/Selection limit reached/, { selector: ".selection-limit" })).toBeInTheDocument();

    rerender(<SelectionBar {...props} count={SELECTION_LIMIT - 1} />);
    expect(screen.queryByText(/Selection limit reached/, { selector: ".selection-limit" })).not.toBeInTheDocument();
    expect(screen.getByText("99 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("Selection limit reached");
  });

  it("does not apply the id ceiling to the filtered all-results mode", () => {
    setup({ count: 120, allMode: true, total: 120, loadedCount: 120 });
    expect(screen.getByText("All 120 results selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(screen.queryByText(/Selection limit reached/, { selector: ".selection-limit" })).not.toBeInTheDocument();
  });

  it("wires Tag, Delete and Clear without dropping the count", () => {
    const onTag = vi.fn();
    const props = setup({ onTag });
    fireEvent.click(screen.getByRole("button", { name: "Tag" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onTag).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3 selected", { selector: ".selection-count" })).toBeInTheDocument();
  });

  it("offers both favorite directions for the selection", () => {
    const onFavorite = vi.fn();
    setup({ onFavorite });
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
    fireEvent.click(screen.getByRole("button", { name: "Unfavorite" }));
    expect(onFavorite).toHaveBeenNthCalledWith(1, true);
    expect(onFavorite).toHaveBeenNthCalledWith(2, false);
  });

  it("disables the actions while a request is running", () => {
    setup({ busy: true, favoriteBusy: true, onTag: vi.fn(), onFavorite: vi.fn() });
    for (const name of ["Tag", "Favorite", "Unfavorite", "Delete", "Clear"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
