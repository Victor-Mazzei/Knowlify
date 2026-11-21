import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { idleIndexStatus, indexStatus } from "./modules/indexing/fixtures";
import { initialLlmView } from "./modules/settings/llmMock";

const CHAT_CACHE_KEY = "knowlify.chat.enabled";
const enabledChatStatus = {
  enabled: true,
  model: "deepseek-v4.1-flash",
  host: "api.example.test",
  promptVersion: "feynman-2",
  scopes: { library: true, book: true },
};
const disabledChatStatus = {
  enabled: false,
  model: null,
  host: null,
  promptVersion: "feynman-2",
  scopes: { library: false, book: false },
};

const respond = (url: string) => {
  if (url.endsWith("/api/scan")) return new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null }));
  if (url.endsWith("/api/index/status")) return new Response(JSON.stringify(idleIndexStatus));
  if (url.endsWith("/api/chat/status")) return new Response(JSON.stringify(disabledChatStatus));
  if (url.endsWith("/api/sources")) return new Response(JSON.stringify([]));
  if (url.endsWith("/api/settings/llm")) return new Response(JSON.stringify(initialLlmView("empty")));
  if (url.includes("/api/duplicates")) {
    return new Response(JSON.stringify({ groups: [], nextCursor: null, summary: { groups: 0, redundantBooks: 0, reclaimableBytes: 0 } }));
  }
  return new Response("{}", { status: 404 });
};

async function signIn(user: string, pass: string) {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: pass } });
  fireEvent.click(screen.getByRole("button", { name: "Enter library" }));
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

function Navigator() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/read/1")}>Open reader</button>
      <button onClick={() => navigate("/")}>Back to library</button>
    </>
  );
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App routes", () => {
  it("redirects /folders to the Folders card in Settings", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
    render(
      <MemoryRouter initialEntries={["/folders"]}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("location")).toHaveTextContent("/settings/folders");
    expect(await screen.findByRole("heading", { level: 1, name: "Folders" })).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById("settings-section-title")).toHaveFocus());
  });

  it("keeps the status above the routes so the reader round trip does not refetch or hide Ask", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/chat/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            model: "deepseek-v4.1-flash",
            host: "api.example.test",
            promptVersion: "feynman-2",
            scopes: { library: true, book: true },
          }),
        );
      }
      return respond(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
        <Navigator />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Ask" })).toBeInTheDocument();
    const chatCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/chat/status")).length;
    expect(chatCalls()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Open reader" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/read/1"));

    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    // The provider survived the reader route: Ask is in the first frame of the remounted shell.
    expect(screen.getByRole("link", { name: "Ask" })).toBeInTheDocument();
    expect(chatCalls()).toBe(1);
  });

  it("clears the reserved Ask flag on logout and the next login starts unconfirmed", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    let chatRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/chat/status")) {
        chatRequests += 1;
        if (chatRequests === 1) return new Response(JSON.stringify(enabledChatStatus));
        return new Promise<Response>(() => undefined);
      }
      return respond(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Ask" })).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(CHAT_CACHE_KEY)).toBe("1"));

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: /Sign in to your/ })).toBeInTheDocument();
    expect(sessionStorage.getItem(CHAT_CACHE_KEY)).toBeNull();

    await signIn("next-reader", "new-secret");
    expect(await screen.findByRole("button", { name: "Log out" })).toBeInTheDocument();
    // The new session's status is still pending: it must not inherit the old flag.
    expect(screen.queryByRole("link", { name: "Ask" })).not.toBeInTheDocument();
  });

  it("clears the reserved Ask flag when a request answers 401", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    sessionStorage.setItem(CHAT_CACHE_KEY, "1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/chat/status")) return new Response("", { status: 401 });
        return respond(url);
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: /Sign in to your/ })).toBeInTheDocument();
    expect(sessionStorage.getItem(CHAT_CACHE_KEY)).toBeNull();
  });

  it("keeps the session after a password change and ignores 401s sent with the old password", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    let scanRequests = 0;
    let resolveOldScan!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/scan")) {
        scanRequests += 1;
        if (scanRequests === 1) {
          return new Promise<Response>((resolve) => {
            resolveOldScan = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null })));
      }
      if (url.endsWith("/api/account/password")) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith("/api/account")) {
        return Promise.resolve(
          new Response(JSON.stringify({ user: "reader", canChangePassword: true, passwordSource: "user" })),
        );
      }
      return Promise.resolve(respond(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/settings/account"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "next-secret" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "next-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(
      await screen.findByText("Password changed. Other devices, including KOReader, need the new password."),
    ).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("knowlify-credentials") ?? "null")).toEqual({
      user: "reader",
      pass: "next-secret",
    });

    await act(async () => {
      resolveOldScan(new Response("", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByRole("button", { name: "Log out" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: /Sign in to your/ })).not.toBeInTheDocument();
  });

  it("ignores a late 401 from the previous session after re-login with the same credentials", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    let scanRequests = 0;
    let resolveOldScan!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/scan")) {
        scanRequests += 1;
        if (scanRequests === 1) {
          return new Promise<Response>((resolve) => {
            resolveOldScan = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ scanning: false, pending: 0, lastScanAt: null })));
      }
      return Promise.resolve(respond(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: /Sign in to your/ })).toBeInTheDocument();

    // The same credentials must still belong to a new local session.
    await signIn("reader", "secret");
    expect(await screen.findByRole("button", { name: "Log out" })).toBeInTheDocument();

    await act(async () => {
      resolveOldScan(new Response("", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Sign in to your/ })).not.toBeInTheDocument();
  });

  it("queries the new session's index after a password change and ignores the old 401", async () => {
    localStorage.setItem("knowlify-credentials", JSON.stringify({ user: "reader", pass: "secret" }));
    let indexRequests = 0;
    let resolveOldIndex!: (response: Response) => void;
    const freshIndex = indexStatus({ counts: { pending: 0, indexing: 0, ready: 42, error: 0 }, revision: 42 });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/index/status")) {
        indexRequests += 1;
        if (indexRequests === 1) {
          return new Promise<Response>((resolve) => {
            resolveOldIndex = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify(freshIndex)));
      }
      if (url.endsWith("/api/account/password")) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith("/api/account")) {
        return Promise.resolve(
          new Response(JSON.stringify({ user: "reader", canChangePassword: true, passwordSource: "user" })),
        );
      }
      return Promise.resolve(respond(url));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/settings/account"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "secret" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "next-secret" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "next-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(
      await screen.findByText("Password changed. Other devices, including KOReader, need the new password."),
    ).toBeInTheDocument();
    // The provider survives the credential change, so the index hook must not reuse the old promise.
    await waitFor(() => expect(indexRequests).toBe(2));
    fireEvent.click(screen.getByRole("link", { name: "Search index" }));
    const card = await screen.findByRole("region", { name: "Search index" });
    expect(within(card).getByText("42")).toBeInTheDocument();

    await act(async () => {
      resolveOldIndex(new Response("", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByRole("button", { name: "Log out" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: /Sign in to your/ })).not.toBeInTheDocument();
    expect(within(card).getByText("42")).toBeInTheDocument();
    expect(indexRequests).toBe(2);
  });
});
