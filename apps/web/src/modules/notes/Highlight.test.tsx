import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Highlight } from "./Highlight";

describe("Highlight", () => {
  it("marks the matching term case-insensitively", () => {
    render(<Highlight text="Hello World" term="world" />);
    expect(screen.getByText("World").tagName).toBe("MARK");
  });

  it("renders plain text when the term is empty or absent", () => {
    render(<Highlight text="Hello World" term=" " />);
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });
});
