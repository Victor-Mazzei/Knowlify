import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerSettings, RecommendControl } from "./RecommendControl";

const recommendBase = {
  armed: false,
  onArm: vi.fn(),
  useLibrary: true,
  libraryAvailable: true,
  disabled: false,
};

describe("RecommendControl", () => {
  it("arms the one-shot request and explains what the button does", () => {
    const onArm = vi.fn();
    render(<RecommendControl {...recommendBase} onArm={onArm} />);
    const button = screen.getByRole("button", { name: "Suggest books" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute(
      "aria-describedby",
      screen.getByText("Show book cards for your next message.").id,
    );

    fireEvent.click(button);
    expect(onArm).toHaveBeenCalledWith(true);
  });

  it("shows the armed state", () => {
    render(<RecommendControl {...recommendBase} armed />);
    expect(screen.getByRole("button", { name: "Suggest books" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers to turn Search my books on instead of hiding the control", () => {
    const onEnableLibrary = vi.fn();
    render(
      <RecommendControl
        {...recommendBase}
        useLibrary={false}
        onEnableLibrary={onEnableLibrary}
      />,
    );
    expect(screen.queryByRole("button", { name: "Suggest books" })).not.toBeInTheDocument();
    expect(screen.getByText("Book suggestions need Search my books.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn on Search my books" }));
    expect(onEnableLibrary).toHaveBeenCalledTimes(1);
  });

  it("explains a missing search index without offering an impossible action", () => {
    render(<RecommendControl {...recommendBase} libraryAvailable={false} />);
    expect(screen.getByText("Book suggestions need the search index.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suggest books" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Search my books" })).not.toBeInTheDocument();
  });

  it("locks the one-shot request during a stream", () => {
    render(<RecommendControl {...recommendBase} disabled />);
    expect(screen.getByRole("button", { name: "Suggest books" })).toBeDisabled();
  });
});

describe("ComposerSettings", () => {
  const settings = (mode: "auto" | "off" = "auto", onModeChange = vi.fn(), disabled = false) => (
    <ComposerSettings mode={mode} onModeChange={onModeChange} disabled={disabled} />
  );

  it("opens as a labelled dialog and moves focus to the preference switch", async () => {
    const user = userEvent.setup();
    render(settings());
    const trigger = screen.getByRole("button", { name: "Answer settings" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog", { name: "Answer settings" })).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Answer settings" });
    expect(dialog).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Suggest books from my library" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveFocus();
    expect(screen.getByText("Auto")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Auto: the tutor shows book cards when you ask for a recommendation. Off: it never shows book cards.",
      ),
    ).toBeInTheDocument();
  });

  it("opens with the keyboard and stores Auto/Off through the switch", async () => {
    const onModeChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(settings("auto", onModeChange));
    const trigger = screen.getByRole("button", { name: "Answer settings" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Answer settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Suggest books from my library" }));
    expect(onModeChange).toHaveBeenCalledWith("off");

    rerender(settings("off", onModeChange));
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Suggest books from my library" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await user.click(screen.getByRole("switch", { name: "Suggest books from my library" }));
    expect(onModeChange).toHaveBeenLastCalledWith("auto");
  });

  it("closes with Escape and returns focus to the gear", async () => {
    const user = userEvent.setup();
    render(settings());
    const trigger = screen.getByRole("button", { name: "Answer settings" });
    await user.click(trigger);
    expect(screen.getByRole("switch", { name: "Suggest books from my library" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Answer settings" })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when the pointer goes elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <>
        {settings()}
        <button type="button">Outside</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Answer settings" }));
    expect(screen.getByRole("dialog", { name: "Answer settings" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog", { name: "Answer settings" })).not.toBeInTheDocument();
  });

  it("locks the preference while an answer streams", async () => {
    const user = userEvent.setup();
    render(settings("auto", vi.fn(), true));
    await user.click(screen.getByRole("button", { name: "Answer settings" }));
    expect(screen.getByRole("switch", { name: "Suggest books from my library" })).toBeDisabled();
  });
});
