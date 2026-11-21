import { afterEach, describe, expect, it, vi } from "vitest";
import { pickFolder } from "./desktop";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function localDesktop(invoke: Invoke) {
  window.__KNOWLIFY__ = { apiBaseUrl: "http://127.0.0.1:4567" };
  window.__TAURI__ = { core: { invoke } };
}

afterEach(() => {
  delete window.__TAURI__;
  delete window.__KNOWLIFY__;
});

describe("pickFolder", () => {
  it("returns unavailable in a browser", async () => {
    expect(await pickFolder()).toEqual({ status: "unavailable" });
  });

  it("opens the native dialog through the dialog plugin command", async () => {
    const invoke = vi.fn(async () => "/books");
    localDesktop(invoke);
    expect(await pickFolder()).toEqual({ status: "selected", path: "/books" });
    expect(invoke).toHaveBeenCalledWith("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "Choose a library folder" },
    });
  });

  it("treats a cancelled dialog as cancelled", async () => {
    localDesktop(async () => null);
    expect(await pickFolder()).toEqual({ status: "cancelled" });
  });

  it("does not open the dialog for a remote server", async () => {
    window.__KNOWLIFY__ = { apiBaseUrl: "https://books.example.com" };
    const invoke = vi.fn(async () => "/books");
    window.__TAURI__ = { core: { invoke } };
    expect(await pickFolder()).toEqual({ status: "unavailable" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back when the native dialog fails", async () => {
    localDesktop(async () => {
      throw new Error("dialog plugin missing");
    });
    expect(await pickFolder()).toEqual({ status: "unavailable" });
  });
});
