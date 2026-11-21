import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../components/AppShell";
import { useScanStatusContext } from "../../components/ScanStatusContext";
import { INDEX_POLL_MS } from "../indexing/useIndexStatus";
import { busyIndexStatus } from "../indexing/fixtures";
import { LIBRARY_SORT_KEY } from "../settings/preferences";
import type { Book, BookFacets } from "../../types";
import { Library } from "./Library";
import { createMockBooks, mockBooksApi } from "./mockBooksApi";
import { mockDuplicateUpload } from "../duplicates/mockDuplicatesApi";
import { readLibraryReturn, rememberLibraryReturn } from "../book/libraryReturn";

const json = (body: unknown) => new Response(JSON.stringify(body));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function HistoryProbe() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}

function RescanProbe() {
  const { rescan } = useScanStatusContext();
  return <button onClick={() => void rescan()}>Rescan</button>;
}

/** Four books covering both formats and the three reading states. */
function filterLibrary(): Book[] {
  const base = {
    size: 1,
    hasCover: false,
    status: "ready" as const,
    source: false,
    index: { state: "ready" as const, error: null },
  };
  return [
    { ...base, id: "p1", title: "PDF Reading", author: "A", format: "pdf", addedAt: 1, progress: { percentage: 0.5, updatedAt: 1 } },
    { ...base, id: "p2", title: "PDF Unread", author: "B", format: "pdf", addedAt: 2, progress: null },
    { ...base, id: "e1", title: "EPUB Reading", author: "C", format: "epub", addedAt: 3, progress: { percentage: 0.4, updatedAt: 2 } },
    { ...base, id: "e2", title: "EPUB Finished", author: "D", format: "epub", addedAt: 4, progress: { percentage: 0.995, updatedAt: 3 } },
  ];
}


function fileDrop(type: string, file: File) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [file], dropEffect: "copy" },
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 0 });
});

