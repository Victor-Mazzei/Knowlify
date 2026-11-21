import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpExamples } from "./McpExamples";

afterEach(() => vi.restoreAllMocks());

const endpoint = "http://localhost:8787/mcp";

describe("McpExamples", () => {
  it("builds all three examples with the real endpoint and a token placeholder", () => {
    render(<McpExamples endpoint={endpoint} />);
    fireEvent.click(screen.getByText("Connection examples"));

    expect(
      screen.getByText(
        'claude mcp add --transport http knowlify http://localhost:8787/mcp --header "Authorization: Bearer <YOUR_TOKEN>"',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Claude Desktop (mcp-remote)")).toBeInTheDocument();
    expect(screen.getByText(/"command": "npx"/).closest("pre")).toHaveTextContent(
      '"Authorization: Bearer <YOUR_TOKEN>"',
    );
    expect(screen.getByText(/Replace <YOUR_TOKEN> with a token you created\./)).toBeInTheDocument();
    expect(screen.queryByText(/knw_mcp_/)).not.toBeInTheDocument();
  });

  it("copies a command and announces it", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<McpExamples endpoint={endpoint} />);
    fireEvent.click(screen.getByText("Connection examples"));
    fireEvent.click(screen.getByRole("button", { name: "Copy Claude Code" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'claude mcp add --transport http knowlify http://localhost:8787/mcp --header "Authorization: Bearer <YOUR_TOKEN>"',
      ),
    );
    expect(screen.getByText("Claude Code copied to clipboard.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Claude Code" })).toHaveTextContent("Copied");
  });

  it("uses the real token inside the one-time reveal dialog", () => {
    render(<McpExamples endpoint={endpoint} token="knw_mcp_secret" />);
    fireEvent.click(screen.getByText("Connection examples"));

    expect(screen.getByText(/The token from this window is filled in below\./)).toBeInTheDocument();
    expect(screen.queryByText(/<YOUR_TOKEN>/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/knw_mcp_secret/).length).toBeGreaterThan(0);
  });
});
