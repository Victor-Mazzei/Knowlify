import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../../types";
import { BookTable } from "./BookTable";

const book = (source: boolean): Book => ({
  id: source ? "b2" : "b1",
  title: source ? "Folder Book" : "Own Book",
  author: "",
  format: "pdf",
  size: 1048576,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source,
});

describe("BookTable", () => {
  it("links titles and only allows deleting books the user owns", () => {
    const onDelete = vi.fn();
    render(
      <MemoryRouter>
        <BookTable books={[book(false), book(true)]} api={vi.fn()} onDelete={onDelete} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Own Book" })).toHaveAttribute("href", "/book/b1");
    expect(screen.getByRole("link", { name: "Folder Book" })).toHaveAttribute("href", "/book/b2");
    expect(screen.getAllByRole("button", { name: /Delete/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete Own Book" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });

  it("keeps full long titles and authors available when the cells truncate visually", () => {
    const longTitle = "A Very Long Title That Cannot Fit In The Fixed Title Column Without Being Truncated";
    const longAuthor = "An Author With An Equally Long Name That Needs The Whole Cell To Be Read";
    render(
      <MemoryRouter>
        <BookTable
          books={[{ ...book(false), id: "long", title: longTitle, author: longAuthor }]}
          api={vi.fn()}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: longTitle })).toHaveAttribute("title", longTitle);
    expect(screen.getByRole("cell", { name: longAuthor })).toHaveAttribute("title", longAuthor);
  });

  it("puts the favorite star in the actions cell without adding a column", () => {
    const onToggleFavorite = vi.fn();
    render(
      <MemoryRouter>
        <BookTable
          books={[{ ...book(false), favorite: true }]}
          api={vi.fn()}
          onDelete={vi.fn()}
          onToggleFavorite={onToggleFavorite}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    const star = screen.getByRole("button", { name: "Remove from favorites: Own Book" });
    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(star.closest("td")).toHaveClass("actions");
    fireEvent.click(star);
    expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });

  it("merges format and size into a Type column", () => {
    render(
      <MemoryRouter>
        <BookTable books={[book(false)]} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("columnheader", { name: "Type" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Format" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Size" })).not.toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(screen.getByText("1.0 MB")).toBeInTheDocument();
  });

  it("shows remaining reading progress in its own column", () => {
    const reading = { ...book(false), progress: { percentage: 0.985, updatedAt: 0 } };
    render(
      <MemoryRouter>
        <BookTable books={[reading]} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("columnheader", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByText("2% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "98");
  });

  it("shares the same fixed column tracks between the visible header and every row", () => {
    render(
      <MemoryRouter>
        <BookTable books={[book(false), book(true)]} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    const table = screen.getByRole("table");
    const columns = [...table.querySelectorAll("colgroup > col")];
    const columnClasses = [
      "col-title",
      "col-author",
      "col-type",
      "col-progress",
      "col-added",
      "col-actions",
    ];
    expect(columns.map((column) => column.className)).toEqual(columnClasses);
    expect(screen.getAllByRole("columnheader")).toHaveLength(columns.length);
    for (const row of table.querySelectorAll("tbody tr:not(.spacer-row)")) {
      expect(row.children).toHaveLength(columns.length);
    }
    expect([...table.querySelectorAll<HTMLElement>("th, td")].some((cell) => cell.style.width)).toBe(false);

    // The visual header is a hidden copy outside the horizontal scroller; the
    // real table keeps its own column groups and accessible headers.
    const visualHead = document.querySelector(".table-sticky-head");
    expect(visualHead).toHaveAttribute("aria-hidden", "true");
    const visualTable = visualHead?.querySelector("table");
    expect(visualTable).not.toBeNull();
    expect([...(visualTable?.querySelectorAll("colgroup > col") ?? [])].map((column) => column.className)).toEqual(
      columnClasses,
    );
    expect(visualTable?.querySelectorAll("thead th")).toHaveLength(columns.length);
    expect(screen.getAllByRole("table")).toHaveLength(1);
  });

  it("sticks the visible header below the measured app header", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 172 } as DOMRect);
    const { container, unmount } = render(
      <div className="app">
        <header>App header</header>
        <MemoryRouter>
          <BookTable books={[book(false)]} api={vi.fn()} onDelete={vi.fn()} />
        </MemoryRouter>
      </div>,
    );
    expect(
      container.querySelector<HTMLElement>(".table-sticky-head")?.style.getPropertyValue("--books-table-sticky-top"),
    ).toBe("172px");
    unmount();
    spy.mockRestore();
  });

  it("adds a leading selection column and an accessible multiselect grid", () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <MemoryRouter>
        <BookTable
          books={[book(false), book(true)]}
          api={vi.fn()}
          onDelete={vi.fn()}
          selection={{
            selectable: true,
            allSelected: false,
            selectedIds: new Set(["b2"]),
            allLoadedSelected: false,
            someLoadedSelected: true,
            onToggle,
            onToggleAll,
          }}
        />
      </MemoryRouter>,
    );
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    expect(grid.querySelectorAll("colgroup > col")[0]).toHaveClass("col-select");
    expect(screen.getByRole("row", { name: /Folder Book/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("row", { name: /Own Book/ })).toHaveAttribute("aria-selected", "false");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Own Book" }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }), expect.anything());

    const selectAll = screen.getAllByRole("checkbox", { name: "Select loaded books" })[0]!;
    expect(selectAll).toBePartiallyChecked();
    fireEvent.click(selectAll);
    expect(onToggleAll).toHaveBeenCalledTimes(1);
  });

  it("mirrors the table's horizontal scroll in the sticky header", () => {
    const { container } = render(
      <MemoryRouter>
        <BookTable books={[book(false)]} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    const body = container.querySelector<HTMLElement>(".table-scroll");
    const head = container.querySelector<HTMLElement>(".table-sticky-head-scroll");
    expect(body).not.toBeNull();
    expect(head).not.toBeNull();
    if (!body || !head) return;

    body.scrollLeft = 180;
    fireEvent.scroll(body);

    expect(head.scrollLeft).toBe(180);
  });
});
