import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateCard } from "./UpdateCard";
import { UPDATE_DISMISSED_KEY } from "./useUpdateNotice";
import type { UpdateInfo } from "./updateTypes";

const INFO: UpdateInfo = {
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const apiWith = (value: UpdateInfo | null, status = 200): ApiFn => async () =>
  value ? json(value) : new Response("{}", { status });

const flush = () => act(async () => {});

afterEach(() => {
  localStorage.clear();
  delete window.__TAURI__;
  delete window.__KNOWLIFY__;
});

describe("UpdateBanner", () => {
  it("shows the new release as a status with a safe browser link", async () => {
    render(<UpdateBanner api={apiWith(INFO)} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Knowlify 2.5.0 is available. You have 2.4.0.");
    expect(status).toHaveTextContent("Update your server. If you use Docker, pull the new image.");
    expect(status).not.toHaveAttribute("role", "alert");

    const link = screen.getByRole("link", { name: "View release" });
    expect(link).toHaveAttribute("href", INFO.latest?.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("uses the installer copy on the local desktop and opens the bridge", async () => {
    const invoke = vi.fn(async () => undefined);
    window.__TAURI__ = { core: { invoke } };
    window.__KNOWLIFY__ = { apiBaseUrl: "http://127.0.0.1:4567" };
    render(<UpdateBanner api={apiWith(INFO)} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Download the new installer from the release page.");
    expect(status).not.toHaveTextContent("Update your server");

    fireEvent.click(screen.getByRole("button", { name: "View release" }));
    expect(invoke).toHaveBeenCalledWith("open_external", { url: INFO.latest?.url });
    expect(screen.queryByRole("link", { name: "View release" })).not.toBeInTheDocument();
  });

  it("describes the server, not the binary, on a remote desktop", async () => {
    const invoke = vi.fn(async () => undefined);
    window.__TAURI__ = { core: { invoke } };
    window.__KNOWLIFY__ = { apiBaseUrl: "https://books.example.com" };
    render(<UpdateBanner api={apiWith(INFO)} />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Update your server. If you use Docker, pull the new image.",
    );
    fireEvent.click(screen.getByRole("button", { name: "View release" }));
    expect(invoke).toHaveBeenCalledWith("open_external", { url: INFO.latest?.url });
  });

  it("dismisses this version and keeps it hidden on the next mount", async () => {
    const first = render(<UpdateBanner api={apiWith(INFO)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(localStorage.getItem(UPDATE_DISMISSED_KEY)).toBe("2.5.0");
    first.unmount();

    render(<UpdateBanner api={apiWith(INFO)} />);
    await flush();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides as soon as the card turns checks off", async () => {
    let current = INFO;
    const api: ApiFn = async (path, init) => {
      if (path === "/api/settings/update" && init?.method === "PUT") {
        current = { ...current, enabled: false, latest: null, available: false, checkedAt: null };
        return json({ enabled: false, locked: false, source: "db" });
      }
      return json(current);
    };
    const view = render(
      <>
        <UpdateBanner api={api} />
        <UpdateCard api={api} />
      </>,
    );

    expect(await screen.findByText(/Knowlify 2.5.0 is available/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("switch", { name: "Check for new versions" }));
    await waitFor(() => expect(view.container.querySelector(".update-banner")).toBeNull());
  });

  it("reappears only for a release newer than the dismissed one", async () => {    localStorage.setItem(UPDATE_DISMISSED_KEY, "2.4.9");
    render(<UpdateBanner api={apiWith(INFO)} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Knowlify 2.5.0 is available.");

    localStorage.setItem(UPDATE_DISMISSED_KEY, "2.5.1");
    const hidden = render(<UpdateBanner api={apiWith(INFO)} />);
    await flush();
    expect(hidden.container).toBeEmptyDOMElement();

    localStorage.setItem(UPDATE_DISMISSED_KEY, "not-a-version");
    render(<UpdateBanner api={apiWith(INFO)} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Knowlify 2.5.0 is available.");
  });

  it.each([
    ["checks are off", { ...INFO, enabled: false }],
    ["no current check", { ...INFO, latest: null, available: false, checkedAt: null }],
    ["already current", { ...INFO, available: false, latest: { ...INFO.latest!, version: "2.4.0" } }],
    ["cannot manage", { ...INFO, canManage: false }],
  ] satisfies Array<[string, UpdateInfo]>)("renders nothing when %s", async (_name, info) => {
    const { container } = render(<UpdateBanner api={apiWith(info)} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an old server, a failed read or an unusable URL", async () => {
    const missing = render(<UpdateBanner api={apiWith(null, 404)} />);
    await flush();
    expect(missing.container).toBeEmptyDOMElement();
    missing.unmount();

    const failed = render(
      <UpdateBanner
        api={async () => {
          throw new Error("Could not reach the server.");
        }}
      />,
    );
    await flush();
    expect(failed.container).toBeEmptyDOMElement();
    failed.unmount();

    render(
      <UpdateBanner
        api={apiWith({
          ...INFO,
          latest: { version: "2.5.0", url: "http://github.com/Victor-Mazzei/Knowlify" },
        })}
      />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Knowlify 2.5.0 is available.");
    expect(screen.queryByRole("link", { name: "View release" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
