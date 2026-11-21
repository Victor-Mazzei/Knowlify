import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { readLibraryReturn } from "../book/libraryReturn";
import { BookCard } from "./BookCard";

const book = {
  id: "b1",
  title: "A Book",
  author: "An Author",
  format: "epub" as const,
  size: 1048576,
  addedAt: 0,
  hasCover: false,
  status: "ready" as const,
  source: false,
};

describe("BookCard", () => {
  it("links to the reader and deletes the book", () => {
    const onDelete = vi.fn();
    render(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={onDelete} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /A Book/ })).toHaveAttribute("href", "/book/b1");
    fireEvent.click(screen.getByRole("button", { name: "Delete A Book" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows one meta line and no placeholder status text", () => {
    render(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("EPUB · 1.0 MB")).toBeInTheDocument();
    expect(screen.queryByText(/INDEXING|UNAVAILABLE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}\/\d{1,2}\/\d{4}/)).not.toBeInTheDocument();
  });

  it("shows a short search-index note only when the book needs attention", () => {
    const pending = { ...book, index: { state: "pending" as const, error: null } };
    const { rerender } = render(
      <MemoryRouter>
        <BookCard book={pending} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Queued for search")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <BookCard book={{ ...book, index: { state: "ready", error: null } }} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Queued for search")).not.toBeInTheDocument();
  });

  it("shows how much of the book is left, and nothing when never read", () => {    const { rerender } = render(
      <MemoryRouter>
        <BookCard book={{ ...book, progress: { percentage: 0.42, updatedAt: 0 } }} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("58% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "42");

    rerender(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("offers a checkbox as a second focus target and toggles on a pointer click in selection mode", () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} selectable selecting onSelect={onSelect} />
      </MemoryRouter>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Select A Book" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox, { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ shiftKey: true }));

    // A pointer click toggles the book instead of following the link.
    fireEvent.click(screen.getByRole("link", { name: /A Book/ }), { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("toggles the favorite without opening the book or changing the selection", () => {
    const onToggleFavorite = vi.fn();
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <BookCard
          book={book}
          api={vi.fn()}
          onDelete={vi.fn()}
          selectable
          selecting
          onSelect={onSelect}
          onToggleFavorite={onToggleFavorite}
        />
      </MemoryRouter>,
    );
    const star = screen.getByRole("button", { name: "Add to favorites: A Book" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /A Book/ })).toHaveAttribute("href", "/book/b1");
  });

  it("reflects the favorite state and hides the star on servers without favorites", () => {
    const { rerender } = render(
      <MemoryRouter>
        <BookCard book={{ ...book, favorite: true }} api={vi.fn()} onDelete={vi.fn()} onToggleFavorite={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Remove from favorites: A Book" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: /favorites: A Book/ })).not.toBeInTheDocument();
  });

  it("captures the Library URL before opening the details", () => {
    render(
      <MemoryRouter initialEntries={["/?q=river&sort=title"]}>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /A Book/ }), { detail: 1 });
    expect(readLibraryReturn()).toEqual({ search: "?q=river&sort=title", scrollY: 0 });
  });

  it("opens the book on click when no selection is active", () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <BookCard book={book} api={vi.fn()} onDelete={vi.fn()} selectable onSelect={onSelect} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /A Book/ }), { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
