import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FALLBACK_BOOK_CARD_GAP, FALLBACK_BOOK_CARD_HEIGHT } from "./bookGrid";
import { createMockBooks } from "./mockBooksApi";
import { VirtualBookList } from "./VirtualBookList";

const books = createMockBooks().map((book) => ({ ...book, hasCover: false }));
const api = vi.fn(async () => new Response("{}", { status: 404 }));
const onDelete = vi.fn();
const onLoadMore = vi.fn();

function renderList(view: "grid" | "table") {
  return render(
    <MemoryRouter>
      <VirtualBookList
        books={books}
        total={11_000}
        view={view}
        api={api}
        onDelete={onDelete}
        onLoadMore={onLoadMore}
        hasMore
        loadingMore={false}
      />
    </MemoryRouter>,
  );
}

describe("VirtualBookList", () => {
  it("renders only the first 60 of 11,000 cards and stays under the DOM budget", () => {
    renderList("grid");
    expect(screen.getAllByRole("link").length).toBeLessThanOrEqual(60);
    expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("gridcell")[0]).toHaveAttribute("aria-colindex", "1");
    expect(screen.getByRole("grid", { name: "11000 books" })).toBeInTheDocument();
    expect(document.body.querySelectorAll("*").length).toBeLessThan(1500);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("places rows on the card pitch so a row can never overlap the next one", () => {
    renderList("grid");
    const rows = [...document.querySelectorAll<HTMLElement>(".grid-row")];
    const pitch = FALLBACK_BOOK_CARD_HEIGHT + FALLBACK_BOOK_CARD_GAP;
    expect(rows.length).toBeGreaterThan(1);
    expect(pitch).toBeGreaterThanOrEqual(FALLBACK_BOOK_CARD_HEIGHT);

    rows.forEach((row, index) => {
      expect(row.style.top).toBe(`${index * pitch}px`);
      expect(row.style.height).toBe(`${pitch}px`);
    });
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      const previousBottom = Number.parseFloat(previous.style.top) + Number.parseFloat(previous.style.height);
      expect(previousBottom).toBeLessThanOrEqual(Number.parseFloat(current.style.top));
    }

    const grid = document.querySelector<HTMLElement>(".virtual-grid");
    expect(Number.parseFloat(grid?.style.height ?? "0")).toBeGreaterThanOrEqual(
      rows.length * pitch,
    );
  });

  it("virtualizes the table with a complete aria-rowcount and fixed visible rows", () => {
    renderList("table");
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-rowcount", "11001");
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(61);
    expect(rows[1]).toHaveAttribute("aria-rowindex", "2");
    expect(document.body.querySelectorAll("*").length).toBeLessThan(1500);
  });
});
