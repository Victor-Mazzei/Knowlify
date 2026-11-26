import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePairingFragment } from "../modules/settings/share/pairing";
import {
  ApiError,
  STORAGE_KEY,
  basicAuth,
  changePassword,
  clearCredentials,
  formatError,
  isLocalOnlyError,
  LOCAL_ONLY_MESSAGE,
  parseApiError,
  readCredentials,
  useApi,
  verifyCredentials,
} from "./api";

const decodeBasic = (header: string) => {
  const bytes = Uint8Array.from(atob(header.slice("Basic ".length)), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.__KNOWLIFY__;
  window.history.replaceState(null, "", "/");
});

describe("readCredentials", () => {
  it("reads a valid stored shape", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: "reader", pass: "secret" }));
    expect(readCredentials()).toEqual({ user: "reader", pass: "secret" });
  });

  it("rejects valid JSON with the wrong shape and removes it", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: "reader" }));
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rejects JSON null and removes it", () => {
    localStorage.setItem(STORAGE_KEY, "null");
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rejects wrong value types and removes the item", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: 42, pass: "secret" }));
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rejects credentials beyond the accepted length and removes them", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: "u".repeat(201), pass: "secret" }));
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: "reader", pass: "p".repeat(1001) }));
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rejects unreadable JSON and removes it", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readCredentials()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("uses the credentials from a share QR link once and removes the fragment", () => {
    const credentials = { user: "desktop", pass: "ABCDEFGHIJKLMNOP" };
    window.location.hash = encodePairingFragment(credentials);

    expect(readCredentials()).toEqual(credentials);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(credentials));
    expect(window.location.hash).toBe("");
    expect(readCredentials()).toEqual(credentials);
  });

  it("ignores a malformed share link and keeps the stored credentials", () => {
    window.location.hash = "#pair=not-valid";
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: "reader", pass: "secret" }));

    expect(readCredentials()).toEqual({ user: "reader", pass: "secret" });
  });
});

describe("basicAuth", () => {
  it("encodes the credentials as UTF-8 bytes", () => {
    expect(decodeBasic(basicAuth({ user: "reader", pass: "pässwörd" }))).toBe("reader:pässwörd");
  });

  it("sends the encoded header", async () => {
    let authorization = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response("[]");
      }),
    );
    await verifyCredentials({ user: "reader", pass: "pässwörd" });
    expect(decodeBasic(authorization)).toBe("reader:pässwörd");
  });
});

describe("parseApiError", () => {
  it("keeps the code and every detail field the UI reads", async () => {
    const error = await parseApiError(
      new Response(
        JSON.stringify({ message: "The selection changed", code: "selection_changed", removed: 1, total: 3 }),
        { status: 409 },
      ),
    );
    expect(error).toMatchObject({
      status: 409,
      message: "The selection changed",
      code: "selection_changed",
      details: { removed: 1, total: 3 },
    });
  });

  it("uses a plain-text body as the message", async () => {
    const error = await parseApiError(new Response("upstream unavailable", { status: 503 }));
    expect(error).toMatchObject({ status: 503, message: "upstream unavailable" });
  });
});

describe("useApi", () => {
  it("throws an ApiError carrying the server code and details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "Partial", code: "selection_changed", removed: 1 }), { status: 409 }),
      ),
    );
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useApi({ user: "reader", pass: "secret" }, onUnauthorized));
    await expect(result.current("/api/books/delete")).rejects.toMatchObject({
      status: 409,
      message: "Partial",
      code: "selection_changed",
      details: { removed: 1 },
    });
  });

  it("does not sign out on a local-only 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Forbidden", code: "local_only" }), { status: 403 })),
    );
    const onUnauthorized = vi.fn();
    const { result } = renderHook(() => useApi({ user: "reader", pass: "secret" }, onUnauthorized));

    await expect(result.current("/api/settings/chat", { method: "PUT" })).rejects.toMatchObject({
      status: 403,
      code: "local_only",
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("local-only 403", () => {
  it("explains the desktop-only action and leaves other 403s alone", () => {
    expect(formatError(new ApiError(403, "Forbidden", "local_only"))).toBe(LOCAL_ONLY_MESSAGE);
    expect(formatError(new ApiError(403, "Forbidden"))).toBe("Forbidden");
    expect(formatError(new ApiError(403, "Forbidden", "other"))).toBe("Forbidden");
  });

  it("narrows only a 403 carrying the local_only code", () => {
    expect(isLocalOnlyError(new ApiError(403, "Forbidden", "local_only"))).toBe(true);
    expect(isLocalOnlyError(new ApiError(403, "Forbidden"))).toBe(false);
    expect(isLocalOnlyError(new ApiError(401, "Forbidden", "local_only"))).toBe(false);
    expect(isLocalOnlyError(new Error("local_only"))).toBe(false);
  });

  it("keeps the code on the account route and does not sign out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Forbidden", code: "local_only" }), { status: 403 })),
    );
    const onUnauthorized = vi.fn();
    const error = await changePassword(
      { user: "reader", pass: "secret" },
      { current: "old", next: "next-password" },
      onUnauthorized,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "local_only" });
    expect(formatError(error)).toBe(LOCAL_ONLY_MESSAGE);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("formatError", () => {
  it("uses Error messages", () => expect(formatError(new Error("nope"))).toBe("nope"));
  it("falls back for unknown values", () => expect(formatError(null)).toContain("Something went wrong"));
});

describe("session expiry", () => {
  it("still completes sign-out when storage is blocked", () => {
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => clearCredentials()).not.toThrow();
    removeItem.mockRestore();
  });
});

describe("verifyCredentials", () => {
  it("accepts valid credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    await expect(verifyCredentials({ user: "reader", pass: "secret" })).resolves.toBeUndefined();
  });

  it("probes a single id instead of downloading the library", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ message: "Not found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyCredentials({ user: "reader", pass: "secret" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/books/__auth-check__"), expect.anything());
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/books"))).toBe(false);
  });

  it("rejects a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(verifyCredentials({ user: "reader", pass: "wrong" })).rejects.toThrow("Incorrect username or password.");
  });

  it("rejects a server failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(verifyCredentials({ user: "reader", pass: "secret" })).rejects.toThrow("Could not open library (503).");
  });
});
