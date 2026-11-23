import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecommendControl } from "./RecommendControl";

const base = {
  mode: "auto" as const,
  onModeChange: vi.fn(),
  armed: false,
  onArm: vi.fn(),
  useLibrary: true,
  libraryAvailable: true,
  disabled: false,
};

describe("RecommendControl", () => {
  it("arms the explicit request and shows the Auto preference", () => {
    const onArm = vi.fn();
    render(<RecommendControl {...base} onArm={onArm} />);
    const button = screen.getByRole("button", { name: "Recommend books" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("switch", { name: /Book suggestions/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Auto looks for books in your library when you ask for books to read. Book titles and short excerpts are sent to the model.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(button);
    expect(onArm).toHaveBeenCalledWith(true);
  });

  it("shows the armed state and turns suggestions off", () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <RecommendControl {...base} armed onModeChange={onModeChange} />,
    );
    expect(screen.getByRole("button", { name: "Recommend books" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("switch", { name: /Book suggestions/ }));
    expect(onModeChange).toHaveBeenCalledWith("off");

    rerender(<RecommendControl {...base} mode="off" onModeChange={onModeChange} />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Book suggestions/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(screen.getByRole("switch", { name: /Book suggestions/ }));
    expect(onModeChange).toHaveBeenLastCalledWith("auto");
  });

  it("disables the request and explains how to turn the library on", () => {
    render(<RecommendControl {...base} useLibrary={false} />);
    expect(screen.getByRole("button", { name: "Recommend books" })).toBeDisabled();
    expect(screen.getByText("Turn on Use my library to get book suggestions.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("disables the request when the server has no search index", () => {
    render(<RecommendControl {...base} libraryAvailable={false} />);
    expect(screen.getByRole("button", { name: "Recommend books" })).toBeDisabled();
    expect(screen.getByText("Book suggestions need the search index.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("locks both controls during a stream", () => {
    render(<RecommendControl {...base} disabled />);
    expect(screen.getByRole("button", { name: "Recommend books" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Book suggestions/ })).toBeDisabled();
  });
});
