import { describe, expect, it } from "vitest";
import { createBookMarkerFilter, stripBookMarkers } from "../src/domain/assistant/bookMarkers.js";

describe("createBookMarkerFilter", () => {
  it("validates a marker split across deltas", () => {
    const filter = createBookMarkerFilter([1, 2]);
    expect(filter.push("[bo")).toBe("");
    expect(filter.push("ok:2]")).toBe("[book:2]");
    expect(filter.push("[book:")).toBe("");
    expect(filter.push("9]")).toBe("");
    expect(filter.flush()).toBe("");
    expect(filter.markers).toEqual([2]);
  });

  it("removes an invalid marker without leaking a bracket", () => {
    const filter = createBookMarkerFilter([1]);
    expect(filter.push("Try [book:9] and [book:1].")).toBe("Try  and [book:1].");
    expect(filter.flush()).toBe("");
    expect(filter.markers).toEqual([1]);
  });

  it("records each valid marker once, in order of appearance", () => {
    const filter = createBookMarkerFilter([1, 2, 3]);
    const text = filter.push("[book:3] then [book:1] then [book:3] and [book:2]");
    expect(text).toBe("[book:3] then [book:1] then [book:3] and [book:2]");
    expect(filter.markers).toEqual([3, 1, 2]);
  });

  it("normalizes case and leading zeros to the canonical marker", () => {
    const filter = createBookMarkerFilter([2]);
    expect(filter.push("[BOOK:02]")).toBe("[book:2]");
    expect(filter.markers).toEqual([2]);
  });

  it("passes citation markers and literal brackets through", () => {
    const filter = createBookMarkerFilter([1]);
    expect(filter.push("Claim [1], [99] and [note].")).toBe("Claim [1], [99] and [note].");
    expect(filter.flush()).toBe("");
    expect(filter.markers).toEqual([]);
  });

  it("flushes a literal partial prefix but drops an incomplete marker", () => {
    const literal = createBookMarkerFilter([1]);
    expect(literal.push("[bo")).toBe("");
    expect(literal.flush()).toBe("[bo");

    const marker = createBookMarkerFilter([1]);
    expect(marker.push("[book:1")).toBe("");
    expect(marker.flush()).toBe("");
    expect(marker.markers).toEqual([]);
  });

  it("handles a marker at the end of a single delta", () => {
    const filter = createBookMarkerFilter([1]);
    expect(filter.push("See [book:1]")).toBe("See [book:1]");
    expect(filter.flush()).toBe("");
  });

  it("drops an overlong marker-like run and keeps the remaining text", () => {
    const filter = createBookMarkerFilter([1]);
    const text = filter.push("[book:1234567890] tail");
    expect(text).toBe(" tail");
    expect(filter.flush()).toBe("");
  });
});

describe("stripBookMarkers", () => {
  it("removes only the marker and the single space before it", () => {
    expect(stripBookMarkers("Rust [book:1] and [book:2] with [3].")).toBe("Rust and with [3].");
    expect(stripBookMarkers("Claim [book:3].")).toBe("Claim.");
    expect(stripBookMarkers("[book:1] at the start")).toBe(" at the start");
    expect(stripBookMarkers("a\n[book:1] b")).toBe("a\n b");
    // A second space is not part of the marker gap and stays.
    expect(stripBookMarkers("a  [book:1] b")).toBe("a  b");
  });

  it("leaves numeric markers, tokens and indentation untouched", () => {
    expect(stripBookMarkers("Use list[1] to read second value.")).toBe("Use list[1] to read second value.");
    expect(stripBookMarkers("  if x:\n    print(items[0])  ")).toBe("  if x:\n    print(items[0])  ");
    expect(stripBookMarkers("Explain list[0] and [1, 2]")).toBe("Explain list[0] and [1, 2]");
  });

  it("ignores non-literal and overlong marker forms", () => {
    expect(stripBookMarkers("[book:1234] and [Book:3]")).toBe("[book:1234] and [Book:3]");
  });

  it("documents that fenced code is not special-cased", () => {
    expect(stripBookMarkers("```\nconst card = [book:1];\n```")).toBe("```\nconst card =;\n```");
  });
});
