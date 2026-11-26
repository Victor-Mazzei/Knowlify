import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../components/AppShell";
import { idleIndexStatus } from "../indexing/fixtures";
import { SettingsPage } from "../settings/SettingsPage";
import type { UpdateInfo } from "./updateTypes";

const credentials = { user: "reader", pass: "secret" };

const UPDATE: UpdateInfo = {
  enabled: true,
  locked: false,
  canManage: true,
  current: "2.4.0",
  latest: {
    version: "2.5.0",
    url: "https://github.com/Victor-Mazzei/Knowlify/releases/tag/v2.5.0",
  },
  available: true,
  checkedAt: "2026-11-25T12:00:00.000Z",
};

const ABOUT = {
  version: "2.4.0",
  commit: "21e132c",
  builtAt: "2026-11-25T12:00:00Z",
  node: "26.13.1",
  sourceUrl: "https://github.com/Victor-Mazzei/Knowlify",
};

const respond = (withUpdate: boolean) => async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/api/update")) {
    return withUpdate
      ? new Response(JSON.stringify(UPDATE), { headers: { "Content-Type": "application/json" } })
      : new Response("{}", { status: 404 });
  }
  if (url.endsWith("/api/about")) {
    return new Response(JSON.stringify(ABOUT), { headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/scan")) {
    return new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null }));
  }
  if (url.endsWith("/api/index/status")) return new Response(JSON.stringify(idleIndexStatus));
  if (url.endsWith("/api/chat/status")) {
    return new Response(
      JSON.stringify({
        enabled: false,
        host: null,
        promptVersion: "feynman-5",
        scopes: { library: true, book: true },
      }),
    );
  }
  if (url.endsWith("/api/sources")) return new Response(JSON.stringify([]));
  return new Response("{}", { status: 404 });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("update notice mounts", () => {
  it("mounts the banner once in the persistent shell", async () => {
    vi.stubGlobal("fetch", vi.fn(respond(true)));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell credentials={credentials} onLogout={vi.fn()} />}>
            <Route path="/" element={<main>library content</main>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Knowlify 2.5.0 is available. You have 2.4.0.");
  });

  it("places the card below About and hides it on an old server", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(respond(true)));
    const { unmount } = render(
      <MemoryRouter initialEntries={["/settings/about"]}>
        <Routes>
          <Route
            path="/settings/:section"
            element={<SettingsPage credentials={credentials} onLogout={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const about = await screen.findByRole("heading", { level: 2, name: "About" });
    const updates = await screen.findByRole("heading", { level: 2, name: "Updates" });
    expect(
      about.compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    unmount();

    vi.stubGlobal("fetch", vi.fn(respond(false)));
    render(
      <MemoryRouter initialEntries={["/settings/about"]}>
        <Routes>
          <Route
            path="/settings/:section"
            element={<SettingsPage credentials={credentials} onLogout={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { level: 2, name: "About" });
    expect(screen.queryByRole("heading", { name: "Updates" })).not.toBeInTheDocument();
  });
});
