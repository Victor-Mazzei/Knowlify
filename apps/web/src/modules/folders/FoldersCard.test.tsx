import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanStatusContext } from "../../components/ScanStatusContext";
import type { ScanStatusContextValue } from "../../components/ScanStatusContext";
import type { FolderListing } from "./types";
import type { Source } from "../../types";
import { FoldersCard } from "./FoldersCard";

const scanStatus = { scanning: false, pending: 0, lastScanAt: null };
const sources: Source[] = [{ id: "1", path: "/books", accessible: true, books: 2 }];

function listing(overrides: Partial<FolderListing> = {}): FolderListing {
  return { path: "/books", parent: null, entries: [], books: 2, ...overrides };
}

function makeApi(fs: FolderListing = listing(), initial: Source[] = sources) {
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/sources" && !init?.method) return new Response(JSON.stringify(initial));
    if (path === "/api/sources" && init?.method === "POST") return new Response(JSON.stringify({ id: "2" }));
    if (path.startsWith("/api/sources/") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.startsWith("/api/fs")) return new Response(JSON.stringify(fs));
    return new Response("{}", { status: 404 });
  });
  return api;
}

function scanValue(overrides: Partial<ScanStatusContextValue> = {}): ScanStatusContextValue {
  return {
    status: scanStatus,
    error: false,
    refresh: vi.fn(async () => scanStatus),
    rescan: vi.fn(async () => undefined),
    wake: vi.fn(),
    libraryRevision: 0,
    sourcesRevision: 0,
    sources,
    sourcesLoading: false,
    sourcesError: "",
    refreshSources: vi.fn(async () => undefined),
    ...overrides,
  };
}

function card(api: ReturnType<typeof makeApi>, scan: ScanStatusContextValue, hash = "#folders") {
  return (
    <MemoryRouter initialEntries={[`/settings${hash}`]}>
      <ScanStatusContext.Provider value={scan}>
        <FoldersCard api={api} />
      </ScanStatusContext.Provider>
    </MemoryRouter>
  );
}

function renderCard(overrides: { api?: ReturnType<typeof makeApi>; scan?: ScanStatusContextValue; hash?: string } = {}) {
  const api = overrides.api ?? makeApi();
  const scan = overrides.scan ?? scanValue();
  const view = render(card(api, scan, overrides.hash));
  return { ...view, api, scan };
}

function stubScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function stubFontsReady() {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
  return { resolve };
}

