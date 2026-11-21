import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "./dialogs";
import { WorkspaceStatusProvider } from "./WorkspaceStatus";
import type { ChatStatusState } from "../modules/assistant/useChatStatus";
import { useChatStatusContext } from "../modules/assistant/useChatStatus";
import { idleIndexStatus } from "../modules/indexing/fixtures";

const credentials = { user: "reader", pass: "secret" };
const chatStatus = {
  enabled: true,
  model: "deepseek-v4.1-flash",
  host: "api.example.test",
  promptVersion: "feynman-2",
  scopes: { library: true, book: true },
};

const json = (body: unknown) => new Response(JSON.stringify(body));

function makeApi() {
  return vi.fn(async (path: string) => {
    if (path.endsWith("/api/chat/status")) return json(chatStatus);
    if (path.endsWith("/api/scan")) return json({ scanning: false, pending: 0, lastScanAt: null });
    if (path.endsWith("/api/index/status")) return json(idleIndexStatus);
    if (path.endsWith("/api/sources")) return json([]);
    return new Response("{}", { status: 404 });
  });
}

function Navigator() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/read/1")}>open reader</button>
      <button onClick={() => navigate("/")}>back to library</button>
    </>
  );
}

function StatusProbe({ seen }: { seen: ChatStatusState[] }) {
  const chat = useChatStatusContext();
  seen.push(chat);
  return <output data-testid="ask">{String(chat.enabled)}</output>;
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("WorkspaceStatusProvider", () => {
  it("keeps chat, scan, index and folder status when the reader renders outside the shell", async () => {
    const api = makeApi();
    const seen: ChatStatusState[] = [];
    const calls = (suffix: string) => api.mock.calls.filter(([path]) => String(path).endsWith(suffix)).length;
    render(
      <MemoryRouter>
        <WorkspaceStatusProvider credentials={credentials} onLogout={vi.fn()} api={api as ApiFn}>
          <Navigator />
          <Routes>
            <Route path="/" element={<StatusProbe seen={seen} />} />
            <Route path="/read/:id" element={<main>reader content</main>} />
          </Routes>
        </WorkspaceStatusProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("ask")).toHaveTextContent("true"));
    const resolved = seen[seen.length - 1];
    expect(calls("/api/chat/status")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "open reader" }));
    expect(screen.getByText("reader content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "back to library" }));
    // The first frame back already knows Ask is enabled: no late link and no refetch.
    expect(screen.getByTestId("ask")).toHaveTextContent("true");
    expect(seen[seen.length - 1]).toBe(resolved);
    expect(calls("/api/chat/status")).toBe(1);
    expect(calls("/api/scan")).toBe(1);
    expect(calls("/api/index/status")).toBe(1);
    expect(calls("/api/sources")).toBe(1);
  });
});
