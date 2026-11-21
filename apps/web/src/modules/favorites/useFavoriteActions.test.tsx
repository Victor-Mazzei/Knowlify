import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../../types";
import { useFavoriteActions } from "./useFavoriteActions";

const book: Book = {
  id: "b1",
  title: "A Book",
  author: "An Author",
  format: "epub",
  size: 1,
  addedAt: 0,
  hasCover: false,
  status: "ready",
  source: false,
  favorite: false,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("useFavoriteActions", () => {
  it("flips immediately, saves the server state and reports the change", async () => {
    const request = deferred<Response>();
    const api = vi.fn(() => request.promise);
    const patchFavorites = vi.fn();
    const onChanged = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useFavoriteActions({ api, patchFavorites, onChanged, onError }),
    );

    act(() => result.current.toggleFavorite(book));
    expect(patchFavorites).toHaveBeenLastCalledWith(expect.any(Function), true);
    expect(result.current.pendingIds.has("b1")).toBe(true);

    await act(async () => {
      request.resolve(new Response(JSON.stringify({ favorite: true }), { status: 200 }));
      await request.promise;
    });

    await waitFor(() => expect(result.current.pendingIds.size).toBe(0));
    expect(patchFavorites).toHaveBeenLastCalledWith(expect.any(Function), true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("restores the previous value and exposes the error on failure", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify({ message: "No" }), { status: 500 }));
    const patchFavorites = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useFavoriteActions({ api, patchFavorites, onChanged: vi.fn(), onError }),
    );

    await act(async () => {
      result.current.toggleFavorite({ ...book, favorite: true });
    });

    await waitFor(() => expect(result.current.pendingIds.size).toBe(0));
    expect(patchFavorites).toHaveBeenLastCalledWith(expect.any(Function), true);
    expect(onError).toHaveBeenCalledWith("No");
  });

  it("ignores a second click while the first request is in flight", () => {
    const request = deferred<Response>();
    const api = vi.fn(() => request.promise);
    const { result } = renderHook(() =>
      useFavoriteActions({ api, patchFavorites: vi.fn(), onChanged: vi.fn(), onError: vi.fn() }),
    );

    act(() => {
      result.current.toggleFavorite(book);
      result.current.toggleFavorite(book);
    });

    expect(api).toHaveBeenCalledTimes(1);
  });
});
