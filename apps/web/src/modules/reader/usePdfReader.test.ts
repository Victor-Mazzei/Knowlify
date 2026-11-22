import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { Book, Progress } from "../../types";
import { pdfjsWasmUrl } from "./pdfjsAssets";
import { usePdfReader } from "./usePdfReader";

const pdfMocks = vi.hoisted(() => {
  const document = { numPages: 5, getPage: vi.fn() };
  const loadingTask = { promise: Promise.resolve(document), destroy: vi.fn() };
  return { document, loadingTask, getDocument: vi.fn(() => loadingTask) };
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
  pdfMocks.loadingTask.destroy.mockClear();
  pdfMocks.document.getPage.mockReset();
});

describe("usePdfReader", () => {
  it("loads a PDF and exposes its page count", async () => {
    const data = new ArrayBuffer(0);
    const { result, unmount } = renderHook(() =>
      usePdfReader({ book: book("pdf"), data, container, initialPosition: "2", scheduleProgress: vi.fn(), onError: vi.fn() }),
    );
    await waitFor(() => expect(result.current.numPages).toBe(5));
    expect(pdfMocks.getDocument).toHaveBeenCalledWith({ data: expect.any(ArrayBuffer), wasmUrl: pdfjsWasmUrl() });
    expect(result.current.page).toBe(2);
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    unmount();
    expect(pdfMocks.loadingTask.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not load a PDF for an EPUB", () => {
    const { result } = renderHook(() =>
      usePdfReader({ book: book("epub"), data: new ArrayBuffer(0), container, initialPosition: "", scheduleProgress: vi.fn(), onError: vi.fn() }),
    );
    expect(result.current.numPages).toBeUndefined();
    expect(pdfMocks.getDocument).not.toHaveBeenCalled();
  });

  it("destroys the loading task when unmounted before the PDF loads", async () => {
    let resolveDocument: (document: typeof pdfMocks.document) => void = () => {};
    const promise = new Promise<typeof pdfMocks.document>((resolve) => {
      resolveDocument = resolve;
    });
    const loadingTask = { promise, destroy: vi.fn() };
    pdfMocks.getDocument.mockReturnValueOnce(loadingTask);
    const onError = vi.fn();
    const { unmount } = renderHook(() =>
      usePdfReader({ book: book("pdf"), data: new ArrayBuffer(0), container, initialPosition: "1", scheduleProgress: vi.fn(), onError }),
    );

    unmount();
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1);

    resolveDocument(pdfMocks.document);
    await act(async () => {
      await promise;
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not reload or redraw the PDF when only the callbacks change identity", async () => {
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 640 });
    const target = { current: host } as RefObject<HTMLDivElement>;
    const render = vi.fn((_params: Record<string, unknown>) => ({ promise: Promise.resolve() }));
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
    const canvas = host.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ canvas, viewport: expect.objectContaining({ width: 600, height: 800 }) }),
    );
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
