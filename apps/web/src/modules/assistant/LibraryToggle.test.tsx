import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ASK_LIBRARY_OFF, ASK_LIBRARY_ON, LIBRARY_HELP, LibraryToggle } from "./LibraryToggle";

describe("LibraryToggle", () => {
  it("is a switch named Search my books with the help sentence linked as its description", () => {
    render(<LibraryToggle checked onChange={() => undefined} />);
    const toggle = screen.getByRole("switch", { name: "Search my books" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(LIBRARY_HELP)).toBeVisible();
    expect(toggle).toHaveAttribute("aria-describedby", screen.getByText(LIBRARY_HELP).id);
  });

  it("keeps the same help and the announcements for each state", () => {
    const { rerender } = render(<LibraryToggle checked onChange={() => undefined} />);
    expect(screen.getByText(LIBRARY_HELP)).toBeInTheDocument();
    expect(ASK_LIBRARY_ON).toContain("on");
    expect(ASK_LIBRARY_OFF).toContain("off");

    rerender(<LibraryToggle checked={false} onChange={() => undefined} />);
    expect(screen.getByText(LIBRARY_HELP)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Search my books" })).toHaveAttribute("aria-checked", "false");
  });

  it("toggles with Space and Enter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<LibraryToggle checked onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Search my books" });
    toggle.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(false);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("explains attached text and an off search index", () => {
    render(<LibraryToggle checked onChange={() => undefined} hasExcerpt libraryAvailable={false} />);
    expect(screen.getByText("Attached text is sent to the model.")).toBeInTheDocument();
    expect(screen.getByText("Search is off. Only attached text is used.")).toBeInTheDocument();
  });

  it("cannot be toggled while an answer is streaming", () => {
    render(<LibraryToggle checked onChange={() => undefined} disabled />);
    expect(screen.getByRole("switch", { name: "Search my books" })).toBeDisabled();
  });
});
