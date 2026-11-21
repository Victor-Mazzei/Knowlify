import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageControl } from "./PageControl";
import { isRangeCfi, resolvable } from "./cfi";

describe("PageControl helpers", () => {
  it("recognizes range CFIs", () => {
    expect(isRangeCfi("epubcfi(/6/2!/4/2,/6/4)")).toBe(true);
    expect(isRangeCfi("epubcfi(/6/2!/4/2)")).toBe(false);
  });

  it("checks resolvability without throwing for malformed values", () => {
    expect(resolvable({ spine: { get: () => ({}) } }, "cfi")).toBe(true);
    expect(resolvable({ spine: { get: () => undefined } }, "cfi")).toBe(false);
    expect(resolvable({ spine: { get: () => { throw new Error("bad"); } } }, "cfi")).toBe(false);
    expect(resolvable(null, "cfi")).toBe(false);
  });

  it("steps with arrows and commits numeric changes", () => {
    const onStep = vi.fn();
    const onChange = vi.fn();
    render(<PageControl page={2} total={4} onStep={onStep} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onStep.mock.calls).toEqual([[-1], [1]]);

    const input = screen.getByRole("textbox", { name: "Current page" });
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(4);
  });
});
