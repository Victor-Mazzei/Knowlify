import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumePairingFragment,
  decodePairingFragment,
  encodePairingFragment,
  formatSharePassword,
  pairingUrl,
} from "./pairing";

const base64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("pairing fragment", () => {
  it("uses the frozen #pair=<base64url> format without padding", () => {
    expect(encodePairingFragment({ user: "desktop", pass: "abcd" })).toBe(`#pair=${base64url("desktop:abcd")}`);
    const fragment = encodePairingFragment({ user: "desktop", pass: "A1B2-C3D4-E5F6-G7H8" });
    expect(fragment).toMatch(/^#pair=[A-Za-z0-9_-]+$/);
    const encoded = fragment.slice("#pair=".length);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("+");
  });

  it("round-trips ASCII and UTF-8 credentials", () => {
    const ascii = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    expect(decodePairingFragment(encodePairingFragment(ascii))).toEqual(ascii);

    const unicode = { user: "usuário", pass: "pässwörd-é" };
    expect(decodePairingFragment(encodePairingFragment(unicode))).toEqual(unicode);
  });

  it("ignores malformed fragments", () => {
    for (const fragment of [
      "",
      "#pair",
      "#pair=",
      "#pair=%%%%",
      "#pair=a===",
      "#pair=ZGVza3RvcA", // "desktop", no separator
      "#pair=OmFiYw", // ":abc", empty user
      "#pair=YWJjOg", // "abc:", empty password
      "#pair=_w", // invalid UTF-8 byte 0xff
      `#pair=${"A".repeat(2049)}`,
      "#other=ZGVza3RvcDphYmNk",
    ]) {
      expect(decodePairingFragment(fragment), fragment).toBeNull();
    }
  });

  it("rejects credentials longer than the server accepts", () => {
    const longUser = { user: "u".repeat(201), pass: "secret" };
    const longPass = { user: "desktop", pass: "p".repeat(1001) };
    expect(decodePairingFragment(encodePairingFragment(longUser))).toBeNull();
    expect(decodePairingFragment(encodePairingFragment(longPass))).toBeNull();
  });

  it("builds a sign-in URL without duplicating the slash", () => {
    const credentials = { user: "desktop", pass: "abcd" };
    const expected = `http://10.0.0.5:47870/${encodePairingFragment(credentials)}`;
    expect(pairingUrl("http://10.0.0.5:47870", credentials)).toBe(expected);
    expect(pairingUrl("http://10.0.0.5:47870/", credentials)).toBe(expected);
  });

  it("formats the password in groups of four without changing the value", () => {
    expect(formatSharePassword("ABCDEFGHIJKLMNOP")).toBe("ABCD-EFGH-IJKL-MNOP");
    expect(formatSharePassword("ABCDE")).toBe("ABCD-E");
    expect(formatSharePassword("")).toBe("");
  });
});

describe("consumePairingFragment", () => {
  it("persists the credentials and removes the fragment from the address bar", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    window.location.hash = encodePairingFragment(credentials);
    const persist = vi.fn();
    const replace = vi.spyOn(window.history, "replaceState");

    expect(consumePairingFragment(persist)).toEqual(credentials);
    expect(persist).toHaveBeenCalledWith(credentials);
    expect(replace).toHaveBeenCalledWith(null, "", window.location.pathname);
    expect(window.location.hash).toBe("");
  });

  it("ignores an invalid fragment and leaves it alone", () => {
    window.location.hash = "#pair=not-valid";
    const persist = vi.fn();
    const replace = vi.spyOn(window.history, "replaceState");

    expect(consumePairingFragment(persist)).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps working when storage is blocked", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    window.location.hash = encodePairingFragment(credentials);

    expect(
      consumePairingFragment(() => {
        throw new Error("storage blocked");
      }),
    ).toEqual(credentials);
    expect(window.location.hash).toBe("");
  });

  it("clears the fragment with the hash setter when replaceState throws", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    window.location.hash = encodePairingFragment(credentials);
    const persist = vi.fn();
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history blocked");
    });

    expect(consumePairingFragment(persist)).toEqual(credentials);
    expect(persist).toHaveBeenCalledWith(credentials);
    expect(window.location.hash).toBe("");
  });

  it("removes the fragment before persisting and falls back to the hash setter", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    const location = { pathname: "/", search: "", hash: encodePairingFragment(credentials) };
    const events: string[] = [];
    const replace = vi.fn(() => {
      events.push("replace");
      location.hash = "";
    });
    const persist = vi.fn(() => events.push("persist"));

    expect(consumePairingFragment(persist, location, replace)).toEqual(credentials);
    expect(replace).toHaveBeenCalledWith("/");
    expect(events).toEqual(["replace", "persist"]);
    expect(location.hash).toBe("");
  });

  it("does not persist the secret when the fragment cannot be removed", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    const fragment = encodePairingFragment(credentials);
    const location = { pathname: "/", search: "", hash: fragment };
    Object.defineProperty(location, "hash", {
      configurable: true,
      get: () => fragment,
      set: () => undefined,
    });
    const persist = vi.fn();
    const replace = vi.fn();

    expect(consumePairingFragment(persist, location, replace)).toBeNull();
    expect(replace).toHaveBeenCalledWith("/");
    expect(persist).not.toHaveBeenCalled();
    expect(location.hash).toBe(fragment);
  });

  it("never writes the password to the console", () => {
    const credentials = { user: "desktop", pass: "SECRET-SHARE-PASS" };
    window.location.hash = encodePairingFragment(credentials);
    const spies = ["log", "info", "warn", "error", "debug"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => undefined),
    );

    consumePairingFragment(() => undefined);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
