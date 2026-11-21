import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DuplicatesSkippedLink } from "./DuplicatesSkippedLink";

const renderLink = (count: number) =>
  render(
    <MemoryRouter>
      <DuplicatesSkippedLink count={count} />
    </MemoryRouter>,
  );

describe("DuplicatesSkippedLink", () => {
  it("links the skipped count to the duplicates card", () => {
    renderLink(214);
    const link = screen.getByRole("link", { name: /214 duplicates skipped/ });
    expect(link).toHaveAttribute("href", "/settings/duplicates");
    expect(link).toHaveTextContent("214 duplicates skipped");
  });

  it("uses the singular form", () => {
    renderLink(1);
    expect(screen.getByRole("link", { name: /1 duplicate skipped/ })).toBeInTheDocument();
  });
});
