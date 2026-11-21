import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { busyIndexStatus, idleIndexStatus, indexStatus } from "./fixtures";
import { INDEX_POLL_MS, useIndexStatus } from "./useIndexStatus";

const body = (value: unknown) => new Response(JSON.stringify(value));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useIndexStatus", () => {
  it("polls while the queue has work and stops when idle", async () => {
    vi.useFakeTimers();
    let status = busyIndexStatus;
    const api = vi.fn(async () => body(status));
    const { result, unmount } = renderHook(() => useIndexStatus(api, false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status?.counts.pending).toBe(6);
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(2);

    status = idleIndexStatus;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("keeps polling while a metadata scan runs, even with an idle queue", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => body(idleIndexStatus));
    const { unmount } = renderHook(() => useIndexStatus(api, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("starts polling after an explicit refresh finds queued work and stops once ready", async () => {
    vi.useFakeTimers();
    let status = idleIndexStatus;
    const api = vi.fn(async () => body(status));
    const onRevision = vi.fn();
    const { result, unmount } = renderHook(() => useIndexStatus(api, false, onRevision));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(onRevision).not.toHaveBeenCalled();

    status = busyIndexStatus;
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status?.counts.pending).toBe(6);
    expect(onRevision).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(3);

    status = indexStatus({ counts: { pending: 0, indexing: 0, ready: 8, error: 0 }, revision: 8 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(4);
    expect(result.current.status?.counts.pending).toBe(0);
    expect(onRevision).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS * 2);
    });
    expect(api).toHaveBeenCalledTimes(4);
    unmount();
  });

  it("reports revision changes, but not the first load", async () => {
    let revision = 1;
    const api = vi.fn(async () => body({ ...idleIndexStatus, revision }));
    const onRevision = vi.fn();
    const { result } = renderHook(() => useIndexStatus(api, false, onRevision));

    await act(async () => {
      await result.current.refresh();
    });
    expect(onRevision).not.toHaveBeenCalled();

    revision = 2;
    await act(async () => {
      await result.current.refresh();
    });
    expect(onRevision).toHaveBeenCalledTimes(1);
  });

  it("hides the feature when the server returns 404", async () => {
    const api = vi.fn(async () => {
      throw new ApiError(404, "Request failed (404)");
    });
    const { result } = renderHook(() => useIndexStatus(api, false));

    await waitFor(() => expect(result.current.available).toBe(false));
    expect(result.current.status).toBeNull();
  });

  it("starts polling when a focus refresh finds work", async () => {
    vi.useFakeTimers();
    let busy = false;
    const api = vi.fn(async () => body(busy ? busyIndexStatus : idleIndexStatus));
    renderHook(() => useIndexStatus(api, false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(1);

    busy = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
    });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("refreshes when the window regains focus", async () => {
    const api = vi.fn(async () => body(idleIndexStatus));
    renderHook(() => useIndexStatus(api, false));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  });

  it("starts a fresh query after the session identity changes and ignores the late 401", async () => {
    const old = deferred<Response>();
    const oldUnauthorized = vi.fn();
    const oldApi = vi.fn(async (_path: string, _init?: RequestInit) => {
      const response = await old.promise;
      if (response.status === 401) {
        // Same shape as useApi: report the 401 to the closure that owns the session.
        oldUnauthorized();
        throw new ApiError(401, "Your session expired. Please sign in again.");
      }
      return response;
    });
    const newApi = vi.fn(async (_path: string, _init?: RequestInit) => body(idleIndexStatus));
    const { result, rerender } = renderHook(({ api }: { api: ApiFn }) => useIndexStatus(api, false), {
      initialProps: { api: oldApi },
    });

    await waitFor(() => expect(oldApi).toHaveBeenCalledTimes(1));
    const oldSignal = (oldApi.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(oldSignal?.aborted).toBe(false);

    rerender({ api: newApi });
    await waitFor(() => expect(newApi).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toEqual(idleIndexStatus));
    // The in-flight request from the previous session is discarded, not reused.
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      old.resolve(new Response("", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The old 401 belongs to the previous API closure; the current state stays untouched.
    expect(oldUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual(idleIndexStatus);
    expect(result.current.available).toBe(true);
    expect(newApi).toHaveBeenCalledTimes(1);
  });

  it("does not let an older successful response overwrite the new session's status", async () => {
    const old = deferred<Response>();
    const stale = indexStatus({ counts: { pending: 4, indexing: 1, ready: 1, error: 0 }, revision: 9 });
    const fresh = indexStatus({ counts: { pending: 0, indexing: 0, ready: 3, error: 0 }, revision: 3 });
    const oldApi = vi.fn(() => old.promise);
    const newApi = vi.fn(async () => body(fresh));
    const onRevision = vi.fn();
    const { result, rerender } = renderHook(({ api }: { api: ApiFn }) => useIndexStatus(api, false, onRevision), {
      initialProps: { api: oldApi },
    });

    await waitFor(() => expect(oldApi).toHaveBeenCalledTimes(1));
    rerender({ api: newApi });
    await waitFor(() => expect(result.current.status).toEqual(fresh));

    await act(async () => {
      old.resolve(body(stale));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.status).toEqual(fresh);
    expect(onRevision).not.toHaveBeenCalled();
  });

  it("keeps a live scope after React's StrictMode remount", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) => body(idleIndexStatus));
    const { result } = renderHook(() => useIndexStatus(api, false), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.status).toEqual(idleIndexStatus));
    const signals = api.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.signal);
    // The simulated unmount aborts the first request; the remount starts a live one.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[signals.length - 1]?.aborted).toBe(false);
  });
});
