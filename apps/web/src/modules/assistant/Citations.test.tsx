import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AnswerText } from "./Citations";
import type { RecommendedBook } from "./types";

const book: RecommendedBook = {
  n: 1,
  bookId: "b1",
  title: "Rust for Web Developers",
  author: "Mara Klein",
  format: "epub",
  language: "en",
  hasCover: false,
  coverRev: null,
  progress: { status: "unread", percentage: 0 },
  matched: ["rust"],
  evidence: [],
  source: "passages",
};

describe("AnswerText book markers", () => {
  it("turns a known [book:n] into a short chip link", () => {
    render(
      <MemoryRouter>
        <AnswerText text="Start with [book:1] today." citations={null} books={[book]} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Open Rust for Web Developers by Mara Klein" });
    expect(link).toHaveAttribute("href", "/book/b1");
    expect(link).toHaveTextContent("Rust for Web Developers");
    expect(screen.queryByText(/\[book:1\]/)).not.toBeInTheDocument();
  });

  it("renders nothing for an unknown [book:n]", () => {
    const { container } = render(
      <MemoryRouter>
        <AnswerText text="Start with [book:9] today." citations={null} books={[book]} />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent("Start with today.");
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps the existing unknown [n] text untouched", () => {
    const { container } = render(
      <MemoryRouter>
        <AnswerText text="A claim [9]." citations={null} />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent("A claim [9].");
  });
});
