import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { resetCoverQueue } from "../library/useCoverQueue";
import { COLLAPSED_STORAGE_KEY } from "./collapsedNotes";
import { createMockNoteData, mockNotesApi } from "./mockNotesApi";
import { NotesPage } from "./NotesPage";

const fixture = () => createMockNoteData({ books: 24, notesPerBook: 6 });

const renderPage = (api: ApiFn = mockNotesApi(fixture())) => {
  const view = render(
    <MemoryRouter>
      <NotesPage credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
    </MemoryRouter>,
  );
  return view;
};

const sectionOf = (heading: HTMLElement) => {
  const section = heading.closest("section");
  if (!section) throw new Error("heading is not inside a note group");
  return section;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  resetCoverQueue();
});

describe("NotesPage groups", () => {
  it("renders one section per book with cover placeholder, author, count and note text", async () => {
    renderPage();
    const first = await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    const firstSection = sectionOf(first);
    expect(within(firstSection).getByText("Ada Meridian")).toBeInTheDocument();
    expect(within(firstSection).getByText("6 notes")).toBeInTheDocument();
    expect(within(firstSection).getByText("Reading about memory in Quiet Library 1")).toBeInTheDocument();
    expect(within(firstSection).getByText("Last note")).toBeInTheDocument();
    expect(within(firstSection).getByRole("link", { name: "Quiet Library 1" })).toHaveAttribute(
      "href",
      "/book/note-book-00001",
    );
    expect(within(firstSection).getByRole("link", { name: "Page 3" })).toHaveAttribute(
      "href",
      "/read/note-book-00001?at=epubcfi(%2F6%2F2)",
    );

    const second = await screen.findByRole("heading", { level: 2, name: "Hidden Library 2" });
    expect(within(sectionOf(second)).getByText("EPUB")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/notes in 24 books/);
  });

  it("collapses a book, persists the choice and restores it on the next visit", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    const toggle = await screen.findByRole("button", { name: "Collapse notes for Quiet Library 1" });
    const controls = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(controls).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading about memory in Quiet Library 1")).toBeVisible();

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(controls).not.toBeVisible();
    expect(screen.getByText("Reading about memory in Quiet Library 1")).not.toBeVisible();
    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toContain("note-book-00001");

    unmount();
    renderPage();
    const expand = await screen.findByRole("button", { name: "Expand notes for Quiet Library 1" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Reading about memory in Quiet Library 1")).not.toBeVisible();
    expect(expand.closest("section")).toHaveAttribute("data-collapsed", "true");
  });

  it("filters groups and notes with q and expands groups while searching", async () => {
    const api = vi.fn(mockNotesApi(fixture()));
    renderPage(api);
    const firstToggle = await screen.findByRole("button", { name: "Collapse notes for Quiet Library 1" });
    fireEvent.click(firstToggle);
    expect(screen.getByText("Reading about memory in Quiet Library 1")).not.toBeVisible();

    fireEvent.change(screen.getByRole("textbox", { name: "Search notes" }), {
      target: { value: "Quiet Library 1" },
    });
    await waitFor(() => expect(api.mock.calls.some(([url]) => String(url).includes("q=Quiet+Library+1"))).toBe(true));
    expect(await screen.findByText(/Reading about memory/)).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeLessThan(20);
    expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("textbox", { name: "Search notes" }), { target: { value: "" } });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Expand notes for Quiet Library 1" })).toBeInTheDocument(),
    );
    expect(await screen.findByText("Reading about memory in Quiet Library 1")).not.toBeVisible();
  });

  it("loads the next page of books", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Load more books" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(24));
    expect(screen.queryByRole("button", { name: "Load more books" })).not.toBeInTheDocument();
  });

  it("loads every note of a book from the book notes endpoint", async () => {
    const api = vi.fn(mockNotesApi(fixture()));
    renderPage(api);
    const heading = await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    const section = sectionOf(heading);
    expect(within(section).getAllByRole("article")).toHaveLength(5);
    fireEvent.click(within(section).getByRole("button", { name: "Show all 6 notes" }));
    await waitFor(() => expect(within(section).getAllByRole("article")).toHaveLength(6));
    expect(api.mock.calls.some(([url]) => String(url) === "/api/books/note-book-00001/notes")).toBe(true);
    expect(within(section).queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("shows a group-level error with retry when loading every note fails", async () => {
    const base = mockNotesApi(fixture());
    let fail = true;
    const api: ApiFn = async (input, init) => {
      if (fail && /^\/api\/books\/[^/]+\/notes/.test(String(input))) {
        return new Response(JSON.stringify({ message: "Book notes are down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return base(input, init);
    };
    renderPage(api);
    const heading = await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });
    const section = sectionOf(heading);
    fireEvent.click(within(section).getByRole("button", { name: "Show all 6 notes" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent("Book notes are down");
    fail = false;
    fireEvent.click(within(section).getByRole("button", { name: "Retry loading notes" }));
    await waitFor(() => expect(within(section).getAllByRole("article")).toHaveLength(6));
    expect(within(section).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the legacy flat list when the server predates groups", async () => {
    renderPage(mockNotesApi(fixture(), { legacy: true }));
    expect(await screen.findByText("Reading about memory in Quiet Library 1")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2, name: "Quiet Library 1" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /notes for Quiet Library 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("in 24 books");
  });

  it("ignores an older search response that resolves after a newer one", async () => {
    const base = mockNotesApi(createMockNoteData({ books: 4, notesPerBook: 2 }));
    let releaseAlpha!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    let alphaStarted = false;
    const api: ApiFn = async (input, init) => {
      const response = await base(input, init);
      if (String(input).includes("q=Hidden+Library+2")) {
        alphaStarted = true;
        await gate;
      }
      return response;
    };
    renderPage(api);
    await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" });

    const search = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.change(search, { target: { value: "Hidden Library 2" } });
    await waitFor(() => expect(alphaStarted).toBe(true));
    fireEvent.change(search, { target: { value: "Quiet Library 1" } });
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1));

    releaseAlpha();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { level: 2, name: "Hidden Library 2" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { level: 2, name: "Quiet Library 1" })).toBeInTheDocument();
  });

  it("shows an error with retry when the first page fails", async () => {
    const base = mockNotesApi(fixture());
    let fail = true;
    const api: ApiFn = async (input, init) => {
      if (fail && String(input).includes("/api/notes/groups")) {
        return new Response(JSON.stringify({ message: "Groups are down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return base(input, init);
    };
    renderPage(api);
    expect(await screen.findByRole("alert")).toHaveTextContent("Groups are down");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Quiet Library 1" })).toBeInTheDocument();
  });
});
