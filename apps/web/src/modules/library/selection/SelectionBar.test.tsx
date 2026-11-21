import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectionBar } from "./SelectionBar";

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
