import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { Book } from "../../types";
import { ReaderBody } from "./ReaderBody";
import { useEpubReader } from "./useEpubReader";

const mocks = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const rendition = {
    themes: { fontSize: vi.fn() },
    on: vi.fn((type: string, callback: (...args: unknown[]) => void) => {
      handlers[type] = callback;
    }),
    currentLocation: vi.fn(() => ({ start: { cfi: "epubcfi(/6/2)", percentage: 0.5 }, end: { cfi: "epubcfi(/6/4)" } })),
    display: vi.fn(async () => undefined),
    next: vi.fn(async () => undefined),
    prev: vi.fn(async () => undefined),
    getRange: () => ({ toString: () => "quoted" }),
    annotations: { highlight: vi.fn(), remove: vi.fn() },
  };
  const book = {
    open: vi.fn(async () => ({})),
    renderTo: vi.fn(() => rendition),
    spine: { hooks: { serialize: { register: vi.fn() } }, get: vi.fn(() => ({})) },
    ready: Promise.resolve(),
    locations: {
      length: () => 2,
      load: vi.fn(),
      generate: vi.fn(async () => []),
      save: () => "locations",
      cfiFromLocation: () => "epubcfi(/6/6)",
      percentageFromCfi: () => 0.5,
      locationFromCfi: () => 1,
    },
    destroy: vi.fn(),
  };
  return { book, rendition, handlers };
});

vi.mock("epubjs", async (importOriginal) => ({
  ...await importOriginal<typeof import("epubjs")>(),
  default: () => mocks.book,
}));
vi.mock("./usePdfReader", () => ({
  usePdfReader: () => ({ page: 1, setPage: vi.fn(), numPages: 0 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rendition.currentLocation.mockReset().mockReturnValue({
    start: { cfi: "epubcfi(/6/2)", percentage: 0.5 }, end: { cfi: "epubcfi(/6/4)" },
  });
  for (const event of Object.keys(mocks.handlers)) delete mocks.handlers[event];
});
afterEach(() => vi.useRealTimers());

const book: Book = {
  id: "b1", title: "A Book", author: "", format: "epub", size: 10, addedAt: 0, hasCover: false, status: "ready", source: false,
};
const data = new ArrayBuffer(0);
const container = { current: document.createElement("div") } as RefObject<HTMLDivElement>;

describe("useEpubReader", () => {
  it("opens the book, tracks pages, navigates and reports selections", async () => {
    const scheduleProgress = vi.fn();
    const onSelection = vi.fn();
    const { result } = renderHook(() =>
      useEpubReader({
        book,
        data,
        container,
        initialPosition: "",
        notes: [{ id: "n1", bookId: "b1", location: "epubcfi(/6/2,/6/4)", label: "", quote: "", body: "", createdAt: 0, updatedAt: 0 }],
        scheduleProgress,
        flushProgress: vi.fn(),
        latestProgress: { current: { position: "", percentage: 0 } },
        onError: vi.fn(),
        onSelection,
      }),
    );

    await waitFor(() => expect(result.current.epubReady).toBe(true));
    expect(result.current.epubPage).toEqual({ page: 2, total: 2 });
    expect(scheduleProgress).toHaveBeenCalledWith({ position: "epubcfi(/6/2)", percentage: 0.5 });
    expect(mocks.rendition.annotations.highlight).toHaveBeenCalled();

    act(() => result.current.step(1));
    expect(mocks.rendition.next).toHaveBeenCalled();
    act(() => result.current.goToPage(1));
    expect(mocks.rendition.display).toHaveBeenCalledWith("epubcfi(/6/6)");
    expect(result.current.currentCfi()).toBe("epubcfi(/6/2)");
    expect(result.current.displayLocation("epubcfi(/6/8)")).toBe(true);

    act(() => mocks.handlers.selected?.("epubcfi(/6/2,/6/4)"));
    expect(onSelection).toHaveBeenCalledWith({ location: "epubcfi(/6/2,/6/4)", text: "quoted" });
  });
  it("retries a saved CFI until a narrow viewport reports the target on screen", async () => {
    vi.useFakeTimers();
    const startAt = "epubcfi(/6/2!/4/2/1:8)";
    mocks.rendition.currentLocation
      .mockReturnValueOnce({ start: { cfi: "epubcfi(/6/2!/4/2/1:2)", percentage: 0 }, end: { cfi: "epubcfi(/6/2!/4/2/1:4)" } })
      .mockReturnValueOnce({ start: { cfi: "epubcfi(/6/2!/4/2/1:4)", percentage: 0 }, end: { cfi: "epubcfi(/6/2!/4/2/1:6)" } })
      .mockReturnValue({ start: { cfi: startAt, percentage: 0.5 }, end: { cfi: "epubcfi(/6/2!/4/2/1:10)" } });
    const narrowContainer = { current: document.createElement("div") };
    Object.defineProperty(narrowContainer.current, "clientWidth", { value: 760 });
    const { result, unmount } = renderHook(() => useEpubReader({
      book, data, container: narrowContainer, initialPosition: startAt, notes: [],
      scheduleProgress: vi.fn(), flushProgress: vi.fn(),
      latestProgress: { current: { position: startAt, percentage: 0.5 } },
      onError: vi.fn(), onSelection: vi.fn(),
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.rendition.display).toHaveBeenCalledTimes(1);
    expect(result.current.epubReady).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.rendition.display).toHaveBeenCalledTimes(2);
    expect(result.current.epubReady).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mocks.rendition.display.mock.calls).toEqual([[startAt], [startAt], [startAt]]);
    expect(result.current.epubReady).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.rendition.display).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("attaches a rendition selection to the note submitted from the notes panel", async () => {
    const cfi = "epubcfi(/6/2,/6/4)";
    const api = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return new Response(JSON.stringify({
          id: "n1", bookId: book.id, ...JSON.parse(String(options.body)) as Record<string, unknown>,
          createdAt: 0, updatedAt: 0,
        }));
      }
      return new Response(JSON.stringify([]));
    });
    render(<ReaderBody book={book} data={data} progress={{ position: "", percentage: 0 }} jump="" api={api} />);
    await waitFor(() => expect(mocks.handlers.selected).toBeTypeOf("function"));
    act(() => mocks.handlers.selected(cfi));
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByText("Quote attached")).toBeInTheDocument();
    expect(screen.getByText("“quoted”")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "New note" }), { target: { value: "My note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(screen.getByText("My note")).toBeInTheDocument());
    const posted = api.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ body: "My note", quote: "quoted", location: cfi });
    expect(screen.queryByText("Quote attached")).not.toBeInTheDocument();
    expect(screen.getByText("“quoted”")).toBeInTheDocument();
  });

});
