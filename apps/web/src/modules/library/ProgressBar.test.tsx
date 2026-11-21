import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("renders nothing when the book has no usable progress", () => {
    const { container } = render(
      <>
        <ProgressBar />
        <ProgressBar percentage={null} />
        <ProgressBar percentage={0} />
        <ProgressBar percentage={Number.NaN} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the percentage read and spells out what is left", () => {
    render(<ProgressBar percentage={0.42} />);
    expect(screen.getByText("58% left")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Reading progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuetext", "58% left");
  });

  it("shows a full bar and Finished at the end of the book", () => {
    render(<ProgressBar percentage={0.995} />);
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Reading progress" })).toHaveAttribute("aria-valuenow", "100");
  });
});
