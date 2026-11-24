import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { busyIndexStatus } from "../modules/indexing/fixtures";
import type { Credentials } from "../types";

const credentials: Credentials = { user: "reader", pass: "secret" };

const apiResponse = (url: string) => {
  if (url.endsWith("/api/scan")) {
    return new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null }));
  }
  if (url.endsWith("/api/index/status")) {
    return new Response(JSON.stringify(busyIndexStatus));
  }
  if (url.endsWith("/api/chat/status")) {
    return new Response(
      JSON.stringify({
        enabled: true,
        model: "deepseek-v4.1-flash",
        host: "api.deepseek.com",
        promptVersion: "feynman-1",
        scopes: { library: true, book: true },
      }),
    );
  }
  if (url.endsWith("/api/sources")) return new Response(JSON.stringify([]));
  return new Response("{}", { status: 404 });
};

function stubShortViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-height: 620px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderShell(initialEntries = ["/"]) {
  const onLogout = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route element={<AppShell credentials={credentials} onLogout={onLogout} />}>
          <Route path="/" element={<main>library content</main>} />
          <Route path="/ask" element={<main>ask content</main>} />
          <Route path="/notes" element={<main>notes content</main>} />
          <Route path="/settings" element={<main>settings content</main>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, onLogout };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("renders navigation, search-index activity and logout without a folders menu", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => apiResponse(String(input))));
    const { onLogout, container } = renderShell();

    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    expect(container.querySelector(".app")).not.toHaveClass("app-ask");
    expect(screen.getByRole("link", { name: "Knowlify" })).toContainElement(
      container.querySelector(".brand svg[aria-hidden='true']"),
    );
    expect(await screen.findByRole("link", { name: "Ask" })).toHaveAttribute("href", "/ask");
    expect(screen.getByText("library content")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Indexing for search 2 of 9");
    expect(screen.queryByRole("button", { name: "Folders" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("lets the Ask route own the viewport so only the transcript scrolls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => apiResponse(String(input))));
    const { container } = renderShell(["/ask"]);

    expect(await screen.findByText("ask content")).toBeInTheDocument();
    expect(container.querySelector(".app")).toHaveClass("app-ask");
  });

  it("keeps navigation reachable on a short Ask viewport and exits the route", async () => {
    stubShortViewport();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => apiResponse(String(input))));
    const { container } = renderShell(["/ask"]);

    expect(await screen.findByText("ask content")).toBeInTheDocument();
    expect(container.querySelector(".app")).toHaveClass("app-ask", "app-compact");
    expect(screen.queryByRole("link", { name: "Notes" })).not.toBeInTheDocument();

    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("link", { name: "Notes" })).not.toBeInTheDocument();
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();

    // The menu is the keyboard path out of /ask when the header is collapsed.
    fireEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    expect(screen.getByText("notes content")).toBeInTheDocument();
    expect(container.querySelector(".app")).not.toHaveClass("app-ask");
    expect(container.querySelector(".app")).not.toHaveClass("app-compact");
    expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "Menu" })).not.toBeInTheDocument();
  });

  it("keeps the same header and status requests when the route changes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => apiResponse(String(input)));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderShell();
    await screen.findByRole("link", { name: "Ask" });

    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    const calls = (suffix: string) => fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length;
    expect(calls("/api/chat/status")).toBe(1);
    expect(calls("/api/scan")).toBe(1);
    expect(calls("/api/index/status")).toBe(1);

    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    expect(screen.getByText("notes content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Library" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Ask" })).toBeInTheDocument();
    expect(container.querySelector("header")).toBe(header);

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByText("settings content")).toBeInTheDocument();
    expect(container.querySelector("header")).toBe(header);

    // The persistent shell must not restart network polling on every navigation.
    expect(calls("/api/chat/status")).toBe(1);
    expect(calls("/api/scan")).toBe(1);
    expect(calls("/api/index/status")).toBe(1);
  });

  it("settles the navigation without removing the shell when the chat status arrives late", async () => {
    let resolveChat!: (response: Response) => void;
    const chat = new Promise<Response>((resolve) => {
      resolveChat = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/chat/status")) return chat;
        return apiResponse(url);
      }),
    );
    const { container } = renderShell();
    const header = container.querySelector("header");

    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    expect(screen.getByText("notes content")).toBeInTheDocument();
    expect(container.querySelector("header")).toBe(header);

    resolveChat(apiResponse("/api/chat/status"));
    await screen.findByRole("link", { name: "Ask" });
    expect(container.querySelector("header")).toBe(header);
    expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
  });
});
