import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddBookButton } from "./AddBookButton";

describe("AddBookButton", () => {
  it("opens the file picker and passes the chosen file", () => {
    const onUpload = vi.fn();
    const { container } = render(<AddBookButton onUpload={onUpload} busy={false} />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const click = vi.spyOn(input, "click");

    fireEvent.click(screen.getByRole("button", { name: "Add book" }));
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(["x"], "book.epub");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUpload).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("reflects the busy state", () => {
    render(<AddBookButton onUpload={vi.fn()} busy />);
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
  });
});