function stubResizeObserver() {
  let callback: ResizeObserverCallback | undefined;
  class FakeResizeObserver {
    constructor(next: ResizeObserverCallback) {
      callback = next;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return { trigger: () => callback?.([], {} as ResizeObserver) };
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function renderWithHeader(headerHeight: number) {
  const api = makeApi();
  const scan = scanValue();
  const view = render(
    <div className="app">
      <header>Settings</header>
      {card(api, scan)}
    </div>,
  );
  const header = view.container.querySelector("header");
  if (!header) throw new Error("Missing app header");
  let height = headerHeight;
  vi.spyOn(header, "getBoundingClientRect").mockImplementation(() => ({ height } as DOMRect));
  return {
    ...view,
    api,
    scan,
    setHeaderHeight: (next: number) => {
      height = next;
    },
  };
}

afterEach(() => {
  delete window.__TAURI__;
  delete window.__KNOWLIFY__;
  Reflect.deleteProperty(document, "fonts");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("FoldersCard", () => {
  it("lists the configured folders and focuses the #folders anchor", async () => {
    renderCard();
    expect(await screen.findByText("/books")).toBeInTheDocument();
    expect(screen.getByText("Accessible · 2 books")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
  });

  it("shows an empty state when no folders are configured", async () => {
    renderCard({ scan: scanValue({ sources: [] }) });
    expect(await screen.findByText("No library folders yet")).toBeInTheDocument();
    expect(screen.getByText(/Add a folder with PDF or EPUB files/)).toBeInTheDocument();
  });

  it("adds the folder chosen in the picker", async () => {
    const api = makeApi();
    const scan = scanValue();
    renderCard({ api, scan });
    expect(await screen.findByText("/books")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose a library folder" });
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/fs"));

    fireEvent.click(within(picker).getByRole("button", { name: "Select this folder" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/sources",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/books" }) }),
      ),
    );
    await waitFor(() => expect(scan.refreshSources).toHaveBeenCalled());
    expect(scan.refresh).toHaveBeenCalled();
    expect(scan.wake).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Choose a library folder" })).not.toBeInTheDocument(),
    );
  });

  it("adds a typed path from the secondary field", async () => {
    const { api } = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Enter a path instead" }));
    fireEvent.change(screen.getByLabelText("Folder path"), { target: { value: "/library" } });
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/sources",
        expect.objectContaining({ body: JSON.stringify({ path: "/library" }) }),
      ),
    );
  });

  it("uses the native dialog when the desktop app runs the local server", async () => {
    window.__KNOWLIFY__ = { apiBaseUrl: "http://127.0.0.1:4321", credentials: { user: "desktop", pass: "secret" } };
    const invoke = vi.fn(async () => "/native/books");
    window.__TAURI__ = { core: { invoke } };
    const api = makeApi();
    renderCard({ api });

    fireEvent.click(await screen.findByRole("button", { name: "Add folder…" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:dialog|open", {
        options: { directory: true, multiple: false, title: "Choose a library folder" },
      }),
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/api/sources",
        expect.objectContaining({ body: JSON.stringify({ path: "/native/books" }) }),
      ),
    );
    expect(api.mock.calls.some(([path]) => String(path).startsWith("/api/fs"))).toBe(false);
  });

  it("falls back to the picker when the native dialog fails", async () => {
    window.__KNOWLIFY__ = { apiBaseUrl: "http://127.0.0.1:4321" };
    window.__TAURI__ = { core: { invoke: vi.fn(async () => { throw new Error("dialog plugin missing"); }) } };
    const { api } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Add folder…" }));
    expect(await screen.findByRole("dialog", { name: "Choose a library folder" })).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/fs"));
  });

  it("uses the picker instead of the native dialog for a remote server", async () => {
    window.__KNOWLIFY__ = { apiBaseUrl: "https://books.example.com" };
    const invoke = vi.fn(async () => "/native/books");
    window.__TAURI__ = { core: { invoke } };
    const { api } = renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Add folder…" }));
    expect(await screen.findByRole("dialog", { name: "Choose a library folder" })).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/fs"));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("explains a restricted server in the picker", async () => {
    renderCard({ api: makeApi(listing({ path: "", restricted: true, entries: [] })) });
    fireEvent.click(await screen.findByRole("button", { name: "Add folder…" }));
    expect(await screen.findByRole("heading", { name: "Choose an allowed folder" })).toBeInTheDocument();
    expect(screen.getByText(/Only folders mounted into the Knowlify container/)).toBeInTheDocument();
  });

  it("confirms before removing a folder", async () => {
    const { api, scan } = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Remove library folder /books" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove folder" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/sources/1", { method: "DELETE" }));
    await waitFor(() => expect(scan.refreshSources).toHaveBeenCalled());
  });

  it("rescans from the card and reports a failure", async () => {
    const scan = scanValue({ rescan: vi.fn(async () => { throw new Error("Server unavailable"); }) });
    renderCard({ scan });
    fireEvent.click(await screen.findByRole("button", { name: "Rescan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server unavailable");
  });

  it("shows the loading state while the shell reads the folders", async () => {
    renderCard({ scan: scanValue({ sources: [], sourcesLoading: true }) });
    expect(await screen.findByText("Loading folders…")).toBeInTheDocument();
  });

  it("renders the source metadata refreshed by the shell", async () => {
    const api = makeApi();
    const scan = scanValue();
    const { rerender } = renderCard({ api, scan });
    expect(await screen.findByText("/books")).toBeInTheDocument();

    const updated: Source[] = [{ id: "1", path: "/books", accessible: true, books: 5 }];
    rerender(card(api, { ...scan, sources: updated, sourcesRevision: 1 }, "#folders"));
    expect(await screen.findByText("Accessible · 5 books")).toBeInTheDocument();
  });

  it("keeps a focused field when fonts become ready after the user moves on", async () => {
    const scrollIntoView = stubScrollIntoView();
    const fonts = stubFontsReady();
    renderCard();

    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Enter a path instead" }));
    const input = screen.getByLabelText("Folder path");
    input.focus();
    expect(input).toHaveFocus();

    Object.defineProperty(window, "scrollY", { configurable: true, value: 320 });
    await act(async () => {
      fonts.resolve();
    });

    expect(input).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(window.scrollY).toBe(320);
  });

  it("does not jump back when fonts become ready after the user scrolls", async () => {
    const scrollIntoView = stubScrollIntoView();
    const fonts = stubFontsReady();
    renderCard();

    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // Let the guard for the initial programmatic scroll expire before scrolling.
    await act(async () => {
      await nextFrame();
    });

    Object.defineProperty(window, "scrollY", { configurable: true, value: 480 });
    fireEvent.scroll(window);

    await act(async () => {
      fonts.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(window.scrollY).toBe(480);
  });

  it("re-applies the header offset on resize while the anchor owns focus", async () => {
    const scrollIntoView = stubScrollIntoView();
    const observer = stubResizeObserver();
    stubFontsReady();
    const { setHeaderHeight } = renderWithHeader(60);

    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(section.style.scrollMarginTop).toBe("72px");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    setHeaderHeight(120);
    act(() => observer.trigger());

    expect(section).toHaveFocus();
    expect(section.style.scrollMarginTop).toBe("132px");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("leaves focus and scroll alone on late work after the user moves on", async () => {
    const scrollIntoView = stubScrollIntoView();
    const observer = stubResizeObserver();
    const fonts = stubFontsReady();
    const { setHeaderHeight } = renderWithHeader(60);

    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    const button = screen.getByRole("button", { name: "Add folder…" });
    button.focus();
    setHeaderHeight(120);

    act(() => observer.trigger());
    await act(async () => {
      fonts.resolve();
    });

    expect(button).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(section.style.scrollMarginTop).toBe("132px");
  });

  it("still focuses the anchor when fonts are ready before the first frame", async () => {
    const scrollIntoView = stubScrollIntoView();
    const fonts = stubFontsReady();
    renderCard();

    await act(async () => {
      fonts.resolve();
    });

    const section = screen.getByRole("region", { name: "Folders" });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
