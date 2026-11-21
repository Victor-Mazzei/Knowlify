import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReadingProgress } from "./useReadingProgress";

afterEach(() => vi.useRealTimers());

describe("useReadingProgress", () => {
  it("debounces progress and flushes it immediately", () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => new Response("{}"));
    const { result } = renderHook(() => useReadingProgress(api, "b1", { position: "", percentage: 0 }));

    act(() => result.current.scheduleProgress({ position: "10", percentage: 0.1 }));
    expect(result.current.latestProgress.current.position).toBe("10");
    expect(api).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(500));
    expect(api).toHaveBeenCalledWith("/api/books/b1/progress", expect.objectContaining({ method: "PUT" }));

    act(() => result.current.scheduleProgress({ position: "20", percentage: 0.2 }));
    act(() => result.current.flushProgress());
    expect(api).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(500));
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("exposes the live percentage as soon as progress is scheduled", () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => new Response("{}"));
    const { result } = renderHook(() => useReadingProgress(api, "b1", { position: "", percentage: 0.1 }));

    expect(result.current.percentage).toBe(0.1);
    act(() => result.current.scheduleProgress({ position: "20", percentage: 0.42 }));
    expect(result.current.percentage).toBe(0.42);
    expect(api).not.toHaveBeenCalled();
  });
});
