import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, LOCAL_ONLY_MESSAGE } from "../../services/api";
import { McpCard } from "./McpCard";
import { createMockMcpApi, type MockMcpScenario } from "./mcpMock";

type Call = { path: string; init?: RequestInit };

const mock = (scenario: MockMcpScenario) => createMockMcpApi({ scenario });

const spyApi = (inner: ApiFn) => {
  const calls: Call[] = [];
  const api: ApiFn = (path, init) => {
    calls.push({ path, init });
    return inner(path, init);
  };
  return { api, calls };
};

const tokenRegion = () => screen.getByRole("region", { name: "Active tokens" });

const createToken = async () => {
  fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Laptop" } });
  fireEvent.click(screen.getByRole("radio", { name: /Read and write notes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  return screen.findByRole("dialog", { name: "Your new MCP token" });
};

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__KNOWLIFY__;
});

describe("McpCard", () => {
  it("shows a skeleton, then the empty state and the endpoint", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = mock("empty");
    const api: ApiFn = async (path, init) => {
      await gate;
      return inner(path, init);
    };
    render(<McpCard api={api} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading MCP access…");
    await act(async () => release());
    expect(await screen.findByText(/No tokens yet/)).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    expect(screen.getByText("No tokens")).toBeInTheDocument();
  });

  it("lists active tokens with scope, created and last use, and revokes one after confirmation", async () => {
    const { api, calls } = spyApi(mock("populated"));
    render(<McpCard api={api} />);

    const list = await screen.findByRole("region", { name: "Active tokens" });
    expect(within(list).getByText("Claude Code")).toBeInTheDocument();
    expect(within(list).getByText("write_notes")).toBeInTheDocument();
    expect(within(list).getByText("read")).toBeInTheDocument();
    expect(within(list).getByText("Never used")).toBeInTheDocument();
    expect(screen.getByText("2 active")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Claude Code" }));
    const confirm = screen.getByRole("alertdialog", { name: "Revoke token?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke token" }));

    expect(await screen.findByText("Token revoked.")).toBeInTheDocument();
    await waitFor(() => expect(within(list).queryByText("Claude Code")).not.toBeInTheDocument());
    expect(
      calls.some((call) => call.path.endsWith("/api/mcp/tokens/tok_claude") && call.init?.method === "DELETE"),
    ).toBe(true);
  });

  it("reveals a new token once, copies it, and confirms before closing", async () => {
    const { api, calls } = spyApi(mock("empty"));
    render(<McpCard api={api} />);
    await screen.findByText(/No tokens yet/);

    const dialog = await createToken();
    const token = within(dialog).getByText(/^knw_mcp_/).textContent ?? "";
    expect(token).toMatch(/^knw_mcp_/);
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.init?.body))).toEqual({ name: "Laptop", scope: "write_notes" });
    expect(within(tokenRegion()).getByText("Laptop")).toBeInTheDocument();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const confirm = screen.getByRole("alertdialog", { name: "Close without saving the token?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Your new MCP token" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Close without saving the token?" })).getByRole("button", {
        name: "Close anyway",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Your new MCP token" })).not.toBeInTheDocument());
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain(token);
    expect(window.location.href).not.toContain(token);
  });

  it("shows the disabled state reported by the server and hides controls", async () => {
    render(<McpCard api={mock("disabled")} />);

    expect(await screen.findByText(/MCP access is disabled by the server operator/)).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
    expect(screen.queryByText(`${window.location.origin}/mcp`)).not.toBeInTheDocument();
  });

  it("explains that MCP tokens are managed only on the computer", async () => {
    render(<McpCard api={mock("local_only")} />);

    expect(await screen.findByText(LOCAL_ONLY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
  });

  it("shows the local-only message when creating a token is blocked", async () => {
    const base = mock("empty");
    const api: ApiFn = (path, init) => {
      if (init?.method === "POST") return Promise.reject(new ApiError(403, "Forbidden", "local_only"));
      return base(path, init);
    };
    render(<McpCard api={api} />);
    await screen.findByText(/No tokens yet/);

    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(LOCAL_ONLY_MESSAGE);
    expect(screen.queryByRole("dialog", { name: "Your new MCP token" })).not.toBeInTheDocument();
  });

  it("honors enabled:false from a server that keeps the token route", async () => {
    const api: ApiFn = async () =>
      new Response(JSON.stringify({ enabled: false, path: "/mcp", items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    render(<McpCard api={api} />);

    expect(await screen.findByText(/MCP access is disabled by the server operator/)).toBeInTheDocument();
  });

  it("stays hidden when the server predates the MCP route", async () => {
    const api: ApiFn = async () => {
      throw new ApiError(404, "Not Found");
    };
    const { container } = render(<McpCard api={api} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("retries after the token list fails to load", async () => {
    const inner = mock("populated");
    let failed = false;
    const api: ApiFn = async (path, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (!failed && method === "GET" && path === "/api/mcp/tokens") {
        failed = true;
        throw new ApiError(500, "The server could not load MCP tokens.");
      }
      return inner(path, init);
    };
    render(<McpCard api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not load MCP tokens.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const list = await screen.findByRole("region", { name: "Active tokens" });
    expect(within(list).getByText("Claude Code")).toBeInTheDocument();
  });

  it("stops creation at the 20-token limit and explains a server limit race", async () => {
    const { unmount } = render(<McpCard api={mock("limit")} />);
    expect(await screen.findByText(/maximum of 20 active tokens/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
    unmount();

    const inner = mock("empty");
    const api: ApiFn = async (path, init) => {
      if (path === "/api/mcp/tokens" && init?.method === "POST") {
        throw new ApiError(409, "Token limit reached.", "token_limit_reached");
      }
      return inner(path, init);
    };
    render(<McpCard api={api} />);
    await screen.findByText(/No tokens yet/);
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Extra" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You can have up to 20 active tokens.");
    expect(screen.getByRole("button", { name: "Create token" })).toBeEnabled();
  });

  it("keeps focus in the reveal dialog and confirms Escape before closing", async () => {
    render(<McpCard api={mock("empty")} />);
    await screen.findByText(/No tokens yet/);
    const dialog = await createToken();

    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    const confirm = await screen.findByRole("alertdialog", { name: "Close without saving the token?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("dialog", { name: "Your new MCP token" })).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });
});
