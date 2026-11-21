import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { Book, Progress } from "../../types";
import { usePdfReader } from "./usePdfReader";

const pdfMocks = vi.hoisted(() => {
  const document = { numPages: 5, destroy: vi.fn(), getPage: vi.fn() };
  return { document, getDocument: vi.fn(() => ({ promise: Promise.resolve(document), destroy: vi.fn() })) };
});

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfMocks.getDocument,
}));

const book = (format: "pdf" | "epub"): Book => ({
  id: "b1", title: "A Book", author: "", format, size: 10, addedAt: 0, hasCover: false, status: "ready", source: false,
});

const container = { current: null } as unknown as RefObject<HTMLDivElement>;

beforeEach(() => {
  pdfMocks.getDocument.mockClear();
  pdfMocks.document.getPage.mockReset();
});

describe("usePdfReader", () => {
  it("loads a PDF and exposes its page count", async () => {
    const { result } = renderHook(() =>
      usePdfReader({ book: book("pdf"), data: new ArrayBuffer(0), container, initialPosition: "2", scheduleProgress: vi.fn(), onError: vi.fn() }),
    );
    await waitFor(() => expect(result.current.numPages).toBe(5));
    expect(result.current.page).toBe(2);
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);
  });

  it("does not load a PDF for an EPUB", () => {
    const { result } = renderHook(() =>
      usePdfReader({ book: book("epub"), data: new ArrayBuffer(0), container, initialPosition: "", scheduleProgress: vi.fn(), onError: vi.fn() }),
    );
    expect(result.current.numPages).toBeUndefined();
    expect(pdfMocks.getDocument).not.toHaveBeenCalled();
  });

  it("does not reload or redraw the PDF when only the callbacks change identity", async () => {
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 640 });
    const target = { current: host } as RefObject<HTMLDivElement>;
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    pdfMocks.document.getPage.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      getTextContent: async () => ({ items: [{ str: "Hello" }] }),
      render,
    });
    const firstSchedule = vi.fn();
    const firstError = vi.fn();
    const pdfBook = book("pdf");
    const data = new ArrayBuffer(0);
    const { result, rerender } = renderHook(
      ({ scheduleProgress, onError }: { scheduleProgress: (progress: Progress) => void; onError: (message: string) => void }) =>
        usePdfReader({
          book: pdfBook,
          data,
          container: target,
          initialPosition: "1",
          scheduleProgress,
          onError,
        }),
      { initialProps: { scheduleProgress: firstSchedule, onError: firstError } },
    );

    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    expect(pdfMocks.document.getPage).toHaveBeenCalledWith(1);
    expect(firstSchedule).toHaveBeenCalledWith({ position: "1", percentage: 0.2 });

    const secondSchedule = vi.fn();
    const secondError = vi.fn();
    rerender({ scheduleProgress: secondSchedule, onError: secondError });
    await act(async () => {
      await Promise.resolve();
    });

    expect(pdfMocks.getDocument).toHaveBeenCalledTimes(1);
    expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);

    act(() => result.current.setPage(2));
    await waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(pdfMocks.document.getPage).toHaveBeenLastCalledWith(2);
    expect(secondSchedule).toHaveBeenCalledWith({ position: "2", percentage: 0.4 });
    expect(firstSchedule).toHaveBeenCalledTimes(1);
    expect(secondError).not.toHaveBeenCalled();

    context.mockRestore();
  });
});
