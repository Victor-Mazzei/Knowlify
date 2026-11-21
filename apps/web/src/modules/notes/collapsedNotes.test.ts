import { beforeEach, describe, expect, it } from "vitest";
import {
  COLLAPSED_STORAGE_KEY,
  MAX_COLLAPSED_BOOKS,
  readCollapsedBookIds,
  saveCollapsedBookIds,
  toggleCollapsedBook,
} from "./collapsedNotes";

beforeEach(() => localStorage.clear());

describe("collapsed notes preference", () => {
  it("persists and restores collapsed book ids", () => {
    saveCollapsedBookIds(new Set(["b1", "b2"]));
    expect(readCollapsedBookIds()).toEqual(new Set(["b1", "b2"]));
    expect(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]")).toEqual(["b1", "b2"]);
  });

  it("toggles a book and keeps newly collapsed books at the end of the cap", () => {
    let ids = toggleCollapsedBook(new Set(), "b1");
    ids = toggleCollapsedBook(ids, "b2");
    expect(ids).toEqual(new Set(["b1", "b2"]));
    expect([...toggleCollapsedBook(ids, "b3")]).toEqual(["b1", "b2", "b3"]);
    expect(toggleCollapsedBook(ids, "b2")).toEqual(new Set(["b1"]));
  });

  it("caps the set at 500 books", () => {
    const ids = new Set(Array.from({ length: MAX_COLLAPSED_BOOKS + 20 }, (_, index) => `b${index}`));
    const capped = toggleCollapsedBook(ids, "newest");
    expect(capped.size).toBe(MAX_COLLAPSED_BOOKS);
    expect(capped.has("newest")).toBe(true);
    expect(capped.has("b0")).toBe(false);
  });

  it("ignores corrupt storage instead of breaking the page", () => {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, "not json");
    expect(readCollapsedBookIds()).toEqual(new Set());
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([1, "b1", null]));
    expect(readCollapsedBookIds()).toEqual(new Set(["b1"]));
  });
});
