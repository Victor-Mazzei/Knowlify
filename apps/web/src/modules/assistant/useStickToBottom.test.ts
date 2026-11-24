import { describe, expect, it } from "vitest";
import { isNearBottom, NEAR_BOTTOM_PX } from "./useStickToBottom";

const metrics = (scrollTop: number, scrollHeight = 1000, clientHeight = 300) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe("isNearBottom", () => {
  it("counts the exact end and the last 80 pixels as near the bottom", () => {
    expect(isNearBottom(metrics(700))).toBe(true);
    expect(isNearBottom(metrics(700 - NEAR_BOTTOM_PX))).toBe(true);
  });

  it("counts a reader above the threshold as away from the bottom", () => {
    expect(isNearBottom(metrics(700 - NEAR_BOTTOM_PX - 1))).toBe(false);
    expect(isNearBottom(metrics(0))).toBe(false);
  });

  it("treats content shorter than the viewport as near the bottom", () => {
    expect(isNearBottom(metrics(0, 200, 300))).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(isNearBottom(metrics(579), 120)).toBe(false);
    expect(isNearBottom(metrics(580), 120)).toBe(true);
  });
});
