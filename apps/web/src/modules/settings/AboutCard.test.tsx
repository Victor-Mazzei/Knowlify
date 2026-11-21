import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError } from "../../services/api";
import { AboutCard } from "./AboutCard";
import { createMockAboutApi } from "./aboutMock";

afterEach(() => vi.restoreAllMocks());

const clipboard = () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
};

describe("AboutCard", () => {
  it("shows the server build and copies the version with its commit", async () => {
    const writeText = clipboard();
    const { container } = render(<AboutCard api={createMockAboutApi()} webVersion="1.2.3" />);

    const mark = container.querySelector(".about-brand svg");
    expect(mark).toHaveAttribute("width", "32");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
    expect(screen.getByText("2026-11-07 12:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("22.11.0")).toBeInTheDocument();
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
    const source = screen.getByRole("link", { name: "Source code" });
    expect(source).toHaveAttribute("href", "https://github.com/knowlify/knowlify");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("1.2.3 (a3e1c7f)");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("warns when the web build differs from the server and reloads on request", async () => {
    const onReload = vi.fn();
    render(<AboutCard api={createMockAboutApi()} webVersion="1.2.2" onReload={onReload} />);

    const warning = await screen.findByText("Web UI is out of date (v1.2.2).");
    expect(warning).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("shows the web build alone when the server has no about route", async () => {
    render(<AboutCard api={createMockAboutApi({ scenario: "missing" })} webVersion="1.2.3" />);

    expect(await screen.findByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("Web UI")).toBeInTheDocument();
    expect(screen.getByText(/does not report its version/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
  });

  it("announces loading and retries a failed request", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const inner = createMockAboutApi();
    const api: ApiFn = async (path, init) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw new ApiError(500, "The server could not read its version.");
      }
      return inner(path, init);
    };
    render(<AboutCard api={api} webVersion="1.2.3" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading version…");
    await act(async () => release());
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not read its version.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
  });

  it("leaves dev builds alone even when the server reports another version", async () => {
    render(<AboutCard api={createMockAboutApi()} webVersion="0.0.0-dev" />);

    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
    expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
  });

  it("omits the source link when the URL is missing or is not http(s)", async () => {
    const { unmount } = render(<AboutCard api={createMockAboutApi({ scenario: "no-source" })} webVersion="1.2.3" />);
    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source code" })).not.toBeInTheDocument();
    unmount();

    render(<AboutCard api={createMockAboutApi({ scenario: "unsafe-source" })} webVersion="1.2.3" />);
    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source code" })).not.toBeInTheDocument();
  });

  it("accepts an older server that does not report a source URL", async () => {
    const api: ApiFn = async () =>
      new Response(
        JSON.stringify({ version: "1.2.3", commit: "a3e1c7f", builtAt: null, node: "22.11.0" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    render(<AboutCard api={api} webVersion="1.2.3" />);

    expect(await screen.findByText("1.2.3 (a3e1c7f)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source code" })).not.toBeInTheDocument();
  });
});
