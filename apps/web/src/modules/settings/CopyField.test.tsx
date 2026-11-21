import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyField } from "./CopyField";

afterEach(() => vi.restoreAllMocks());

describe("CopyField", () => {
  it("copies the value and gives feedback", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CopyField label="Catalog" value="https://example.test/opds" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://example.test/opds");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
