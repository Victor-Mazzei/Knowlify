import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpTokenForm } from "./McpTokenForm";

describe("McpTokenForm", () => {
  it("explains both scopes and submits a trimmed name with the chosen scope", async () => {
    const onSave = vi.fn(async () => true);
    render(<McpTokenForm busy={false} onSave={onSave} />);

    expect(screen.getByText("Search passages and list books, notes and tags.")).toBeInTheDocument();
    expect(screen.getByText("Read, create notes, and add or remove tags.")).toBeInTheDocument();
    const name = screen.getByLabelText("Token name");
    fireEvent.change(name, { target: { value: "  Claude Code  " } });
    fireEvent.click(screen.getByRole("radio", { name: /Read and write notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Claude Code", "write_notes"));
    await waitFor(() => expect(name).toHaveValue(""));
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();
  });

  it("blocks an empty name and focuses the field", () => {
    render(<McpTokenForm busy={false} onSave={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a name for this token.");
    expect(screen.getByLabelText("Token name")).toHaveFocus();
    expect(screen.getByLabelText("Token name")).toHaveAttribute("aria-invalid", "true");
  });

  it("disables every control while a token is being created", () => {
    render(<McpTokenForm busy onSave={vi.fn(async () => true)} />);

    expect(screen.getByLabelText("Token name")).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Read and write notes/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });
});
