import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasDesktopInvoke,
  isShareStatus,
  reconnectApp,
  ShareCommandError,
  shareApi,
  type ShareStatus,
} from "./shareApi";

const status = (overrides: Partial<ShareStatus> = {}): ShareStatus => ({
  available: true,
  enabled: false,
  running: false,
  port: 47870,
  defaultPort: 47870,
  urls: [],
  user: "desktop",
  password: null,
  error: null,
  ...overrides,
});

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function installInvoke(invoke: Invoke) {
  window.__TAURI__ = { core: { invoke } };
}

afterEach(() => {
  delete window.__TAURI__;
  delete window.__KNOWLIFY_RECONNECT__;
  vi.restoreAllMocks();
});

describe("shareApi", () => {
  it("reads and narrows share_status", async () => {
    const invoke = vi.fn(async () => status());
    installInvoke(invoke);

    expect(hasDesktopInvoke()).toBe(true);
    await expect(shareApi.status()).resolves.toEqual(status());
    expect(invoke).toHaveBeenCalledWith("share_status", undefined);
  });

  it("sends set_share with and without a port", async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => status({ enabled: args?.enabled === true }));
    installInvoke(invoke);

    await shareApi.setShare(true);
    expect(invoke).toHaveBeenLastCalledWith("set_share", { enabled: true });

    await shareApi.setShare(true, 50000);
    expect(invoke).toHaveBeenLastCalledWith("set_share", { enabled: true, port: 50000 });

    await shareApi.setShare(false);
    expect(invoke).toHaveBeenLastCalledWith("set_share", { enabled: false });
  });

  it("rotates the share password", async () => {
    const invoke = vi.fn(async () => status({ enabled: true, running: true, password: "ABCDEFGHIJKLMNOP" }));
    installInvoke(invoke);

    await expect(shareApi.rotatePassword()).resolves.toMatchObject({ password: "ABCDEFGHIJKLMNOP" });
    expect(invoke).toHaveBeenCalledWith("rotate_share_password", undefined);
  });

  it("rejects an unexpected status shape instead of trusting it", async () => {
    installInvoke(async () => ({ ...status(), port: "47870" }));

    await expect(shareApi.status()).rejects.toBeInstanceOf(ShareCommandError);
    expect(isShareStatus({ ...status(), urls: [1] })).toBe(false);
    expect(isShareStatus({ ...status(), error: { code: "other", message: "x" } })).toBe(false);
    expect(isShareStatus({ ...status(), password: 42 })).toBe(false);
  });

  it("maps a rejected command to its error code", async () => {
    installInvoke(async () => {
      throw new Error("port_in_use: 47870");
    });

    const error = await shareApi.setShare(true).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ShareCommandError);
    expect((error as ShareCommandError).code).toBe("port_in_use");

    installInvoke(async () => {
      throw new Error("not_local");
    });
    await expect(shareApi.rotatePassword()).rejects.toMatchObject({ code: "not_local" });
  });

  it("reports not_local when the desktop bridge is absent", async () => {
    expect(hasDesktopInvoke()).toBe(false);
    await expect(shareApi.status()).rejects.toMatchObject({ code: "not_local" });
  });

  it("calls the reconnect helper and tolerates its absence", () => {
    const reconnect = vi.fn();
    window.__KNOWLIFY_RECONNECT__ = reconnect;
    reconnectApp();
    expect(reconnect).toHaveBeenCalledTimes(1);

    window.__KNOWLIFY_RECONNECT__ = () => {
      throw new Error("reload blocked");
    };
    expect(() => reconnectApp()).not.toThrow();
  });
});
