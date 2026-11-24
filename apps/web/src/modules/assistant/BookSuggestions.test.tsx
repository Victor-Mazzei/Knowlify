import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { BookSuggestions } from "./BookSuggestions";
import type { ChatRecommendations, RecommendedBook } from "./types";

vi.mock("../library/useCoverQueue", () => ({
  useCover: (book: { hasCover: boolean }) => (book.hasCover ? "blob:cover" : ""),
}));

const api: ApiFn = async () => new Response(null, { status: 204 });

const book = (overrides: Partial<RecommendedBook> = {}): RecommendedBook => ({
  n: 1,
  bookId: "b1",
  title: "Rust for Web Developers",
  author: "Mara Klein",
  format: "epub",
  language: "en",
  hasCover: false,
  coverRev: null,
  progress: { status: "unread", percentage: 0 },
  matched: ["rust", "web"],
  evidence: [
    { passageId: 1, page: 1, section: null },
    { passageId: 2, page: 2, section: null },
  ],
  source: "passages",
  ...overrides,
});

const payload = (overrides: Partial<ChatRecommendations> = {}): ChatRecommendations => ({
  status: "ready",
  intent: "detected",
  focus: "recommend",
  books: [
    book(),
    book({
      n: 2,
      bookId: "b2",
      title: "Programming Rust",
      author: "Lena Ortiz",
      format: "pdf",
      progress: { status: "reading", percentage: 0.34 },
      matched: ["rust"],
      evidence: [{ passageId: 9, page: 88, section: null }],
    }),
  ],
  ...overrides,
});

const renderSuggestions = (
  recommendations: ChatRecommendations | undefined,
  recommended: number[] | undefined,
  useLibrary = true,
  onEnableLibrary = vi.fn(),
) =>
  render(
    <MemoryRouter>
      <BookSuggestions
        recommendations={recommendations}
        recommended={recommended}
        api={api}
        useLibrary={useLibrary}
        onEnableLibrary={onEnableLibrary}
      />
    </MemoryRouter>,
  );

describe("BookSuggestions", () => {
  it("renders only the done markers, in order, with links and text state", () => {
    renderSuggestions(payload(), [2, 1]);
    const list = screen.getByRole("list", { name: "Books from your library" });
    const links = within(list).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Programming Rust", "Rust for Web Developers"]);
    expect(links[0]).toHaveAttribute("href", "/book/b2");
    expect(links[0]).toHaveAttribute("aria-label", "Open Programming Rust by Lena Ortiz");
    expect(within(list).getByText("Lena Ortiz")).toBeInTheDocument();
    expect(within(list).getAllByText("PDF").length).toBeGreaterThan(0);
    expect(within(list).getByText("Not read")).toBeInTheDocument();
    expect(within(list).getByText("Matches: rust, web · 2 passages")).toBeInTheDocument();
    expect(screen.getByText("You asked for books, so I looked in your library.")).toBeInTheDocument();
    expect(screen.getByText("Cards show books from your library.")).toBeInTheDocument();
  });

  it("drops an unknown n and a known book that the model did not mention", () => {
    renderSuggestions(payload(), [9, 1]);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open Rust for Web Developers by Mara Klein" })).toBeInTheDocument();
    expect(screen.queryByText("Programming Rust")).not.toBeInTheDocument();
  });

  it("uses the explicit context note", () => {
    renderSuggestions(payload({ intent: "explicit" }), [1]);
    expect(screen.getByText("Books from your library.")).toBeInTheDocument();
  });

  it("renders the cover as decorative and falls back to the format", () => {
    const { container, unmount } = renderSuggestions(
      payload({ books: [book({ hasCover: true })] }),
      [1],
    );
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    unmount();
    const fallback = renderSuggestions(payload({ books: [book()] }), [1]);
    expect(fallback.container.querySelector("img")).toBeNull();
    expect(fallback.container.querySelector(".asst-suggestion-cover.placeholder")).toHaveTextContent("EPUB");
  });

  it("shows the unavailable and none states without cards", () => {
    const unavailable = renderSuggestions(payload({ status: "unavailable", books: [] }), []);
    expect(screen.getByRole("status")).toHaveTextContent("Book suggestions are not available right now.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    unavailable.unmount();

    const none = renderSuggestions(payload({ status: "none", books: [] }), []);
    expect(none.container).toBeEmptyDOMElement();
  });

  it("offers to turn the library on, but not when it is already on", () => {
    const onEnableLibrary = vi.fn();
    const off = renderSuggestions(
      payload({ status: "library_off", books: [] }),
      [],
      false,
      onEnableLibrary,
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn on Search my books" }));
    expect(onEnableLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Book suggestions need Search my books.")).toBeInTheDocument();
    off.unmount();

    renderSuggestions(payload({ status: "library_off", books: [] }), [], true, onEnableLibrary);
    expect(screen.queryByRole("button", { name: "Turn on Search my books" })).not.toBeInTheDocument();
  });

  it("shows no cards when the turn has no markers", () => {
    const { container } = renderSuggestions(payload(), []);
    expect(container).toBeEmptyDOMElement();
  });
});
