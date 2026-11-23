import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "./ModeSwitch";

describe("ModeSwitch", () => {
  it("shows the description of each mode and links it with aria-describedby", () => {
    render(<ModeSwitch value="session" onChange={() => undefined} />);

    const group = screen.getByRole("radiogroup", { name: "Chat mode" });
    expect(group).toBeInTheDocument();
    expect(screen.getByText("Quick question: nothing is saved")).toBeVisible();
    expect(screen.getByText("Keeps the history and context; you can resume later")).toBeVisible();

    const ask = screen.getByRole("radio", { name: "Ask" });
    const session = screen.getByRole("radio", { name: "Session" });
    expect(ask).not.toBeChecked();
    expect(session).toBeChecked();
    expect(ask).toHaveAttribute("aria-describedby", screen.getByText("Quick question: nothing is saved").id);
    expect(session).toHaveAttribute(
      "aria-describedby",
      screen.getByText("Keeps the history and context; you can resume later").id,
    );
  });

  it("selects with click and with the arrow keys", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ModeSwitch value="session" onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Ask" }));
    expect(onChange).toHaveBeenLastCalledWith("ask");

    rerender(<ModeSwitch value="ask" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Chat mode" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("session");

    rerender(<ModeSwitch value="session" onChange={onChange} />);
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("ask");

    rerender(<ModeSwitch value="ask" onChange={onChange} />);
    fireEvent.keyDown(group, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("session");

    rerender(<ModeSwitch value="session" onChange={onChange} />);
    fireEvent.keyDown(group, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("ask");
  });

  it("disables both options during a stream", () => {
    render(<ModeSwitch value="session" onChange={() => undefined} disabled />);
    expect(screen.getByRole("radio", { name: "Ask" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Session" })).toBeDisabled();
  });
});
