import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import type { Note } from "./types";

const note = (id: string, body: string): Note => ({
  id, bookId: "book", location: `epubcfi(${id})`, label: "Page 1", quote: "", body,
  createdAt: 0, updatedAt: 0,
});

const props = (notes: Note[]) => ({
  notes, where: "Page 1", onClose: vi.fn(), onClearSelection: vi.fn(),
  onAdd: vi.fn(async () => undefined), onUpdate: vi.fn(async () => undefined),
  onDelete: vi.fn(async () => undefined), onJump: vi.fn(),
});

describe("NotesPanel", () => {
  it("adds a note and filters notes", async () => {
    const onAdd = vi.fn(async () => undefined);
    const notes = [note("1", "Alpha"), note("2", "Beta"), note("3", "Gamma"), note("4", "Delta")];
    render(<NotesPanel {...props(notes)} onAdd={onAdd} />);
    fireEvent.change(screen.getByRole("textbox", { name: "New note" }), { target: { value: "New thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("New thought"));
    const filter = screen.getByRole("textbox", { name: "Filter notes" });
    fireEvent.change(filter, { target: { value: "beta" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });
});
