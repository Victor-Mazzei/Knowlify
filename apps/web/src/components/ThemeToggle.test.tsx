import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setTheme } from "../services/theme";
import { ThemeToggle } from "./ThemeToggle";

afterEach(() => setTheme("system"));

describe("ThemeToggle", () => {
  it("cycles the theme and updates its label", () => {
    setTheme("system");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /Theme: System/ }));
    expect(screen.getByRole("button", { name: /Theme: Light/ })).toBeInTheDocument();
  });
});
