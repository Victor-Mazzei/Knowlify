import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { resetCoverQueue } from "../library/useCoverQueue";
import { createMockNoteData, mockNotesApi } from "./mockNotesApi";
import { NotesPage } from "./NotesPage";

const renderPage = (api: ApiFn) =>
  render(
    <MemoryRouter>
      <NotesPage credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
    </MemoryRouter>,
  );

const sectionOf = (heading: HTMLElement) => {
  const section = heading.closest("section");
  if (!section) throw new Error("heading is not inside a note group");
  return section;
};

const deleteButton = (name: string | RegExp) => screen.getByRole("button", { name });

async function confirmDelete() {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete note" }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  resetCoverQueue();
});

describe("NotesPage delete", () => {
  it("deletes the last note, removes the group, updates totals and focuses search", async () => {
    renderPage(mockNotesApi(createMockNoteData({ books: 1, notesPerBook: 1 })));
    expect(await screen.findByText("Reading about memory in Quiet Library 1")).toBeInTheDocument();

    fireEvent.click(deleteButton("Delete note from Quiet Library 1: A memory passage"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("A memory passage");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete note" }));

    await waitFor(() =>
      expect(screen.queryByText("Reading about memory in Quiet Library 1")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("0 notes in 0 books");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search notes" })).toHaveFocus());
  });

  it("keeps the note when deletion is cancelled", async () => {
    renderPage(mockNotesApi(createMockNoteData({ books: 1, notesPerBook: 1 })));
    await screen.findByText("Reading about memory in Quiet Library 1");
    fireEvent.click(deleteButton("Delete note from Quiet Library 1: A memory passage"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("Reading about memory in Quiet Library 1")).toBeInTheDocument();
  });

  it("shows an inline error and keeps the note when deletion fails", async () => {
    renderPage(mockNotesApi(createMockNoteData({ books: 1, notesPerBook: 1 }), { failDelete: true }));
    await screen.findByText("Reading about memory in Quiet Library 1");
    fireEvent.click(deleteButton("Delete note from Quiet Library 1: A memory passage"));
    await confirmDelete();

    expect(await screen.findByText("Could not delete this note: Could not delete")).toBeInTheDocument();
    expect(screen.getByText("Reading about memory in Quiet Library 1")).toBeInTheDocument();
    expect(deleteButton("Delete note from Quiet Library 1: A memory passage")).toBeEnabled();
  });

  it("moves focus to the next note after deleting one", async () => {
    renderPage(mockNotesApi(createMockNoteData({ books: 1, notesPerBook: 2 })));
    await screen.findByText("Reading about memory in Quiet Library 1");
    fireEvent.click(deleteButton("Delete note from Quiet Library 1: A memory passage"));
    await confirmDelete();

    await waitFor(() =>
      expect(deleteButton(/Delete note from Quiet Library 1: Reading about attention/)).toHaveFocus(),
    );
  });

  it("keeps a deletion and the totals when the next page arrives after it", async () => {
    const base = mockNotesApi(createMockNoteData({ books: 24, notesPerBook: 1 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pageCaptured = false;
    const api: ApiFn = async (input, init) => {
      const response = await base(input, init);
      if (!pageCaptured && String(input).includes("/api/notes/groups") && String(input).includes("cursor=")) {
        pageCaptured = true;
        await gate;
      }
      return response;
    };
    renderPage(api);
    await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    expect(screen.getByRole("status")).toHaveTextContent("48 notes in 24 books");

    fireEvent.click(screen.getByRole("button", { name: "Load more books" }));
    await waitFor(() => expect(pageCaptured).toBe(true));

    fireEvent.click(deleteButton("Delete note from Quiet Library 1: A memory passage"));
    await confirmDelete();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "Quiet Library 1" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("47 notes in 23 books");

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more books" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("47 notes in 23 books");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(23);
    expect(screen.queryByText("Reading about memory in Quiet Library 1")).not.toBeInTheDocument();
  });

  it("does not resurrect a note deleted while its remaining notes were loading", async () => {
    const base = mockNotesApi(createMockNoteData({ books: 1, notesPerBook: 6 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    const api: ApiFn = async (input, init) => {
      const response = await base(input, init);
      if (!delayed && String(input).includes("/api/books/") && String(input).endsWith("/notes")) {
        delayed = true;
        await gate;
      }
      return response;
    };
    renderPage(api);
    const heading = await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    const section = sectionOf(heading);
    fireEvent.click(within(section).getByRole("button", { name: "Show all 6 notes" }));
    await waitFor(() => expect(delayed).toBe(true));

    fireEvent.click(within(section).getByRole("button", { name: "Delete note from Quiet Library 1: A memory passage" }));
    await confirmDelete();
    await waitFor(() => expect(within(section).getAllByRole("article")).toHaveLength(4));

    release();
    await waitFor(() => expect(within(section).getAllByRole("article")).toHaveLength(5));
    expect(screen.queryByText("Reading about memory in Quiet Library 1")).not.toBeInTheDocument();
    expect(within(section).getByText("5 notes")).toBeInTheDocument();
  });
});
