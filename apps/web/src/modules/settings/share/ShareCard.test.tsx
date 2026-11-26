import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareCard } from "./ShareCard";
import type { ShareStatus } from "./shareApi";

const OFF: ShareStatus = {
  available: true,
  enabled: false,
  running: false,
  port: 47870,
  defaultPort: 47870,
  urls: [],
  user: "desktop",
  password: null,
  error: null,
};

const ON: ShareStatus = {
  available: true,
  enabled: true,
  running: true,
  port: 47870,
  defaultPort: 47870,
  urls: ["http://10.0.0.5:47870"],
  user: "desktop",
  password: "ABCDEFGHIJKLMNOP",
  error: null,
};

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let reconnect = vi.fn<() => void>();

function installInvoke(invoke: Invoke) {
  window.__TAURI__ = { core: { invoke } };
}

beforeEach(() => {
  reconnect = vi.fn();
  window.__KNOWLIFY_RECONNECT__ = reconnect;
  installInvoke(async () => OFF);
});

afterEach(() => {
  delete window.__TAURI__;
  delete window.__KNOWLIFY_RECONNECT__;
  vi.restoreAllMocks();
});

const switchControl = () => screen.getByRole("switch", { name: "Share on my network" });

describe("ShareCard", () => {
  it("starts off with the fixed warning, the Tailscale tip and the firewall help", async () => {
    render(<ShareCard />);

    await screen.findByRole("heading", { name: "Share on my network" });
    expect(switchControl()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Anyone on this network who has the password can read and change your library/)).toBeInTheDocument();
    expect(screen.getByText(/Traffic is not encrypted \(HTTP\)/)).toBeInTheDocument();
    expect(screen.getByText(/use Tailscale on both devices/)).toBeInTheDocument();
    expect(screen.getByText("Can't connect from your phone?")).toBeInTheDocument();
    expect(screen.getByText(/Defender prompt/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "QR code with the sign-in link" })).not.toBeInTheDocument();
    expect(screen.queryByText("http://10.0.0.5:47870")).not.toBeInTheDocument();
  });

  it("asks for confirmation before turning on, then shows the address, QR and hidden password", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "share_status") return OFF;
      if (command === "set_share") return args?.enabled === true ? ON : OFF;
      throw new Error(`unexpected command: ${command}`);
    });
    installInvoke(invoke);
    render(<ShareCard />);
    await screen.findByRole("heading", { name: "Share on my network" });

    fireEvent.click(switchControl());
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on sharing?" });
    expect(within(dialog).getByText(/The local server restarts/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on sharing" }));

    await screen.findByRole("img", { name: "QR code with the sign-in link" });
    expect(switchControl()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("http://10.0.0.5:47870")).toBeInTheDocument();
    expect(screen.getByText("desktop")).toBeInTheDocument();
    expect(screen.getByText("••••-••••-••••-••••")).toBeInTheDocument();
    expect(screen.queryByText("ABCD-EFGH-IJKL-MNOP")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("set_share", { enabled: true });
    expect(reconnect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument();
    expect(screen.queryByText("••••-••••-••••-••••")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.queryByText("ABCD-EFGH-IJKL-MNOP")).not.toBeInTheDocument();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy password" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCDEFGHIJKLMNOP"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("turns off without a confirmation and reconnects", async () => {
    const invoke = vi.fn(async (command: string) => (command === "share_status" ? ON : OFF));
    installInvoke(invoke);
    render(<ShareCard />);
    await screen.findByRole("img", { name: "QR code with the sign-in link" });

    fireEvent.click(switchControl());

    await waitFor(() => expect(switchControl()).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("set_share", { enabled: false });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the switch off when the confirmation is cancelled", async () => {
    const invoke = vi.fn(async () => OFF);
    installInvoke(invoke);
    render(<ShareCard />);
    await screen.findByRole("heading", { name: "Share on my network" });

    fireEvent.click(switchControl());
    const dialog = await screen.findByRole("alertdialog", { name: "Turn on sharing?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(switchControl()).toHaveAttribute("aria-checked", "false");
    expect(invoke).not.toHaveBeenCalledWith("set_share", expect.anything());
  });

  it("changes the port in Advanced after validating it", async () => {
    const invoke = vi.fn(async (command: string) => (command === "share_status" ? ON : ON));
    installInvoke(invoke);
    render(<ShareCard />);
    await screen.findByRole("img", { name: "QR code with the sign-in link" });

    fireEvent.click(screen.getByText("Advanced"));
    const input = screen.getByLabelText("Port");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save port" }));
    expect(screen.getByText("Enter a port between 1024 and 65535.")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("set_share", expect.anything());

    fireEvent.change(input, { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save port" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_share", { enabled: true, port: 50000 }));
    expect(reconnect).toHaveBeenCalled();
  });

  it("explains a port in use and offers a retry", async () => {
    const inUse: ShareStatus = {
      ...ON,
      running: false,
      urls: [],
      error: { code: "port_in_use", message: "Address already in use" },
    };
    installInvoke(async () => inUse);
    render(<ShareCard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Port 47870 is in use. Choose another port in Advanced.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows no-network and start-failed errors without dropping the switch", async () => {
    const noNetwork: ShareStatus = {
      ...ON,
      urls: [],
      error: { code: "no_network", message: "No private IPv4 address" },
    };
    installInvoke(async () => noNetwork);
    const { unmount } = render(<ShareCard />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No local network detected.");
    expect(within(alert).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(switchControl()).toHaveAttribute("aria-checked", "true");
    unmount();

    const failed: ShareStatus = {
      ...ON,
      running: false,
      urls: [],
      error: { code: "start_failed", message: "Server exited" },
    };
    installInvoke(async () => failed);
    render(<ShareCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The local server did not start. Try again.");
  });

  it("regenerates the password after a confirmation", async () => {
    const rotated: ShareStatus = { ...ON, password: "ZZZZZZZZZZZZZZZZ" };
    const invoke = vi.fn(async (command: string) => {
      if (command === "share_status") return ON;
      if (command === "rotate_share_password") return rotated;
      return rotated;
    });
    installInvoke(invoke);
    render(<ShareCard />);
    await screen.findByRole("img", { name: "QR code with the sign-in link" });

    fireEvent.click(screen.getByRole("button", { name: "Regenerate password" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Regenerate password?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Regenerate password" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("rotate_share_password", undefined));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("copies the password without the Clipboard API on plain HTTP", async () => {
    installInvoke(async () => ON);
    render(<ShareCard />);
    await screen.findByRole("img", { name: "QR code with the sign-in link" });

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    fireEvent.click(screen.getByRole("button", { name: "Copy password" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("input[readonly]")).toBeNull();
  });

  it("does not claim a copy when the fallback reports failure", async () => {
    installInvoke(async () => ON);
    render(<ShareCard />);
    await screen.findByRole("img", { name: "QR code with the sign-in link" });

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    const address = screen.getByRole("button", { name: "Copy address http://10.0.0.5:47870" });
    fireEvent.click(address);

    expect(await screen.findByText("Copy failed. Select the text and copy it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    expect(screen.getByText("http://10.0.0.5:47870")).toBeInTheDocument();

    Object.defineProperty(document, "execCommand", { value: vi.fn(() => true), configurable: true });
    fireEvent.click(address);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.queryByText("Copy failed. Select the text and copy it.")).not.toBeInTheDocument();
  });

  it("renders nothing when the desktop reports sharing as unavailable", async () => {    const invoke = vi.fn(async () => ({ ...OFF, available: false }));
    installInvoke(invoke);
    render(<ShareCard />);

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Share on my network" })).not.toBeInTheDocument(),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and calls no command outside the desktop shell", async () => {
    delete window.__TAURI__;
    render(<ShareCard />);

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Share on my network" })).not.toBeInTheDocument(),
    );
  });

  it("links the switch to its visible state text", async () => {
    render(<ShareCard />);
    await screen.findByRole("heading", { name: "Share on my network" });

    const describedBy = switchControl().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")).toHaveTextContent("Off");
  });
});