describe("Library", () => {
  it("renders the server total, virtualizes the grid and switches to the table", async () => {
    const api = mockBooksApi(createMockBooks({ count: 120 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );

    // Wait for the facets probe: it is what unlocks the `reading` sort on the first render.
    await screen.findByRole("button", { name: "Filters" });
    // In reading order the second card is the first in-progress book; in `added`
    // order it is another title, so this waits for the effective sort to settle.
    await waitFor(() => expect(screen.getAllByRole("link")[1]).toHaveAccessibleName(/Patient Library 6/), {
      timeout: 3000,
    });
    expect(screen.getByText("120 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add book" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveValue("reading");

    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(screen.getByRole("grid")).toBeInTheDocument());
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "121");
    expect(screen.getByRole("link", { name: "Patient Library 6" })).toHaveAttribute("href", "/book/mock-00006");
  });

  it("accepts a file dropped anywhere on the page and refreshes the first page", async () => {
    const api = mockBooksApi(createMockBooks({ count: 40 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    await waitFor(() => expect(screen.getAllByRole("link")[1]).toHaveAccessibleName(/Patient Library 6/), {
      timeout: 3000,
    });

    const file = new File(["x"], "new.pdf", { type: "application/pdf" });
    fireEvent(window, fileDrop("dragenter", file));
    expect(screen.getByText("Drop to add a book")).toBeInTheDocument();

    fireEvent(window, fileDrop("drop", file));
    expect(await screen.findByText("new.pdf added to your library.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /new/ })).toBeInTheDocument(), { timeout: 3000 });
  });

  it("offers to open the canonical book instead of adding a duplicate row", async () => {
    const api = mockDuplicateUpload(mockBooksApi(createMockBooks({ count: 3 })));
    const { container } = render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Quiet Library 1/ });

    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "duplicate.epub")] } });

    expect(await screen.findByText("Already in your library")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open The Left Hand of Darkness" })).toHaveAttribute(
      "href",
      "/book/mock-duplicate-canonical",
    );
    expect(screen.getByText("3 titles", { selector: ".title-count" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Already in your library")).not.toBeInTheDocument();
  });

  it("polls index revisions for 50 cycles without ever reloading the list by itself", async () => {
    vi.useFakeTimers();
    const pending = { ...createMockBooks({ count: 1 })[0]!, id: "pending-1", title: "Pending Book", status: "pending" as const, index: { state: "pending" as const, error: null } };
    const base = mockBooksApi([pending, ...createMockBooks({ count: 90 })]);
    let revision = 1;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/api/index/status")) {
        revision += 1;
        return json({ ...busyIndexStatus, counts: { pending: 1, indexing: 0, ready: 90, error: 0 }, revision });
      }
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        </AppShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("91 titles", { selector: ".title-count" })).toBeInTheDocument();

    for (let cycle = 0; cycle < 50; cycle += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INDEX_POLL_MS);
      });
    }

    const bookCalls = api.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith("/api/books?"));
    expect(bookCalls.length).toBeGreaterThan(1);
    expect(bookCalls.every((path) => path.includes("limit=") || path.includes("ids="))).toBe(true);
    expect(bookCalls.some((path) => path.includes("ids="))).toBe(true);
  }, 20_000);

  it("shows an empty state when the search has no matches", async () => {
    const api = mockBooksApi(createMockBooks({ count: 5 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Quiet Library 1/ });

    fireEvent.change(screen.getByRole("textbox", { name: "Search titles or authors" }), {
      target: { value: "nothing matches this" },
    });
    const message = await screen.findByText("No matching books.");
    const empty = message.closest(".empty") as HTMLElement;
    expect(empty.querySelector("svg.logo--mono")).toBeNull();
  });

  it("shows the decorative brand mark and the folder link on an empty library", async () => {
    const api = mockBooksApi([]);
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );

    const message = await screen.findByText("Your library is empty.");
    const empty = message.closest(".empty") as HTMLElement;
    const mark = empty.querySelector("svg.logo--mono");
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("width", "48");
    expect(mark).toHaveAttribute("height", "48");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).not.toHaveAttribute("role");
    expect(empty.firstElementChild?.querySelector("svg.logo--mono")).not.toBeNull();
    expect(empty.querySelector("strong")).toHaveTextContent("Your library is empty.");
    expect(screen.getByRole("link", { name: "Add a library folder" })).toHaveAttribute("href", "/settings/folders");
  });

  it("keeps the brand mark out of the no-progress empty state", async () => {
    const api = mockBooksApi(filterLibrary().map((book) => ({ ...book, progress: null })));
    render(
      <MemoryRouter initialEntries={["/?sort=lastRead"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );

    const message = await screen.findByText("No books with reading progress yet.");
    const empty = message.closest(".empty") as HTMLElement;
    expect(empty.querySelector("svg.logo--mono")).toBeNull();
    expect(empty.querySelector("a")).toBeNull();
  });

  it("returns to the top when the search changes and when it is cleared", async () => {
    const api = mockBooksApi(createMockBooks({ count: 120 }));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1600 });
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    await waitFor(() => expect(screen.getAllByRole("link")[1]).toHaveAccessibleName(/Patient Library 6/), {
      timeout: 3000,
    });
    scrollTo.mockClear();

    const search = screen.getByRole("textbox", { name: "Search titles or authors" });
    fireEvent.change(search, { target: { value: "River" } });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
    expect(await screen.findByText("16 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("?q=River");

    scrollTo.mockClear();
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(await screen.findByText("120 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("returns to the top when the filters are cleared", async () => {
    const api = mockBooksApi(filterLibrary());
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    render(
      <MemoryRouter initialEntries={["/?format=pdf"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: PDF" }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
    expect(await screen.findByText("4 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("restores the scroll of a matching return after the first page", async () => {
    const api = mockBooksApi(createMockBooks({ count: 40 }));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 700 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5000 });
    rememberLibraryReturn("");

    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 700, behavior: "auto" }));
    expect(readLibraryReturn()).toBeNull();
  });

  it("ignores a pending return captured for another Library URL", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1600 });
    rememberLibraryReturn("?q=river");

    render(
      <MemoryRouter initialEntries={["/?q=Quiet"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: "Filters" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /Quiet Library 1/ })).toBeInTheDocument());
    await waitFor(() => expect(readLibraryReturn()).toBeNull());
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
  });

  it("consumes an empty return so the next search still starts at the top", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1400 });
    rememberLibraryReturn("?q=nothing-matches");

    render(
      <MemoryRouter initialEntries={["/?q=nothing-matches"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByText("No matching books.")).toBeInTheDocument();
    await waitFor(() => expect(readLibraryReturn()).toBeNull());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });

    scrollTo.mockClear();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 1200 });
    fireEvent.change(screen.getByRole("textbox", { name: "Search titles or authors" }), {
      target: { value: "" },
    });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }));
  });


  it("reports a failed first page and retries it", async () => {
    const base = mockBooksApi(createMockBooks({ count: 5 }));
    // The facets probe resolves the effective sort and issues a second list request.
    // Keep every list attempt offline until the person explicitly retries, otherwise
    // that automatic request silently recovers the page before the assertion.
    let offline = true;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (offline && path.startsWith("/api/books?")) throw new Error("offline");
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");

    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Quiet Library 1/ })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores filters from the URL, shows chips and announces the filtered total", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?format=pdf&read=reading,unread"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Reading" })).toBeInTheDocument();
    expect(screen.getByText("2 titles · 2 filters")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /PDF Reading/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /EPUB Finished/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("?format=pdf&read=reading,unread");
  });

  it("updates the URL when a filter chip is removed", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?format=pdf"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: PDF" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(await screen.findByText("4 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("shows the filtered empty state and clears filters without clearing the search", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?q=zzz&format=pdf"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    const message = await screen.findByText("No books match these filters.");
    const empty = message.closest(".empty") as HTMLElement;
    expect(empty.querySelector("svg.logo--mono")).toBeNull();
    fireEvent.click(within(empty).getByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?q=zzz"));
    expect(await screen.findByText("No matching books.")).toBeInTheDocument();
  });

  it("hides filters and extended sorts on an older server", async () => {
    const base = mockBooksApi(createMockBooks({ count: 5 }), { facets: false });
    const api = vi.fn((path: string, init?: RequestInit) => base(path, init));
    render(
      <MemoryRouter initialEntries={["/?sort=lastRead&read=unread&format=pdf"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Quiet Library 1/ });
    await waitFor(() => expect(api.mock.calls.some(([path]) => String(path).startsWith("/api/books/facets"))).toBe(true));

    expect(screen.queryByRole("button", { name: /^Filters/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Last read" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Author" })).not.toBeInTheDocument();
    const listCalls = api.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/api/books?"));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const path of listCalls) {
      const url = new URL(path, "http://test");
      expect(url.searchParams.has("read")).toBe(false);
      expect(url.searchParams.has("index")).toBe(false);
      expect(url.searchParams.has("source")).toBe(false);
      expect(url.searchParams.has("notes")).toBe(false);
      expect(url.searchParams.has("format")).toBe(false);
      expect(["added", "title"]).toContain(url.searchParams.get("sort"));
    }
  });

  it("switches to last read and removes the contradictory Not started filter", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?read=unread"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByText("1 title", { selector: ".title-count" })).toBeInTheDocument();
    const sort = screen.getByRole("combobox", { name: "Sort books" });
    await screen.findByRole("option", { name: "Last read" });

    fireEvent.change(sort, { target: { value: "lastRead" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=lastRead"));
    expect(await screen.findByText("3 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove filter: Not started" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("checkbox", { name: /^Not started/ })).toBeDisabled();
  });

  it("drops a pasted Not started filter once last read is active", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?sort=lastRead&read=unread"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=lastRead"));
    expect(await screen.findByText("3 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("restores the saved sort on the initial entry and materializes it in the URL", async () => {
    localStorage.setItem(LIBRARY_SORT_KEY, "title");
    const api = mockBooksApi(createMockBooks({ count: 5 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: /Quiet Library 1/ });
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveValue("title");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=title"));
  });

  it("lets an explicit URL sort win on the initial entry while later bare entries default to reading", async () => {
    localStorage.setItem(LIBRARY_SORT_KEY, "title");
    const api = mockBooksApi(createMockBooks({ count: 5 }));
    render(
      <MemoryRouter initialEntries={["/?sort=author"]}>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        </AppShell>
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("option", { name: "Author" });
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveValue("author");
    await waitFor(() => expect(localStorage.getItem(LIBRARY_SORT_KEY)).toBe("author"));

    fireEvent.click(screen.getByRole("link", { name: "Library" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveValue("reading");
  });

  it("serializes returning to the default sort so history can restore it", async () => {
    localStorage.setItem(LIBRARY_SORT_KEY, "title");
    const api = mockBooksApi(createMockBooks({ count: 5 }));
    render(
      <MemoryRouter initialEntries={["/?sort=title"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: /Quiet Library 1/ });
    const sort = screen.getByRole("combobox", { name: "Sort books" });
    expect(sort).toHaveValue("title");

    fireEvent.change(sort, { target: { value: "added" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=added"));
    expect(sort).toHaveValue("added");
    expect(localStorage.getItem(LIBRARY_SORT_KEY)).toBe("added");
  });

  it("restores reading on back and title on forward", async () => {
    const api = mockBooksApi(createMockBooks({ count: 5 }));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
        <HistoryProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: /Quiet Library 1/ });
    const sort = screen.getByRole("combobox", { name: "Sort books" });
    expect(sort).toHaveValue("reading");

    fireEvent.change(sort, { target: { value: "title" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=title"));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(sort).toHaveValue("reading");

    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=title"));
    expect(sort).toHaveValue("title");

    fireEvent.change(sort, { target: { value: "added" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=added"));
    expect(sort).toHaveValue("added");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=title"));
    expect(sort).toHaveValue("title");

    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?sort=added"));
    expect(sort).toHaveValue("added");
  });

  it("keeps filters out of storage and clears them on navigation", async () => {
    localStorage.setItem(LIBRARY_SORT_KEY, "author");
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?format=pdf"]}>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        </AppShell>
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Library" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(await screen.findByText("4 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveValue("reading");
    // Navigation does not rewrite the stored preference; only an explicit sort does.
    expect(localStorage.getItem(LIBRARY_SORT_KEY)).toBe("author");
  });

  it("refreshes facet counts after an import", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /PDF Reading/ });

    fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "PDF 2" })).toBeInTheDocument();

    fireEvent(window, fileDrop("drop", new File(["x"], "new.pdf", { type: "application/pdf" })));
    expect(await screen.findByText("new.pdf added to your library.")).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: "PDF 3" })).toBeInTheDocument();
  });

  it("refreshes facet counts after a deletion", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /PDF Reading/ });

    fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "PDF 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete PDF Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete book" }));
    expect(await screen.findByText("Book deleted.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "PDF 1" })).toBeInTheDocument();
  });

  it("refreshes folder labels when a scan revision arrives", async () => {
    const base = mockBooksApi(filterLibrary());
    let scanned = false;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/scan" && init?.method === "POST") {
        scanned = true;
        return json({ scanning: false, pending: 0, lastScanAt: null });
      }
      if (path === "/api/sources") {
        const sources = [{ id: "source-1", path: "/library/Fiction", accessible: true, books: 0 }];
        if (scanned) sources.push({ id: "source-2", path: "/library/Reference", accessible: true, books: 0 });
        return json(sources);
      }
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
          <RescanProbe />
        </AppShell>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /PDF Reading/ });

    fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "Fiction 0" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Reference 0" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(scanned).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "Reference 0" })).toBeInTheDocument();
  });

  it("refreshes facet counts when the index revision changes", async () => {
    vi.useFakeTimers();
    const base = mockBooksApi([
      {
        ...filterLibrary()[0]!,
        id: "pending-1",
        title: "Pending Book",
        status: "pending",
        index: { state: "pending", error: null },
        progress: null,
      },
      ...filterLibrary(),
    ]);
    let statusCalls = 0;
    let indexed = false;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/api/index/status")) {
        statusCalls += 1;
        indexed = statusCalls > 1;
        return json({
          ...busyIndexStatus,
          counts: { pending: indexed ? 0 : 1, indexing: 0, ready: indexed ? 5 : 4, error: 0 },
          revision: statusCalls + 10,
        });
      }
      if (path.startsWith("/api/books/facets")) {
        const data = (await (await base(path, init)).json()) as BookFacets;
        return json({ ...data, index: indexed ? { ready: 5, pending: 0, error: 0 } : { ready: 4, pending: 1, error: 0 } });
      }
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        </AppShell>
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("checkbox", { name: "Ready 4" })).toBeInTheDocument();
    const sourcesCalls = api.mock.calls.filter(([path]) => String(path) === "/api/sources").length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEX_POLL_MS + 300);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole("checkbox", { name: "Ready 5" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pending 0" })).toBeDisabled();
    expect(api.mock.calls.filter(([path]) => String(path) === "/api/sources")).toHaveLength(sourcesCalls);
  });

  it("refreshes facet counts after a folder scan reports changes", async () => {
    const base = mockBooksApi(filterLibrary());
    let scanned = false;
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/scan" && init?.method === "POST") {
        scanned = true;
        return json({ scanning: false, pending: 0, lastScanAt: null });
      }
      if (path.startsWith("/api/books/facets") && scanned) {
        const data = (await (await base(path, init)).json()) as BookFacets;
        return json({ ...data, total: 5, format: { ...data.format, pdf: data.format.pdf + 1 } });
      }
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <AppShell credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} api={api}>
          <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
          <RescanProbe />
        </AppShell>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /PDF Reading/ });

    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(scanned).toBe(true));

    fireEvent.click(await screen.findByRole("button", { name: "Filters" }));
    expect(await screen.findByRole("checkbox", { name: "PDF 3" })).toBeInTheDocument();
  });

  it("selects cards with the checkbox, keeps the bar in sync and clears on Escape", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    const first = await screen.findByRole("checkbox", { name: "Select Quiet Library 1" });
    fireEvent.click(first);

    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument();
    expect(screen.getByText("1 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(first).toBeChecked();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
    expect(first).not.toBeChecked();
  });

  it("selects the interval between the anchor and a shift-clicked card", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Quiet Library 1" }));
    // Third row in the reading order of the fixture: index 10.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Northern River 11" }), { shiftKey: true });

    expect(screen.getByText("3 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Patient Library 6" })).toBeChecked();
  });

  it("offers to select every result of the current filter and reports the server total", async () => {
    const api = mockBooksApi(createMockBooks({ count: 120 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Quiet Library 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select all 120 results" }));

    expect(screen.getByText("All 120 results selected", { selector: ".selection-count" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
  });

  it("selects every loaded row with Ctrl+A and clears the selection when the filter changes", async () => {
    const api = mockBooksApi(filterLibrary());
    render(
      <MemoryRouter initialEntries={["/?format=pdf"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /^Filters/ });
    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(screen.getByText("2 selected", { selector: ".selection-count" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: PDF" }));
    expect(await screen.findByText("Selection cleared.")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
  });

  it("hides selection controls on an older server", async () => {
    const api = mockBooksApi(createMockBooks({ count: 5 }), { facets: false });
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Quiet Library 1/ });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Filters/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: /^Select / })).not.toBeInTheDocument();
  });

  it("filters favorites from the URL, shows the chip and hides the UI on an old server", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    const { unmount } = render(
      <MemoryRouter initialEntries={["/?favorite=1"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Favorites" })).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("?favorite=1");
    unmount();

    const old = mockBooksApi(createMockBooks({ count: 12 }), { favorites: false });
    render(
      <MemoryRouter initialEntries={["/?favorite=1"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={old} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(await screen.findByText("12 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /favorites: Quiet Library 1/ })).not.toBeInTheDocument();
  });

  it("offers the favorite facet and filters the list from the panel", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Favorites 2" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?favorite=1"));
    expect(await screen.findByText("2 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("toggles a card favorite without navigating and updates the star", async () => {
    const api = vi.fn(mockBooksApi(createMockBooks({ count: 12 })));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    const star = await screen.findByRole("button", { name: "Add to favorites: Patient Library 6" });
    fireEvent.click(star);

    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "Remove from favorites: Patient Library 6" })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/books/mock-00006/favorite", { method: "PUT" });
    expect(screen.getByTestId("location").textContent).toBe("");
  });

  it("favorites the selected books and reports partial selection changes", async () => {
    const base = mockBooksApi(createMockBooks({ count: 12 }));
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/books/favorite" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ message: "The filtered selection changed", code: "selection_changed", total: 12 }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return base(path, init);
    });
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Patient Library 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    expect(await screen.findByText("The selection changed. Review the books and try again.")).toBeInTheDocument();
    expect(screen.getByText("1 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/books/favorite", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["mock-00006"], favorite: true }),
    });
  });

  it("favorites the selected books through the bulk endpoint", async () => {
    const api = vi.fn(mockBooksApi(createMockBooks({ count: 12 })));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Patient Library 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    expect(await screen.findByText("Added 1 book to favorites.")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/books/favorite", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["mock-00006"], favorite: true }),
    });
    expect(await screen.findByRole("button", { name: "Remove from favorites: Patient Library 6" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("uses the filtered selection with its expected total for every result", async () => {
    const api = vi.fn(mockBooksApi(createMockBooks({ count: 120 })));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Patient Library 6" }));
    expect(await screen.findByText("1 selected", { selector: ".selection-count" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all 120 results" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    expect(await screen.findByText("Added 120 books to favorites.")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/books/favorite", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: {}, expectedTotal: 120, favorite: true }),
    });
  });

  it("filters by tag from the URL and shows a removable chip", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter initialEntries={["/?tag=tag-favorites"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("4 titles", { selector: ".title-count" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Favorites" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Patient Library 6/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Quiet River 9/ })).toBeInTheDocument();
  });

  it("offers the tag checkboxes with facet counts in the filters panel", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Favorites 4" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("?tag=tag-favorites"));
    expect(await screen.findByText("4 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("applies a tag to the selection from the popover and opens it with T", async () => {
    const api = vi.fn(mockBooksApi(createMockBooks({ count: 12 })));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Quiet Library 1" }));
    fireEvent.keyDown(document.body, { key: "t" });

    const panel = screen.getByRole("group", { name: "Tag selected books" });
    expect(panel).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Research/ }));

    expect(await screen.findByText("Tags updated on 1 book.")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(
      "/api/books/tags",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ selection: { ids: ["mock-00001"] }, add: ["tag-research"] }),
      }),
    );
  });

  it("drops unknown tag ids from the URL instead of sending them", async () => {
    const api = mockBooksApi(createMockBooks({ count: 12 }));
    render(
      <MemoryRouter initialEntries={["/?tag=tag-does-not-exist"]}>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
    expect(await screen.findByText("12 titles", { selector: ".title-count" })).toBeInTheDocument();
  });

  it("keeps only the remainder selected after a partial deletion and finishes without repeating ids", async () => {
    const base = mockBooksApi(createMockBooks({ count: 12 }), { partialDeleteAfter: 1 });
    let remainingFromPartial: string[] = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      const response = await base(path, init);
      if (path === "/api/books/delete" && response.status === 409) {
        const body = (await response.clone().json()) as { remainingIds?: string[] };
        remainingFromPartial = body.remainingIds ?? [];
      }
      return response;
    });
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    // Wait for the reading sort to replace the provisional `added` page before
    // reading the loaded checkboxes.
    await waitFor(() => expect(screen.getAllByRole("link")[1]).toHaveAccessibleName(/Patient Library 6/), {
      timeout: 3000,
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Quiet Library 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Patient Library 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("heading", { name: "Delete 2 books?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 books" }));

    expect(
      await screen.findByText("Deleted 1 of 2. 1 book changed (new notes) and was not deleted — review again."),
    ).toBeInTheDocument();
    expect(screen.getByText("1 selected", { selector: ".selection-count" })).toBeInTheDocument();
    expect(remainingFromPartial).toHaveLength(1);

    expect(await screen.findByRole("heading", { name: "Delete 1 book?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete book" }));

    expect(await screen.findByText("Removed 2 books.")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("10 titles", { selector: ".title-count" })).toBeInTheDocument());
    const executions = api.mock.calls.flatMap(([path, init]) => {
      if (path !== "/api/books/delete") return [];
      const body = JSON.parse(String(init?.body)) as { dryRun?: boolean; selection?: { ids?: string[] } };
      return body.dryRun === false ? [body.selection] : [];
    });
    expect(executions).toHaveLength(2);
    expect(executions[0]?.ids).toHaveLength(2);
    expect(executions[1]?.ids).toEqual(remainingFromPartial);
  });

  it("deletes a selection through the dry-run dialog and clears it", async () => {
    const api = vi.fn(mockBooksApi(createMockBooks({ count: 12 })));
    render(
      <MemoryRouter>
        <Library credentials={{ user: "reader", pass: "secret" }} onLogout={vi.fn()} apiOverride={api} />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Filters" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Quiet Library 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Patient Library 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("heading", { name: "Delete 2 books?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 books" }));

    expect(await screen.findByText(/Removed 2 books\./)).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("10 titles", { selector: ".title-count" })).toBeInTheDocument());
    expect(api).toHaveBeenCalledWith(
      "/api/books/delete",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"dryRun":false'),
      }),
    );
  });
});
