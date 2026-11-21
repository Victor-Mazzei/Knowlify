import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bookIndex } from "./fixtures";
import { BookIndexNote } from "./BookIndexNote";
import type { Book } from "../../types";

const book = (index: Book["index"]): Book => ({
  id: "b1",
  title: "A Book",
  author: "An Author",
  format: "epub",
  size: 1024,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source: false,
  index,
});

describe("BookIndexNote", () => {
  it("is silent when the book is searchable or unknown", () => {
    const { container, rerender } = render(<BookIndexNote book={book(bookIndex("ready"))} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<BookIndexNote book={book(undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the queued and indexing states", () => {
    const { rerender } = render(<BookIndexNote book={book(bookIndex("pending"))} />);
    expect(screen.getByText("Queued for search")).toBeInTheDocument();

    rerender(<BookIndexNote book={book(bookIndex("indexing"))} />);
    expect(screen.getByText("Indexing for search")).toBeInTheDocument();
  });

  it("shows failures with the server message as a title", () => {
    render(<BookIndexNote book={book(bookIndex("error", "The file could not be read."))} />);
    const note = screen.getByText("Search index failed");
    expect(note).toHaveClass("error-status");
    expect(note).toHaveAttribute("title", "The file could not be read.");
  });
});
