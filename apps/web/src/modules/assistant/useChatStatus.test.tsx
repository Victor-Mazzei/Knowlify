import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { clearChatStatusCache, useChatStatus } from "./useChatStatus";

const CACHE_KEY = "knowlify.chat.enabled";

const enabledStatus = {
  enabled: true,
  model: "deepseek-v4.1-flash",
  host: "api.example.test",
  promptVersion: "feynman-2",
  scopes: { library: true, book: true },
};

function Harness({ api }: { api: ApiFn }) {
  const { enabled } = useChatStatus(api);
  return <output data-testid="ask">{String(enabled)}</output>;
}

function StatusHarness({ api }: { api: ApiFn }) {
  const { status } = useChatStatus(api);
  return <output data-testid="status">{JSON.stringify(status)}</output>;
}

beforeEach(() => sessionStorage.clear());

describe("useChatStatus", () => {
  it("reserves the Ask link from the session cache before the status answers", () => {
    sessionStorage.setItem(CACHE_KEY, "1");
    const pending = vi.fn(() => new Promise<Response>(() => undefined));
    render(<Harness api={pending} />);

    expect(screen.getByTestId("ask")).toHaveTextContent("true");
  });

  it("stores only the enabled flag for the next load", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify({ ...enabledStatus, enabled: false })));
    render(<Harness api={api} />);

    await waitFor(() => expect(screen.getByTestId("ask")).toHaveTextContent("false"));
    expect(sessionStorage.getItem(CACHE_KEY)).toBe("0");
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(CACHE_KEY)).not.toContain("example");
  });

  it("hides a stale reserved link when the status request fails", async () => {
    sessionStorage.setItem(CACHE_KEY, "1");
    const api = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Harness api={api} />);

    await waitFor(() => expect(screen.getByTestId("ask")).toHaveTextContent("false"));
    // The failed probe is not stored: the next load starts from the last confirmed answer.
    expect(sessionStorage.getItem(CACHE_KEY)).toBe("1");
  });

  it("reads the additive modes and session limits without dropping an older status", async () => {
    const withModes = {
      ...enabledStatus,
      modes: ["ask", "session"],
      sessionLimits: { maxSessions: 80, count: 3, maxMessages: 100 },
    };
    const api = vi.fn(async () => new Response(JSON.stringify(withModes)));
    const { unmount } = render(<StatusHarness api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent('"modes":["ask","session"]'),
    );
    expect(screen.getByTestId("status")).toHaveTextContent('"maxSessions":80');
    unmount();

    const older = vi.fn(async () => new Response(JSON.stringify(enabledStatus)));
    render(<StatusHarness api={older} />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent('"promptVersion"'));
    expect(screen.getByTestId("status")).not.toHaveTextContent('"modes"');
    expect(screen.getByTestId("status")).not.toHaveTextContent('"sessionLimits"');
  });

  it("reads the additive recommendation feature and hides a malformed one", async () => {
    const withFeature = { ...enabledStatus, features: { recommendations: true } };
    const api = vi.fn(async () => new Response(JSON.stringify(withFeature)));
    const { unmount } = render(<StatusHarness api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent('"recommendations":true'),
    );
    unmount();

    const malformed = vi.fn(async () =>
      new Response(JSON.stringify({ ...enabledStatus, features: { recommendations: "yes" } })),
    );
    render(<StatusHarness api={malformed} />);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("null"));
  });

  it("keeps a confirmed enabled status through a refresh", async () => {
    const api = vi.fn(async () => new Response(JSON.stringify(enabledStatus)));
    render(<Harness api={api} />);

    await waitFor(() => expect(screen.getByTestId("ask")).toHaveTextContent("true"));
    expect(sessionStorage.getItem(CACHE_KEY)).toBe("1");
  });

  it("drops the session cache without failing when storage is blocked", () => {
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => clearChatStatusCache()).not.toThrow();
    removeItem.mockRestore();
  });

  it("does not repopulate the cache when a pending answer lands after sign-out", async () => {
    sessionStorage.setItem(CACHE_KEY, "1");
    let resolveResponse!: (response: Response) => void;
    const api = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    render(<Harness api={api} />);

    clearChatStatusCache();
    await act(async () => {
      resolveResponse(new Response(JSON.stringify(enabledStatus)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });
});
