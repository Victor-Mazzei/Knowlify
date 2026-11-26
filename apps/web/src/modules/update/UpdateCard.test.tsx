import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, LOCAL_ONLY_MESSAGE } from "../../services/api";
import { UpdateCard } from "./UpdateCard";
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

const apiWith = (info: UpdateInfo | null, status = 200): ApiFn => async () =>
  info ? json(info) : new Response("{}", { status });

const switchControl = () => screen.getByRole("switch", { name: "Check for new versions" });
const checkButton = () => screen.getByRole("button", { name: "Check now" });

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("UpdateCard", () => {
  it("shows an available release, its UTC check time and the opt-out", async () => {
    const { container } = render(<UpdateCard api={apiWith(INFO)} />);

    expect(await screen.findByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByText("Version 2.5.0 is available")).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toHaveTextContent(
      "Last checked: 2026-11-25 12:00 UTC",
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-11-25T12:00:00.000Z",
    );

    const toggle = switchControl();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAttribute("aria-labelledby", "update-check-label");
    expect(toggle).toHaveAttribute("aria-describedby", "update-privacy");
    expect(screen.getByText("Check for new versions")).toHaveAttribute("id", "update-check-label");
    expect(screen.getByText(/asks GitHub for the latest release about once a day/)).toHaveAttribute(
      "id",
      "update-privacy",
    );
    expect(checkButton()).toBeEnabled();
  });

  it.each([
    [
      "off",
      { ...INFO, enabled: false, latest: null, available: false, checkedAt: null },
      "Update checks are off",
      false,
    ],
    [
      "not checked",
      { ...INFO, latest: null, available: false, checkedAt: null },
      "Not checked yet",
      true,
    ],
    [
      "current",
      {
        ...INFO,
        latest: { ...INFO.latest!, version: "2.4.0" },
        available: false,
      },
      "Up to date",
      true,
    ],
  ] satisfies Array<[string, UpdateInfo, string, boolean]>)(
    "reports %s",
    async (_name, info, label, checkEnabled) => {
      render(<UpdateCard api={apiWith(info)} />);

      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(checkButton()).toHaveProperty("disabled", !checkEnabled);
      expect(switchControl()).toHaveAttribute("aria-checked", String(info.enabled));
    },
  );

  it("uses the off privacy copy when checks are off", async () => {
    const info = { ...INFO, enabled: false, latest: null, available: false, checkedAt: null };
    render(<UpdateCard api={apiWith(info)} />);

    await screen.findByText("Update checks are off");
    expect(screen.getByText("Update checks are off. Knowlify does not contact GitHub.")).toHaveAttribute(
      "id",
      "update-privacy",
    );
    expect(screen.queryByText(/Last checked:/)).not.toBeInTheDocument();
  });

  it("mounts nothing for an old server or a failed read", async () => {
    const missing = render(<UpdateCard api={apiWith(null, 404)} />);
    await waitFor(() => expect(missing.container).toBeEmptyDOMElement());
    missing.unmount();

    const failed = render(
      <UpdateCard
        api={async () => {
          throw new Error("Could not reach the server.");
        }}
      />,
    );
    await waitFor(() => expect(failed.container).toBeEmptyDOMElement());
    expect(screen.queryByText(/Could not check/)).not.toBeInTheDocument();
  });

  it("reports the result of Check now in a status", async () => {
    const api: ApiFn = async (_path, init) =>
      init?.method === "POST"
        ? json({ ...INFO, checkedAt: "2026-11-25T13:00:00.000Z" })
        : json(INFO);
    render(<UpdateCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    expect(await screen.findByText("Checked just now.")).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toHaveTextContent(
      "Last checked: 2026-11-25 13:00 UTC",
    );
    expect(screen.getByText("Checked just now.")).toHaveAttribute("role", "status");
  });

  it("keeps the normal state when the server returns its cache inside the cooldown", async () => {
    const unchanged: ApiFn = async (_path, init) =>
      init?.method === "POST" ? json(INFO) : json(INFO);
    render(<UpdateCard api={unchanged} />);

    expect(await screen.findByText("Version 2.5.0 is available")).toBeInTheDocument();
    fireEvent.click(checkButton());

    const neutral = await screen.findByText("Checked a moment ago.");
    expect(neutral).toHaveAttribute("role", "status");
    expect(screen.queryByText("Could not check just now.")).not.toBeInTheDocument();
    expect(screen.getByText("Version 2.5.0 is available")).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toHaveTextContent(
      "Last checked: 2026-11-25 12:00 UTC",
    );
  });

  it.each([
    [
      "network",
      (async (_path: string, init?: RequestInit) => {
        if (init?.method === "POST") throw new Error("Could not reach the server.");
        return json(INFO);
      }) as ApiFn,
    ],
    [
      "500",
      (async (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ message: "boom" }, 500) : json(INFO)) as ApiFn,
    ],
    [
      "429",
      (async (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ message: "slow down" }, 429) : json(INFO)) as ApiFn,
    ],
    [
      "invalid body",
      (async (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ available: true }) : json(INFO)) as ApiFn,
    ],
  ])("reports a real %s failure", async (_name, api) => {
    render(<UpdateCard api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    expect(await screen.findByText("Could not check just now.")).toBeInTheDocument();
    expect(screen.queryByText("Checked a moment ago.")).not.toBeInTheDocument();
  });

  it("keeps the local-only message when Check now is rejected there", async () => {
    const api: ApiFn = async (_path, init) => {
      if (init?.method === "POST") throw new ApiError(403, "Forbidden", "local_only");
      return json(INFO);
    };
    render(<UpdateCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    expect(await screen.findByText(LOCAL_ONLY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("Could not check just now.")).not.toBeInTheDocument();
  });

  it("locks the switch for the server administrator", async () => {
    const api = vi.fn(apiWith({ ...INFO, locked: true }));
    render(<UpdateCard api={api} />);

    await screen.findByRole("heading", { name: "Updates" });
    expect(switchControl()).toBeDisabled();
    expect(switchControl()).toHaveAttribute(
      "aria-describedby",
      "update-privacy update-managed-note",
    );
    expect(screen.getByText("Set by the server administrator.")).toHaveAttribute(
      "id",
      "update-managed-note",
    );
    fireEvent.click(switchControl());
    expect(api).not.toHaveBeenCalledWith("/api/settings/update", expect.objectContaining({ method: "PUT" }));
  });

  it("keeps the switch read-only on a remote peer", async () => {
    render(<UpdateCard api={apiWith({ ...INFO, canManage: false })} />);

    await screen.findByRole("heading", { name: "Updates" });
    expect(switchControl()).toBeDisabled();
    expect(
      screen.getByText("Only available on the computer that runs Knowlify."),
    ).toBeInTheDocument();
    expect(checkButton()).toBeEnabled();
  });

  it("saves the opt-out and refreshes the card", async () => {
    let current = INFO;
    const bodies: unknown[] = [];
    const api: ApiFn = async (path, init) => {
      if (path === "/api/settings/update" && init?.method === "PUT") {
        const body: unknown = JSON.parse(String(init.body));
        bodies.push(body);
        const enabled = (body as { enabled: boolean }).enabled;
        current = {
          ...current,
          enabled,
          latest: enabled ? current.latest : null,
          available: enabled ? current.available : false,
          checkedAt: enabled ? current.checkedAt : null,
        };
        return json({ enabled, locked: false, source: "db" });
      }
      return json(current);
    };

    render(<UpdateCard api={api} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Check for new versions" }));

    expect(await screen.findByText("Update checks are off")).toBeInTheDocument();
    expect(bodies).toEqual([{ enabled: false }]);
    expect(switchControl()).toHaveAttribute("aria-checked", "false");
    expect(checkButton()).toBeDisabled();
    expect(screen.getByText(/does not contact GitHub/)).toBeInTheDocument();
  });

  it("explains a local-only rejection on the switch", async () => {
    const api: ApiFn = async (_path, init) => {
      if (init?.method === "PUT") throw new ApiError(403, "Forbidden", "local_only");
      return json(INFO);
    };
    render(<UpdateCard api={api} />);

    fireEvent.click(await screen.findByRole("switch", { name: "Check for new versions" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(LOCAL_ONLY_MESSAGE);
    expect(switchControl()).toHaveAttribute("aria-checked", "true");
  });
});
