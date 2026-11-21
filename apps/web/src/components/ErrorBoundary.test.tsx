import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("boom");
}

const silence = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("shows the error message and the brand mark when a child throws", () => {
    silence();
    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    const mark = container.querySelector(".brand svg");
    expect(mark).toHaveAttribute("width", "32");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });
});
