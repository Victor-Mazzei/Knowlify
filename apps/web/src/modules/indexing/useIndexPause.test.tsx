import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIndexPause } from "./useIndexPause";

const body = (value: unknown) => new Response(JSON.stringify(value));

describe("useIndexPause", () => {
  it("pauses optimistically and confirms the persisted state", async () => {
    let resolve!: (response: Response) => void;
    const api = vi.fn(() => new Promise<Response>((done) => (resolve = done)));
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useIndexPause(api, false, refresh));

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.paused).toBe(true);
    expect(result.current.pending).toBe(true);
    expect(api).toHaveBeenCalledWith("/api/index/pause", { method: "POST" });

    await act(async () => {
      resolve(body({ paused: true }));
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.paused).toBe(true);
    expect(result.current.error).toBe("");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("resumes a paused queue through the resume endpoint", async () => {
    const api = vi.fn(async () => body({ paused: false }));
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useIndexPause(api, true, refresh));

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.paused).toBe(false);
    expect(api).toHaveBeenCalledWith("/api/index/resume", { method: "POST" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rolls the optimistic state back when the request fails", async () => {
    const api = vi.fn(async () => {
      throw new Error("offline");
    });
    const refresh = vi.fn(async () => undefined);
    const { result } = renderHook(() => useIndexPause(api, false, refresh));

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.paused).toBe(true);

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.paused).toBe(false);
    expect(result.current.error).toBe("offline");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the new state when the status refresh fails after a successful pause", async () => {
    const api = vi.fn(async () => body({ paused: true }));
    const refresh = vi.fn(async () => {
      throw new Error("status offline");
    });
    const { result } = renderHook(() => useIndexPause(api, false, refresh));

    await act(async () => {
      await result.current.toggle();
    });
    expect(result.current.paused).toBe(true);
    expect(result.current.error).toBe("");
  });
});
