import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logo } from "./Logo";

describe("Logo", () => {
  it("renders a decorative mark in the theme tokens by default", () => {
    const { container } = render(<Logo size={20} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("height", "20");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
    expect(svg?.querySelector("rect")).toHaveAttribute("fill", "var(--accent)");
    expect(svg?.querySelector("g")).toHaveAttribute("fill", "var(--on-accent)");
    expect(svg?.querySelectorAll("path")).toHaveLength(3);
  });

  it("exposes an accessible name when it is not decorative", () => {
    render(<Logo label="Knowlify" />);
    const mark = screen.getByRole("img", { name: "Knowlify" });
    expect(mark).not.toHaveAttribute("aria-hidden");
    expect(mark).toHaveAttribute("width", "24");
  });

  it("renders the mono variant without a tile and in currentColor", () => {
    const { container } = render(<Logo variant="mono" className="custom" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("logo", "logo--mono", "custom");
    expect(svg?.querySelector("rect")).toBeNull();
    expect(svg?.querySelector("g")).toHaveAttribute("fill", "currentColor");
  });
});
