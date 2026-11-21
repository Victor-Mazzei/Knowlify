import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookFacets, BookSort, Source } from "../../types";
import { EMPTY_FILTERS, type LibraryFilters } from "./libraryFilters";
import { FiltersPopover } from "./FiltersPopover";

const facets = (overrides: Partial<BookFacets> = {}): BookFacets => ({
  total: 10,
  format: { pdf: 4, epub: 6 },
  read: { unread: 5, reading: 3, finished: 2 },
  index: { ready: 8, pending: 0, error: 2 },
  source: [
    { id: "s1", count: 7 },
    { id: "upload", count: 3 },
  ],
  notes: { with: 2 },
  ...overrides,
});

const sources: Source[] = [{ id: "s1", path: "/library/Fiction", accessible: true, books: 7 }];

const filters = (overrides: Partial<LibraryFilters> = {}): LibraryFilters => ({ ...EMPTY_FILTERS, ...overrides });

function setup(value: LibraryFilters = EMPTY_FILTERS, data: BookFacets = facets(), sort: BookSort = "added") {
  const onChange = vi.fn();
  render(<FiltersPopover filters={value} facets={data} sources={sources} sort={sort} onChange={onChange} />);
  return { onChange };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
const checkbox = (name: RegExp) => screen.getByRole("checkbox", { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FiltersPopover", () => {
  it("exposes the panel state and focuses the first group on open", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    open();
    const panel = screen.getByRole("group", { name: "Filters" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(checkbox(/^PDF/)).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    setup();
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Filters" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
  });

  it("closes when clicking outside", () => {
    setup();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("reads the facet counts and disables empty options", () => {
    setup();
    open();
    expect(checkbox(/^PDF/)).toHaveAccessibleName("PDF 4");
    expect(checkbox(/^Added manually/)).toHaveAccessibleName("Added manually 3");
    expect(checkbox(/^Pending/)).toBeDisabled();
    expect(checkbox(/^Ready/)).toBeEnabled();
  });

  it("keeps an empty option enabled while it is already selected", () => {
    setup(filters({ index: ["pending"] }));
    open();
    expect(checkbox(/^Pending/)).toBeChecked();
    expect(checkbox(/^Pending/)).toBeEnabled();
  });

  it("toggles one value at a time", () => {
    const { onChange } = setup();
    open();

    fireEvent.click(checkbox(/^Reading/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ read: ["reading"] }));

    fireEvent.click(checkbox(/^Error/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ index: ["error"] }));

    fireEvent.click(checkbox(/^Fiction/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ source: ["s1"] }));

    fireEvent.click(checkbox(/^With notes/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ notes: true }));
  });

  it("unchecks a format when both are shown", () => {
    const { onChange } = setup();
    open();
    expect(checkbox(/^PDF/)).toBeChecked();
    expect(checkbox(/^EPUB/)).toBeChecked();
    fireEvent.click(checkbox(/^PDF/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ format: ["epub"] }));
  });

  it("returns to all formats after unchecking the last one", () => {
    const { onChange } = setup(filters({ format: ["epub"] }));
    open();
    fireEvent.click(checkbox(/^EPUB/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ format: [] }));
  });

  it("clears every group without touching the search or sort", () => {
    const { onChange } = setup(filters({ format: ["pdf"], read: ["reading"], notes: true }));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  });

  it("hides the indexing group when the server reports indexing disabled", () => {
    setup(EMPTY_FILTERS, facets({ index: null }));
    open();
    expect(screen.queryByRole("group", { name: "Indexing" })).not.toBeInTheDocument();
  });

  it("disables Not started while sorting by last read", () => {
    setup(EMPTY_FILTERS, facets(), "lastRead");
    open();
    expect(checkbox(/^Not started/)).toBeDisabled();
  });

  it("offers the favorite facet only when the server reports it", () => {
    const { onChange } = setup(EMPTY_FILTERS, facets({ favorite: { with: 3 } }));
    open();
    expect(checkbox(/^Favorites/)).toHaveAccessibleName("Favorites 3");
    fireEvent.click(checkbox(/^Favorites/));
    expect(onChange).toHaveBeenLastCalledWith(filters({ favorite: true }));
  });

  it("hides the favorite group on a server without the contract", () => {
    setup();
    open();
    expect(screen.queryByRole("group", { name: "Collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /^Favorites/ })).not.toBeInTheDocument();
  });
});
