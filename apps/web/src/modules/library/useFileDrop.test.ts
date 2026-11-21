import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileDrop } from "./useFileDrop";

function dragEvent(type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: files.length ? ["Files"] : [], files, dropEffect: "none" },
  });
  return event;
}

afterEach(() => vi.restoreAllMocks());

describe("useFileDrop", () => {
  it("tracks drag depth and hands the first dropped file to the callback", () => {
    const onFile = vi.fn();
    const file = new File(["x"], "book.pdf");
    const { result, unmount } = renderHook(() => useFileDrop(onFile));

    act(() => {
      window.dispatchEvent(dragEvent("dragenter", [file]));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(dragEvent("dragleave"));
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(dragEvent("dragenter", [file]));
      window.dispatchEvent(dragEvent("drop", [file]));
    });
    expect(result.current).toBe(false);
    expect(onFile).toHaveBeenCalledWith(file);
    unmount();
  });

  it("ignores drags that do not carry files", () => {
    const onFile = vi.fn();
    const { result } = renderHook(() => useFileDrop(onFile));

    act(() => {
      window.dispatchEvent(dragEvent("dragenter"));
      window.dispatchEvent(dragEvent("drop"));
    });
    expect(result.current).toBe(false);
    expect(onFile).not.toHaveBeenCalled();
  });
});
