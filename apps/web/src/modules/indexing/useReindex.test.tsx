import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReindex } from "./useReindex";
import type { ReindexResponse } from "./types";

describe("useReindex", () => {
  it("posts the scope and exposes the queued count", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify({ queued: 4 })));
    const { result } = renderHook(() => useReindex(api));

    let queued: ReindexResponse | null = null;
    await act(async () => {
      queued = await result.current.reindex("failed");
    });

    expect(api).toHaveBeenCalledWith(
      "/api/index/reindex",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ scope: "failed" }) }),
    );
    expect(queued).toEqual({ queued: 4 });
    expect(result.current.queued).toBe(4);
    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
  });

  it("surfaces API failures", async () => {
    const api = vi.fn(async () => {
      throw new Error("Indexing is off.");
    });
    const { result } = renderHook(() => useReindex(api));

    await act(async () => {
      await result.current.reindex("all");
    });
    expect(result.current.error).toBe("Indexing is off.");
    expect(result.current.queued).toBeNull();
  });
});
