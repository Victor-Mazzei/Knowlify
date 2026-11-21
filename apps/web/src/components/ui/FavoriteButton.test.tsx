import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FavoriteButton } from "./FavoriteButton";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("FavoriteButton", () => {
  it("exposes the toggle state and emits once per click", () => {
    const onToggle = vi.fn();
    render(<FavoriteButton favorite={false} onToggle={onToggle} bookTitle="Dune" />);
    const button = screen.getByRole("button", { name: "Add to favorites: Dune" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("names the remove action when the book is already a favorite", () => {
    render(<FavoriteButton favorite onToggle={vi.fn()} bookTitle="Dune" />);
    expect(screen.getByRole("button", { name: "Remove from favorites: Dune" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a star inside a card from activating the card link", () => {
    const onCardClick = vi.fn();
    const onToggle = vi.fn();
    render(
      <div onClick={onCardClick}>
        <FavoriteButton favorite={false} onToggle={onToggle} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("shows a visible label in the full-size variant and stays icon-only when compact", () => {
    const { rerender } = render(
      <FavoriteButton favorite={false} onToggle={vi.fn()} showLabel />,
    );
    expect(screen.getByText("Favorite")).toBeInTheDocument();
    rerender(<FavoriteButton favorite={false} onToggle={vi.fn()} showLabel compact />);
    expect(screen.queryByText("Favorite")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to favorites" })).toHaveClass(
      "favorite-button--compact",
    );
  });

  it("does not emit while disabled", () => {
    const onToggle = vi.fn();
    render(<FavoriteButton favorite={false} onToggle={onToggle} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("FavoriteButton styles", () => {
  it("fills the star path when pressed, since the path itself has fill=none", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ui/FavoriteButton.css"), "utf8");
    expect(css).toMatch(/\[aria-pressed="true"\]\s+\.favorite-button-icon\s+path\s*\{\s*fill:\s*currentColor/);
  });
});
