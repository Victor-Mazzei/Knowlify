import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_RETURN_CONTENT_POLL_MS,
  LIBRARY_RETURN_CONTENT_TIMEOUT_MS,
  LIBRARY_RETURN_KEY,
  libraryHref,
  librarySearchMatches,
  readLibraryReturn,
  rememberLibraryReturn,
  useLibraryReturnScroll,
  type LibraryReturnScrollOptions,
} from "./libraryReturn";

const setWindowScroll = (value: number) => {
  Object.defineProperty(window, "scrollY", { configurable: true, value });
};

const setScrollHeight = (value: number) => {
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value });
};

const renderReturn = (initial: LibraryReturnScrollOptions) =>
  renderHook((props: LibraryReturnScrollOptions) => useLibraryReturnScroll(props), { initialProps: initial });

afterEach(() => {
  vi.useRealTimers();
  setWindowScroll(0);
  setScrollHeight(0);
  vi.restoreAllMocks();
});

describe("libraryReturn", () => {
  it("remembers and reads the query string and offset", () => {
    setWindowScroll(640);
    rememberLibraryReturn("?q=river&sort=title");
    expect(readLibraryReturn()).toEqual({ search: "?q=river&sort=title", scrollY: 640 });
  });

  it("ignores an invalid or foreign stored value", () => {
    sessionStorage.setItem(LIBRARY_RETURN_KEY, JSON.stringify({ search: "no-question-mark", scrollY: 10 }));
    expect(readLibraryReturn()).toBeNull();
    sessionStorage.setItem(LIBRARY_RETURN_KEY, "not json");
    expect(readLibraryReturn()).toBeNull();
  });

  it("builds the breadcrumb href from the captured query only", () => {
    expect(libraryHref("?q=river")).toBe("/?q=river");
    expect(libraryHref("")).toBe("/");
    expect(libraryHref("https://example.com")).toBe("/");
  });

  it("matches the same Library view and tolerates a sort materialized on load", () => {
    expect(librarySearchMatches("?q=river&sort=title", "q=river&sort=title")).toBe(true);
    expect(librarySearchMatches("?q=river", "q=river")).toBe(true);
    expect(librarySearchMatches("?q=river", "?q=river&sort=title")).toBe(true);
    expect(librarySearchMatches("?format=pdf", "?format=pdf&sort=title")).toBe(true);
    expect(librarySearchMatches("?q=river&sort=title", "?q=river&sort=reading")).toBe(false);
    expect(librarySearchMatches("?q=river", "?q=lake")).toBe(false);
    expect(librarySearchMatches("?q=river", "?q=river&format=pdf")).toBe(false);
    expect(librarySearchMatches("not a query", "?q=river")).toBe(false);
  });

  it("restores the scroll after the first page loads and consumes the entry", async () => {
    setWindowScroll(640);
    rememberLibraryReturn("?q=river");
    setScrollHeight(5000);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?q=river", loaded: false, empty: false });
    expect(scrollTo).not.toHaveBeenCalled();

    rerender({ search: "?q=river", loaded: true, empty: false });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: "auto" }));
    expect(readLibraryReturn()).toBeNull();
  });

  it("consumes the entry immediately when the returned result is empty", async () => {
    setWindowScroll(1400);
    rememberLibraryReturn("?q=nothing");
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?q=nothing", loaded: false, empty: false });
    rerender({ search: "?q=nothing", loaded: true, empty: true });

    await waitFor(() => expect(readLibraryReturn()).toBeNull());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("discards an entry captured for another Library URL without restoring it", async () => {
    setWindowScroll(900);
    rememberLibraryReturn("?q=river");
    setScrollHeight(5000);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    renderReturn({ search: "?q=lake", loaded: true, empty: false });

    await waitFor(() => expect(readLibraryReturn()).toBeNull());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("waits for late content instead of discarding the entry", async () => {
    vi.useFakeTimers();
    setWindowScroll(900);
    rememberLibraryReturn("?q=river");
    setScrollHeight(400);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?q=river", loaded: false, empty: false });
    rerender({ search: "?q=river", loaded: true, empty: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_RETURN_CONTENT_POLL_MS * 2);
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(readLibraryReturn()).not.toBeNull();

    setScrollHeight(5000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_RETURN_CONTENT_POLL_MS * 2);
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });
    expect(readLibraryReturn()).toBeNull();
  });

  it("gives up and consumes the entry when the page never grows enough", async () => {
    vi.useFakeTimers();
    setWindowScroll(900);
    rememberLibraryReturn("?q=river");
    setWindowScroll(0);
    setScrollHeight(400);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?q=river", loaded: false, empty: false });
    rerender({ search: "?q=river", loaded: true, empty: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        LIBRARY_RETURN_CONTENT_TIMEOUT_MS + LIBRARY_RETURN_CONTENT_POLL_MS * 2,
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(readLibraryReturn()).toBeNull();
  });

  it("cancels a pending restore when the Library moves to another query", async () => {
    vi.useFakeTimers();
    setWindowScroll(900);
    rememberLibraryReturn("?q=river");
    setScrollHeight(5000);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?q=river", loaded: false, empty: false });
    rerender({ search: "?q=lake", loaded: true, empty: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_RETURN_CONTENT_POLL_MS * 4);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(readLibraryReturn()).toBeNull();
  });

  it("cancels a pending restore when the Library unmounts", async () => {
    vi.useFakeTimers();
    setWindowScroll(900);
    rememberLibraryReturn("?q=river");
    setScrollHeight(5000);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { unmount } = renderReturn({ search: "?q=river", loaded: true, empty: false });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_RETURN_CONTENT_POLL_MS * 4);
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps a matched return when only the sort is materialized into the URL", async () => {
    setWindowScroll(640);
    rememberLibraryReturn("?format=pdf");
    setScrollHeight(5000);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    const { rerender } = renderReturn({ search: "?format=pdf", loaded: false, empty: false });
    rerender({ search: "?format=pdf&sort=title", loaded: true, empty: false });

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: "auto" }));
    expect(readLibraryReturn()).toBeNull();
  });
});
