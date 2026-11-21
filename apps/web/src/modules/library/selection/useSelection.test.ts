import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toBookSelection, useSelection } from "./useSelection";

const loaded = ["a", "b", "c", "d", "e"];

describe("useSelection", () => {
  it("toggles one id and keeps the anchor for a later range", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("b", {}, loaded));
    expect([...result.current.ids]).toEqual(["b"]);
    expect(result.current.count).toBe(1);
    expect(result.current.isSelected("b")).toBe(true);

    act(() => result.current.toggle("d", { shift: true }, loaded));
    expect([...result.current.ids].sort()).toEqual(["b", "c", "d"]);

    act(() => result.current.toggle("d", {}, loaded));
    expect([...result.current.ids].sort()).toEqual(["b", "c"]);
  });

  it("adds the whole interval between the anchor and the clicked row", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("a", {}, loaded));
    act(() => result.current.toggle("c", { shift: true }, loaded));
    expect([...result.current.ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("selects and deselects every loaded row from the header", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggleLoaded(loaded, "", 5));
    expect(result.current.count).toBe(5);

    act(() => result.current.toggleLoaded(loaded, "", 5));
    expect(result.current.count).toBe(0);
  });

  it("keeps the server-side all-results mode until a row is clicked or it is cleared", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.selectAllResults("format=pdf", 1234));
    expect(result.current.all).toEqual({ filterKey: "format=pdf", total: 1234 });
    expect(result.current.count).toBe(1234);
    expect(result.current.isSelected("anything")).toBe(true);

    act(() => result.current.toggle("b", {}, loaded));
    expect(result.current.all).toBeNull();
    expect([...result.current.ids]).toEqual(["b"]);

    act(() => result.current.selectAllResults("format=pdf", 1234));
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
  });

  it("replaces the set with the remainder of a partial deletion", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("a", {}, loaded));
    act(() => result.current.toggle("b", {}, loaded));
    act(() => result.current.replace(["b", "c"]));
    expect([...result.current.ids]).toEqual(["b", "c"]);
    expect(result.current.anchorId).toBeNull();

    act(() => result.current.selectAllResults("", 10));
    act(() => result.current.replace(["c"]));
    expect(result.current.all).toBeNull();
    expect(result.current.isSelected("c")).toBe(true);
  });

  it("builds the id or filter payload the bulk endpoints expect", () => {
    const { result } = renderHook(() => useSelection());
    expect(toBookSelection(result.current, { format: "pdf" })).toBeNull();

    act(() => result.current.toggle("a", {}, loaded));
    expect(toBookSelection(result.current, { format: "pdf" })).toEqual({ ids: ["a"] });

    act(() => result.current.selectAllResults("format=pdf", 42));
    expect(toBookSelection(result.current, { format: "pdf" })).toEqual({
      filter: { format: "pdf" },
      expectedTotal: 42,
    });
    expect(toBookSelection(result.current, null)).toBeNull();
  });
});
