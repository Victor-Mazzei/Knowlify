import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SELECTION_LIMIT, toBookSelection, useSelection } from "./useSelection";

const loaded = ["a", "b", "c", "d", "e"];

const manyIds = (count: number, prefix = "id") =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

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

  it("selects a backwards shift range from the anchor towards the clicked row", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("e", {}, loaded));
    act(() => result.current.toggle("b", { shift: true }, loaded));
    expect([...result.current.ids].sort()).toEqual(["b", "c", "d", "e"]);
    expect(result.current.anchorId).toBe("e");
  });

  it("keeps ids outside the shift range selected", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("e", {}, loaded));
    act(() => result.current.toggle("a", {}, loaded));
    act(() => result.current.toggle("c", { shift: true }, loaded));
    expect([...result.current.ids].sort()).toEqual(["a", "b", "c", "e"]);
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

  it("accepts the 100th id and blocks the 101st until a slot is freed", () => {
    const ids = manyIds(SELECTION_LIMIT + 1);
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of ids.slice(0, SELECTION_LIMIT)) result.current.toggle(id);
    });
    expect(result.current.count).toBe(SELECTION_LIMIT);

    act(() => result.current.toggle(ids[SELECTION_LIMIT]!));
    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(result.current.isSelected(ids[SELECTION_LIMIT]!)).toBe(false);

    act(() => result.current.toggle(ids[0]!));
    expect(result.current.count).toBe(SELECTION_LIMIT - 1);
    act(() => result.current.toggle(ids[SELECTION_LIMIT]!));
    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(result.current.isSelected(ids[SELECTION_LIMIT]!)).toBe(true);
  });

  it("cuts a forward shift range at the limit while keeping the clicked row", () => {
    const ids = manyIds(150);
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle(ids[0]!, {}, ids));
    act(() => result.current.toggle(ids[149]!, { shift: true }, ids));

    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(result.current.isSelected(ids[0]!)).toBe(true); // anchor
    expect(result.current.isSelected(ids[98]!)).toBe(true); // last row that fits from the anchor
    expect(result.current.isSelected(ids[99]!)).toBe(false); // far end
    expect(result.current.isSelected(ids[149]!)).toBe(true); // clicked row
  });

  it("cuts a backwards shift range at the limit while keeping the clicked row", () => {
    const ids = manyIds(150);
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle(ids[149]!, {}, ids));
    act(() => result.current.toggle(ids[0]!, { shift: true }, ids));

    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(result.current.isSelected(ids[0]!)).toBe(true); // clicked row
    expect(result.current.isSelected(ids[51]!)).toBe(true); // last row that fits from the anchor
    expect(result.current.isSelected(ids[50]!)).toBe(false); // far end
    expect(result.current.isSelected(ids[149]!)).toBe(true); // anchor
  });

  it("gives the last slot to the clicked row near the limit", () => {
    const ids = manyIds(150);
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of ids.slice(0, SELECTION_LIMIT - 1)) result.current.toggle(id);
    });
    act(() => result.current.toggle(ids[149]!, { shift: true }, ids));

    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(result.current.isSelected(ids[0]!)).toBe(true); // earlier selections kept
    expect(result.current.isSelected(ids[SELECTION_LIMIT - 2]!)).toBe(true); // anchor
    expect(result.current.isSelected(ids[149]!)).toBe(true); // clicked row
    expect(result.current.isSelected(ids[SELECTION_LIMIT - 1]!)).toBe(false);
  });

  it("keeps every earlier id when the shift range has no room left", () => {
    const ids = manyIds(150);
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of ids.slice(0, SELECTION_LIMIT)) result.current.toggle(id);
    });
    const previous = [...result.current.ids];
    act(() => result.current.toggle(ids[149]!, { shift: true }, ids));

    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect([...result.current.ids]).toEqual(previous);
    expect(result.current.isSelected(ids[149]!)).toBe(false);
  });

  it("caps select-all of a page on top of an earlier page", () => {
    const firstPage = manyIds(SELECTION_LIMIT - 40, "page-1");
    const secondPage = manyIds(60, "page-2");
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of firstPage) result.current.toggle(id);
    });
    expect(result.current.count).toBe(60);

    act(() => result.current.toggleLoaded(secondPage, "", 120));
    expect(result.current.count).toBe(SELECTION_LIMIT);
    expect(secondPage.slice(0, 40).every((id) => result.current.isSelected(id))).toBe(true);
    expect(secondPage.slice(40).some((id) => result.current.isSelected(id))).toBe(false);

    // A fully selected page can still be unselected.
    act(() => result.current.clear());
    act(() => {
      for (const id of firstPage.slice(0, 40)) result.current.toggle(id);
    });
    act(() => result.current.toggleLoaded(secondPage, "", 120));
    expect(result.current.count).toBe(SELECTION_LIMIT);
    act(() => result.current.toggleLoaded(secondPage, "", 120));
    expect(result.current.count).toBe(40);
  });

  it("deselects a capped loaded page on the next header click instead of getting stuck", () => {
    const loadedIds = manyIds(150, "loaded");
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggleLoaded(loadedIds, "", 150));
    expect(result.current.count).toBe(SELECTION_LIMIT);

    act(() => result.current.toggleLoaded(loadedIds, "", 150));
    expect(result.current.count).toBe(0);
    expect(result.current.ids.size).toBe(0);
  });

  it("keeps ids from earlier pages when the capped loaded page is deselected", () => {
    const previous = manyIds(40, "previous");
    const loadedIds = manyIds(150, "loaded");
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of previous) result.current.toggle(id);
    });
    act(() => result.current.toggleLoaded(loadedIds, "", 190));
    expect(result.current.count).toBe(SELECTION_LIMIT);

    act(() => result.current.toggleLoaded(loadedIds, "", 190));
    expect(result.current.count).toBe(40);
    expect(previous.every((id) => result.current.isSelected(id))).toBe(true);
    expect(loadedIds.some((id) => result.current.isSelected(id))).toBe(false);
  });

  it("selects and then clears a fully loaded page without touching earlier pages", () => {
    const previous = manyIds(10, "previous");
    const loadedIds = manyIds(40, "loaded");
    const { result } = renderHook(() => useSelection());
    act(() => {
      for (const id of previous) result.current.toggle(id);
    });
    act(() => result.current.toggleLoaded(loadedIds, "", 50));
    expect(result.current.count).toBe(50);
    expect(loadedIds.every((id) => result.current.isSelected(id))).toBe(true);

    act(() => result.current.toggleLoaded(loadedIds, "", 50));
    expect(result.current.count).toBe(10);
    expect(loadedIds.some((id) => result.current.isSelected(id))).toBe(false);
    expect(previous.every((id) => result.current.isSelected(id))).toBe(true);
  });

  it("leaves the server-side all-results mode uncapped", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.selectAllResults("", 20_000));
    expect(result.current.count).toBe(20_000);
    expect(result.current.ids.size).toBe(0);
  });
});
