import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TUTOR_HINT_KEY } from "../../services/storage";
import { FirstUseHint } from "./FirstUseHint";

beforeEach(() => localStorage.clear());

describe("FirstUseHint", () => {
  it("explains both modes and never returns after it is dismissed", () => {
    const { unmount } = render(<FirstUseHint />);
    expect(
      screen.getByText(
        "Ask is for quick questions and is not saved. Session keeps your history so you can come back. In Ask, you choose if your library is used.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(localStorage.getItem(TUTOR_HINT_KEY)).toBe("1");
    expect(localStorage.length).toBe(1);

    unmount();
    render(<FirstUseHint />);
    expect(screen.queryByText(/Ask is for quick questions/)).not.toBeInTheDocument();
  });
});
