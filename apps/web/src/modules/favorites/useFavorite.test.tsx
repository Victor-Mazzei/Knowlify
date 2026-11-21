import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFavorite } from "./useFavorite";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useFavorite", () => {
  it("flips optimistically and settles on the server state", async () => {
    const reply = deferred<Response>();
    const api = vi.fn(() => reply.promise);
    const { result } = renderHook(() => useFavorite(api, "book-1", false));

    let toggled: Promise<void> | undefined;
    act(() => {
      toggled = result.current.toggle();
    });
    expect(result.current.favorite).toBe(true);
    expect(result.current.pending).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/books/book-1/favorite", { method: "PUT" });

    await act(async () => {
      reply.resolve(json({ favorite: true }));
      await toggled;
    });
    expect(result.current.favorite).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("rolls back and reports the error when the request fails", async () => {
    const reply = deferred<Response>();
    const api = vi.fn(() => reply.promise);
    const { result } = renderHook(() => useFavorite(api, "book-1", false));

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.favorite).toBe(true);

    await act(async () => {
      reply.resolve(json({ message: "Could not save" }, 500));
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.favorite).toBe(false);
    expect(result.current.error).toBe("Could not save");
  });

  it("uses DELETE to remove an existing favorite", async () => {
    const api = vi.fn(async () => json({ favorite: false }));
    const { result } = renderHook(() => useFavorite(api, "book-1", true));

    await act(async () => {
      await result.current.toggle();
    });
    expect(api).toHaveBeenCalledWith("/api/books/book-1/favorite", { method: "DELETE" });
    expect(result.current.favorite).toBe(false);
  });

  it("re-syncs when the detail's favorite arrives and resets on a new book", () => {
    const api = vi.fn(async () => json({ favorite: false }));
    const { result, rerender } = renderHook(
      ({ id, initial }) => useFavorite(api, id, initial),
      { initialProps: { id: "book-1", initial: false } },
    );

    rerender({ id: "book-1", initial: true });
    expect(result.current.favorite).toBe(true);

    rerender({ id: "book-2", initial: false });
    expect(result.current.favorite).toBe(false);
    expect(result.current.pending).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });

  it("ignores a second toggle while the first request is in flight", async () => {
    const reply = deferred<Response>();
    const api = vi.fn(() => reply.promise);
    const { result } = renderHook(() => useFavorite(api, "book-1", false));

    act(() => {
      void result.current.toggle();
      void result.current.toggle();
    });
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => {
      reply.resolve(json({ favorite: true }));
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.favorite).toBe(true);
  });
});
