import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TutorStatus } from "./TutorStatus";

describe("TutorStatus", () => {
  it("announces thinking with three decorative dots", () => {
    const { container } = render(<TutorStatus phase="thinking" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Thinking");
    expect(status.querySelector(".asst-status-dots")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".asst-status-dots > span")).toHaveLength(3);
  });

  it("names the writing phase without showing dots", () => {
    const { container } = render(<TutorStatus phase="writing" />);

    expect(screen.getByRole("status")).toHaveTextContent("Writing");
    expect(container.querySelector(".asst-status-dots")).toBeNull();
  });

  it("pulses the dots in sequence without any fixed visible label", () => {
    const css = readFileSync("src/modules/assistant/assistant.css", "utf8");
    const block = css.slice(css.indexOf("/* Answering indicator"), css.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(block).toContain(".asst-status-dots > span");
    expect(block).toContain("width: 6px");
    expect(block).toContain("animation: asst-dot-pulse 1.2s");
    expect(block).toContain("animation-delay: 150ms");
    expect(block).toContain("animation-delay: 300ms");
    expect(block).toContain("@keyframes asst-dot-pulse");
    expect(block).toContain("18% { opacity: 1; transform: translateY(-3px) scale(1); }");
    expect(block).not.toContain("asst-spinner");
  });

  it("keeps a slow opacity-only fade under reduced motion instead of freezing", () => {
    const css = readFileSync("src/modules/assistant/assistant.css", "utf8");
    const block = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
      css.indexOf("@keyframes asst-dot-fade"),
    );
    const fade = css.slice(css.indexOf("@keyframes asst-dot-fade"), css.indexOf(".asst-cite"));

    expect(block).toContain(".asst-status-dots > span");
    expect(block).toContain("animation: asst-dot-fade 1.8s");
    expect(block).toContain("animation-delay: 250ms");
    expect(block).toContain("animation-delay: 500ms");
    expect(block).not.toMatch(/animation:\s*none/);
    expect(block).not.toMatch(/transform|translate|scale/);
    expect(fade).toMatch(/@keyframes asst-dot-fade[\s\S]*opacity: 0\.4[\s\S]*opacity: 1/);
    expect(fade).not.toMatch(/transform|translate|scale/);
  });
});
