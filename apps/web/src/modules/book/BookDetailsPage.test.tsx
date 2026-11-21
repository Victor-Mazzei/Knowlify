import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import type { Book } from "../../types";
import { mockBooksApi } from "../library/mockBooksApi";
import { BookDetailsPage } from "./BookDetailsPage";
import { rememberLibraryReturn } from "./libraryReturn";

const makeBook = (id: string, extra: Partial<Book> = {}): Book => ({
  id,
  title: `Title ${id}`,
  author: "Ada Meridian",
  format: "epub",
  size: 1_048_576,
  addedAt: 1_760_000_000_000,
  hasCover: false,
  status: "ready",
  source: false,
  index: { state: "ready", error: null },
  progress: null,
  ...extra,
});

const books: Book[] = [
  makeBook("mock-00001"),
  makeBook("mock-00002", {
    title: "The Quiet Archive",
    progress: { percentage: 0.42, updatedAt: 1_760_000_100_000 },
  }),
  makeBook("mock-00003", { progress: { percentage: 0.995, updatedAt: 1_760_000_200_000 } }),
  makeBook("mock-00005", { progress: { percentage: 0.01, updatedAt: 1_760_000_300_000 } }),
  makeBook("mock-00006", { title: "The Quiet Archive, Volume Two", source: true }),
  makeBook("mock-00007", { title: "Queued Book", index: { state: "pending", error: null } }),
  makeBook("mock-00020", { title: "Notes Book" }),
];

function renderPage(
  api: ApiFn,
  entry: string | { pathname: string; state?: unknown } = "/book/mock-00002",
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/book/:id"
          element={
            <BookDetailsPage
              credentials={{ user: "reader", pass: "secret" }}
              onLogout={vi.fn()}
              apiOverride={api}
            />
          }
        />
        <Route path="/" element={<div>Library screen</div>} />
        <Route path="/notes" element={<div>Notes screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const apiWith = (options?: Parameters<typeof mockBooksApi>[1]) => mockBooksApi(books, options);

describe("BookDetailsPage", () => {
  it("renders the book plate with metadata, progress and the reading action", async () => {
    renderPage(apiWith());

    expect(await screen.findByRole("heading", { level: 1, name: "The Quiet Archive" })).toBeInTheDocument();
    expect(screen.getByText("Ada Meridian")).toBeInTheDocument();
    expect(screen.getByText(/habits that make a reading life/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();

    expect(screen.getByText("Year")).toBeInTheDocument();
    expect(screen.getByText("1982")).toBeInTheDocument();
    expect(screen.getByText("Publisher")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("ISBN")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/read/mock-00002");
    expect(screen.getByText("58% left")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit metadata" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search online" })).not.toBeInTheDocument();
  });

  it("expands and collapses a long description", async () => {
    renderPage(apiWith());
    const more = await screen.findByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("favorites the book with an accessible announcement and no navigation", async () => {
    renderPage(apiWith());
    const star = await screen.findByRole("button", { name: "Add to favorites: The Quiet Archive" });
    expect(star).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    expect(star).toHaveAccessibleName("Remove from favorites: The Quiet Archive");
    expect(screen.getByText("Added to favorites.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "The Quiet Archive" })).toBeInTheDocument();
  });

  it("keeps the favorite state when the tags change", async () => {
    renderPage(apiWith());
    const star = await screen.findByRole("button", { name: "Add to favorites: The Quiet Archive" });
    fireEvent.click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
    const popover = await screen.findByRole("group", { name: "Tag selected books" });
    const checkbox = within(popover).getAllByRole("checkbox")[0]!;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(star).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the series, the edited badge and the file source", async () => {
    renderPage(apiWith(), "/book/mock-00006");
    expect(await screen.findByRole("heading", { level: 1, name: "The Quiet Archive, Volume Two" })).toBeInTheDocument();
    expect(screen.getByText("The Quiet Archive · Book 2")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("Library folder")).toBeInTheDocument();
  });

  it("labels the primary action as Start reading or Read again from progress", async () => {
    const start = renderPage(apiWith(), "/book/mock-00001");
    expect(await screen.findByRole("link", { name: "Start reading" })).toHaveAttribute("href", "/read/mock-00001");
    expect(screen.getByText("Not started")).toBeInTheDocument();
    start.unmount();

    renderPage(apiWith(), "/book/mock-00003");
    expect(await screen.findByRole("link", { name: "Read again" })).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
  });

  it("preserves an ?at= target when the primary action opens the reader", async () => {
    renderPage(apiWith(), "/book/mock-00002?at=chapter-3");
    expect(await screen.findByRole("link", { name: "Continue" })).toHaveAttribute(
      "href",
      "/read/mock-00002?at=chapter-3",
    );
  });

  it("previews the latest notes with links into the reader and to all notes", async () => {
    renderPage(apiWith(), "/book/mock-00020");
    expect(await screen.findByText("4 notes")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Page 12" })).toHaveAttribute(
      "href",
      "/read/mock-00020?at=epubcfi(%2F6%2F2)",
    );
    expect(screen.getByRole("link", { name: "Page 19" })).toHaveAttribute("href", "/read/mock-00020");
    expect(screen.getAllByRole("link", { name: /^Page / })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "All notes" })).toHaveAttribute("href", "/notes");
  });

  it("returns to the Library with the query string from the origin link", async () => {
    renderPage(apiWith(), { pathname: "/book/mock-00002", state: { from: "?q=river&sort=title" } });
    const crumb = await screen.findByRole("link", { name: "Library" });
    expect(crumb).toHaveAttribute("href", "/?q=river&sort=title");
  });

  it("falls back to the remembered Library query when there is no link state", async () => {
    rememberLibraryReturn("?tag=tag-research");
    renderPage(apiWith());
    expect(await screen.findByRole("link", { name: "Library" })).toHaveAttribute(
      "href", "/?tag=tag-research",
    );
  });

  it("shows a not-found state for a missing book", async () => {
    const api: ApiFn = async () =>
      new Response(JSON.stringify({ message: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    renderPage(api);
    expect(await screen.findByRole("heading", { level: 1, name: "Book not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Library" })).toHaveAttribute("href", "/");
  });

  it("retries a failed load", async () => {
    const base = apiWith();
    let fail = true;
    const api: ApiFn = async (path, init) => {
      if (path.endsWith("/mock-00001") && fail) {
        fail = false;
        throw new Error("Network down");
      }
      return base(path, init);
    };
    renderPage(api, "/book/mock-00001");
    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Title mock-00001" })).toBeInTheDocument();
  });

  it("hides metadata actions until the server advertises the metadata routes", async () => {
    renderPage(apiWith({ metadata: true }));
    expect(await screen.findByRole("button", { name: "Edit metadata" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search online" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete book" })).toBeInTheDocument();
  });

  it("deletes the book through the confirmation dialog and returns to the Library", async () => {
    renderPage(apiWith());
    fireEvent.click(await screen.findByRole("button", { name: "Delete book" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = await within(dialog).findByRole("button", { name: "Delete book" });
    fireEvent.click(confirm);
    expect(await screen.findByText("Library screen")).toBeInTheDocument();
  });

  it("shows the search index state of the book", async () => {
    renderPage(apiWith(), "/book/mock-00007");
    expect(await screen.findByText("Queued for search")).toBeInTheDocument();
  });
});
