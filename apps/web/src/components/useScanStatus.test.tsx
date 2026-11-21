import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "./dialogs";
import { useScanStatus } from "./useScanStatus";

const status = (scanning: boolean, pending = 0) =>
  new Response(JSON.stringify({ scanning, pending, lastScanAt: null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useScanStatus", () => {
  it("refreshes the status and notifies when a scan finishes", async () => {
    let scanning = true;
    const api = vi.fn(async () => status(scanning, scanning ? 2 : 0));
    const onLibraryChange = vi.fn();
    const onSourcesChange = vi.fn();
    const { result, unmount } = renderHook(() => useScanStatus(api, onLibraryChange, onSourcesChange));

    await waitFor(() => expect(result.current.status.pending).toBe(2));
    scanning = false;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status.pending).toBe(0);
    expect(onLibraryChange).toHaveBeenCalledTimes(1);
    expect(onSourcesChange).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("starts a rescan through the API", async () => {
    const api = vi.fn(async (_path: string, init?: RequestInit) =>
      status(init?.method === "POST", init?.method === "POST" ? 1 : 0),
    );
    const { result, unmount } = renderHook(() => useScanStatus(api));

    await act(async () => {
      await result.current.rescan();
    });
    expect(api).toHaveBeenCalledWith("/api/scan", expect.objectContaining({ method: "POST" }));
    expect(result.current.status.scanning).toBe(true);
    unmount();
  });

  it("backs off after failures and warns once three fail in a row, then clears on recovery", async () => {
    vi.useFakeTimers();
    let reachable = false;
    const api = vi.fn(async () => {
      if (!reachable) throw new Error("offline");
      return status(true, 1);
    });
    const { result, unmount } = renderHook(() => useScanStatus(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(api).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBe(true);

    reachable = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(api).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBe(false);
    expect(result.current.status.scanning).toBe(true);
    unmount();
  });

  it("caps the retry delay at 30 seconds", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => {
      throw new Error("offline");
    });
    const { unmount } = renderHook(() => useScanStatus(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(api).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29999);
    });
    expect(api).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api).toHaveBeenCalledTimes(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(api).toHaveBeenCalledTimes(6);
    unmount();
  });

  it("leaves no pending timer after unmount", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => {
      throw new Error("offline");
    });
    const { unmount } = renderHook(() => useScanStatus(api));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh poll after the session identity changes and ignores the late 401", async () => {
    const old = deferred<Response>();
    const oldUnauthorized = vi.fn();
    const oldApi = vi.fn(async (_path: string, _init?: RequestInit) => {
      const response = await old.promise;
      if (response.status === 401) {
        oldUnauthorized();
        throw new Error("Your session expired. Please sign in again.");
      }
      return response;
    });
    const newApi = vi.fn(async (_path: string, _init?: RequestInit) => status(false, 0));
    const { result, rerender } = renderHook(({ api }: { api: ApiFn }) => useScanStatus(api), {
      initialProps: { api: oldApi },
    });

    await waitFor(() => expect(oldApi).toHaveBeenCalledTimes(1));
    const oldSignal = (oldApi.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(oldSignal?.aborted).toBe(false);

    rerender({ api: newApi });
    await waitFor(() => expect(newApi).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toEqual({ scanning: false, pending: 0, lastScanAt: null }));
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      old.resolve(new Response("", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(oldUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual({ scanning: false, pending: 0, lastScanAt: null });
    expect(result.current.error).toBe(false);
    expect(newApi).toHaveBeenCalledTimes(1);
  });

  it("does not let an older successful response overwrite the new session's status", async () => {
    const old = deferred<Response>();
    const oldApi = vi.fn(() => old.promise);
    const newApi = vi.fn(async () => status(false, 0));
    const { result, rerender } = renderHook(({ api }: { api: ApiFn }) => useScanStatus(api), {
      initialProps: { api: oldApi },
    });

    await waitFor(() => expect(oldApi).toHaveBeenCalledTimes(1));
    rerender({ api: newApi });
    await waitFor(() => expect(result.current.status).toEqual({ scanning: false, pending: 0, lastScanAt: null }));

    await act(async () => {
      old.resolve(status(true, 7));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toEqual({ scanning: false, pending: 0, lastScanAt: null });
  });
});
