import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Source } from "../../types";
import { FilterChips } from "./FilterChips";
import { EMPTY_FILTERS, type LibraryFilters } from "./libraryFilters";

const sources: Source[] = [{ id: "s1", path: "/library/Fiction", accessible: true, books: 7 }];

const filters = (overrides: Partial<LibraryFilters> = {}): LibraryFilters => ({ ...EMPTY_FILTERS, ...overrides });

describe("FilterChips", () => {
  it("renders nothing without active filters", () => {
    const { container } = render(<FilterChips filters={EMPTY_FILTERS} sources={sources} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("removes one filter at a time and labels sources", () => {
    const onChange = vi.fn();
    render(
      <FilterChips
        filters={filters({ format: ["pdf"], read: ["reading"], source: ["s1", "upload"], notes: true })}
        sources={sources}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("button", { name: "Remove filter: PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Fiction" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Added manually" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Reading" }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ format: ["pdf"], source: ["s1", "upload"], notes: true }));

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: PDF" }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ read: ["reading"], source: ["s1", "upload"], notes: true }));
  });

  it("removes the Favorites chip without touching other filters", () => {
    const onChange = vi.fn();
    render(<FilterChips filters={filters({ favorite: true, format: ["epub"] })} sources={sources} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Favorites" }));
    expect(onChange).toHaveBeenLastCalledWith(filters({ format: ["epub"] }));
  });

  it("clears every filter at once", () => {
    const onChange = vi.fn();
    render(<FilterChips filters={filters({ read: ["unread"], notes: true })} sources={sources} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS);
  });
});
