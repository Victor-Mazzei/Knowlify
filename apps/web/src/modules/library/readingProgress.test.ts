import { describe, expect, it } from "vitest";
import { formatRemaining } from "./readingProgress";

describe("formatRemaining", () => {
  it.each([
    [0, null],
    [0.004, null],
    [-0.2, null],
    [Number.NaN, null],
    [undefined, null],
    [null, null],
    [0.005, { read: 1, label: "99% left" }],
    [0.42, { read: 42, label: "58% left" }],
    [0.985, { read: 98, label: "2% left" }],
    [0.99, { read: 100, label: "Finished" }],
    [1, { read: 100, label: "Finished" }],
    [1.4, { read: 100, label: "Finished" }],
  ])("formats %s", (percentage, expected) => {
    expect(formatRemaining(percentage)).toEqual(expected);
  });
});
