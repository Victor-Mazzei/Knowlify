import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../components/AppShell";
import * as api from "../../services/api";
import { setTheme } from "../../services/theme";
import { idleIndexStatus } from "../indexing/fixtures";
import { initialLlmView } from "./llmMock";
import { initialMetadataView } from "./metadataSettingsMock";
import { SettingsEntry } from "./SettingsEntry";
import { SettingsPage } from "./SettingsPage";

const credentials = { user: "reader", pass: "secret" };

const respond = (url: string) => {
  if (url.endsWith("/api/scan")) return new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null }));
  if (url.endsWith("/api/index/status")) return new Response(JSON.stringify(idleIndexStatus));
  if (url.endsWith("/api/sources")) return new Response(JSON.stringify([]));
  if (url.endsWith("/api/settings/llm")) return new Response(JSON.stringify(initialLlmView("empty")));
  if (url.endsWith("/api/settings/metadata")) return new Response(JSON.stringify(initialMetadataView()));
  if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ items: [] }));
  if (url.endsWith("/api/account")) {
    return new Response(JSON.stringify({ user: "reader", canChangePassword: false, passwordSource: "env" }));
  }
  if (url.includes("/api/duplicates")) {
    return new Response(
      JSON.stringify({ groups: [], nextCursor: null, summary: { groups: 0, redundantBooks: 0, reclaimableBytes: 0 } }),
    );
  }
  return new Response("{}", { status: 404 });
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function Harness({ entry }: { entry: string }) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/folders" element={<Navigate to="/settings/folders" replace />} />
        <Route path="/settings" element={<SettingsEntry />} />
        <Route
          path="/settings/:section"
          element={
            <AppShell credentials={credentials} onLogout={vi.fn()}>
              <SettingsPage credentials={credentials} onLogout={vi.fn()} />
            </AppShell>
          }
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

const renderSettings = (entry: string) => render(<Harness entry={entry} />);

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(api, "getAccount").mockResolvedValue({ user: "reader", canChangePassword: false, passwordSource: "env" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
});

afterEach(() => {
  setTheme("system");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings navigation", () => {
  it("marks the active item and lists every group and section", async () => {
    renderSettings("/settings/folders");
    await screen.findByRole("heading", { level: 1, name: "Folders" });

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(within(nav).getByRole("heading", { name: "Library" })).toBeInTheDocument();
    expect(within(nav).getByRole("heading", { name: "Metadata" })).toBeInTheDocument();
    expect(within(nav).getByRole("heading", { name: "AI" })).toBeInTheDocument();
    expect(within(nav).getAllByRole("link")).toHaveLength(10);
    expect(within(nav).getByRole("link", { name: "Folders" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Tags" })).not.toHaveAttribute("aria-current");
  });

  it.each([
    ["folders", "folders", "Folders"],
    ["set-folders", "folders", "Folders"],
    ["tags", "tags", "Tags"],
    ["duplicates", "duplicates", "Duplicates"],
    ["ignored-books", "ignored-books", "Ignored books"],
    ["set-ignored", "ignored-books", "Ignored books"],
    ["search-index", "search-index", "Search index"],
    ["metadata", "metadata", "Metadata lookup"],
    ["llm", "ai", "AI assistant"],
    ["set-llm", "ai", "AI assistant"],
    ["mcp", "mcp", "MCP access"],
    ["account", "account", "Account"],
    ["appearance", "account", "Account"],
    ["set-reading", "account", "Account"],
    ["devices", "account", "Account"],
    ["about", "about", "About"],
  ])("sends the old /settings#%s anchor to the %s section", async (hash, section, label) => {
    renderSettings(`/settings#${hash}`);

    expect(await screen.findByTestId("location")).toHaveTextContent(`/settings/${section}`);
    expect(screen.getByTestId("location")).not.toHaveTextContent("#");
    expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
  });

  it("opens Folders when /settings has no anchor", async () => {
    renderSettings("/settings");
    expect(await screen.findByTestId("location")).toHaveTextContent("/settings/folders");
    expect(await screen.findByRole("heading", { level: 1, name: "Folders" })).toBeInTheDocument();
  });

  it("sends /folders to the Folders section", async () => {
    renderSettings("/folders");
    expect(await screen.findByTestId("location")).toHaveTextContent("/settings/folders");
    expect(await screen.findByRole("heading", { level: 1, name: "Folders" })).toBeInTheDocument();
  });

  it("mounts only the active section", async () => {
    const fetchMock = vi.mocked(fetch);
    renderSettings("/settings/folders");
    await screen.findByRole("heading", { level: 1, name: "Folders" });
    await screen.findByRole("heading", { level: 2, name: "Folders" });

    const paths = () => fetchMock.mock.calls.map(([input]) => String(input));
    expect(paths().some((path) => path.endsWith("/api/tags"))).toBe(false);
    expect(paths().some((path) => path.includes("/api/duplicates"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/api/mcp/tokens"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/api/settings/llm"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/api/settings/metadata"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/api/ignored-books"))).toBe(false);
    expect(paths().some((path) => path.endsWith("/api/about"))).toBe(false);

    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "Tags" }));
    await screen.findByRole("heading", { level: 1, name: "Tags" });
    await waitFor(() => expect(paths().some((path) => path.endsWith("/api/tags"))).toBe(true));
    expect(screen.queryByRole("heading", { name: "Folders" })).not.toBeInTheDocument();
    expect(paths().some((path) => path.includes("/api/duplicates"))).toBe(false);
  });

  it("scrolls to the top, focuses the section title and announces the change", async () => {
    renderSettings("/settings/account");
    const title = await screen.findByRole("heading", { level: 1, name: "Account" });
    await waitFor(() => expect(title).toHaveFocus());

    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "About" }));
    const next = await screen.findByRole("heading", { level: 1, name: "About" });
    await waitFor(() => expect(next).toHaveFocus());
    expect(await screen.findByText("About section")).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it.each(["not-a-section", "toString", "__proto__"])("shows a friendly message for %s", async (unknown) => {
    renderSettings(`/settings/${unknown}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Section not found" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Go to Folders" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Folders" })).toBeInTheDocument();
  });

  it("keeps the account card and this device's preferences in the Account section", async () => {
    renderSettings("/settings/account");
    await waitFor(() => expect(screen.getByText("Your password is managed by the app.")).toBeInTheDocument());
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Folders" })).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("group", { name: "Theme" })).getByRole("button", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    fireEvent.click(within(screen.getByRole("group", { name: "Default view" })).getByRole("button", { name: "Table" }));
    expect(localStorage.getItem("knowlify.view")).toBe("table");
    expect(screen.getByRole("heading", { name: "Connect a device" })).toBeInTheDocument();
  });
});
