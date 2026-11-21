import { describe, expect, it, vi } from "vitest";
import { applyTheme, getTheme, nextTheme, setTheme, subscribeTheme } from "./theme";

describe("theme", () => {
  it("reads and cycles stored themes", () => {
    localStorage.setItem("knowlify.theme", "dark");
    expect(getTheme()).toBe("dark");
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });

  it("applies and broadcasts theme changes", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeTheme(callback);
    setTheme("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(callback).toHaveBeenCalledWith("dark");
    unsubscribe();
    applyTheme("system");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
