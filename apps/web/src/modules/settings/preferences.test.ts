import { beforeEach, describe, expect, it } from "vitest";
import {
  LIBRARY_SORT_KEY,
  readFontSize,
  readLibrarySort,
  readLibraryView,
  saveLibrarySort,
  saveLibraryView,
} from "./preferences";

beforeEach(() => localStorage.clear());

describe("settings preferences", () => {
  it("reads a valid font size and falls back otherwise", () => {
    localStorage.setItem("knowlify.reader.fontSize", "120");
    expect(readFontSize()).toBe(120);
    localStorage.setItem("knowlify.reader.fontSize", "999");
    expect(readFontSize()).toBe(100);
  });

  it("reads and saves the library view", () => {
    expect(readLibraryView()).toBe("grid");
    saveLibraryView("table");
    expect(readLibraryView()).toBe("table");
  });

  it("reads and saves the library sort, keeping 'never chosen' distinct from 'added'", () => {
    expect(readLibrarySort()).toBeNull();
    saveLibrarySort("author");
    expect(localStorage.getItem(LIBRARY_SORT_KEY)).toBe("author");
    expect(readLibrarySort()).toBe("author");
    saveLibrarySort("reading");
    expect(readLibrarySort()).toBe("reading");
    localStorage.setItem(LIBRARY_SORT_KEY, "unknown");
    expect(readLibrarySort()).toBeNull();
  });
});
