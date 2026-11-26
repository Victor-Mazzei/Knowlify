import { describe, expect, it } from "vitest";
import {
  isAllowedPeerAddress,
  isLoopbackPeerAddress,
  normalizePeerAddress,
} from "../src/domain/network/PeerAddress.js";
import {
  hostnameFromHostHeader,
  isLocalHostHeader,
  isLocalHostname,
  isLocalOrigin,
} from "../src/domain/network/LocalHost.js";
import { isLoopbackOnlyRoute } from "../src/domain/network/LoopbackOnlyRoutes.js";

describe("peer address classification", () => {
  it("canonicalizes IPv4-mapped addresses and zones for the limiter key", () => {
    expect(normalizePeerAddress("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizePeerAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizePeerAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(normalizePeerAddress("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizePeerAddress(" 127.0.0.1 ")).toBe("127.0.0.1");
    expect(normalizePeerAddress("not-an-ip")).toBeNull();
    expect(normalizePeerAddress("")).toBeNull();
  });

  it("allows loopback, RFC 1918, CGNAT and link-local peers only", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.20",
      "100.64.0.1",
      "100.127.255.254",
      "169.254.10.5",
      "fe80::1",
      "fd00::1",
    ]) {
      expect(isAllowedPeerAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "203.0.113.9",
      "::ffff:8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.0.2.1",
      "0.0.0.0",
      "2001:db8::1",
      "not-an-ip",
      "",
    ]) {
      expect(isAllowedPeerAddress(address), address).toBe(false);
    }
  });

  it("separates loopback from the rest of the local range", () => {
    expect(isLoopbackPeerAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackPeerAddress("::1")).toBe(true);
    expect(isLoopbackPeerAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeerAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackPeerAddress("")).toBe(false);
  });
});

describe("Host and Origin classification", () => {
  it("parses hostname and port, rejecting malformed headers", () => {
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
    expect(hostnameFromHostHeader("LOCALHOST:47870")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:47870")).toBe("[::1]");
    expect(hostnameFromHostHeader("evil.com")).toBe("evil.com");
    expect(hostnameFromHostHeader("localhost:99999")).toBeNull();
    expect(hostnameFromHostHeader("localhost:not-a-port")).toBeNull();
    expect(hostnameFromHostHeader("bad host")).toBeNull();
    expect(hostnameFromHostHeader("http://localhost")).toBeNull();
    expect(hostnameFromHostHeader("")).toBeNull();
  });

  it("accepts localhost, private literals, [::1], .local and single labels", () => {
    for (const host of [
      "localhost",
      "localhost:47870",
      "127.0.0.1:47870",
      "[::1]:47870",
      "192.168.1.20:47870",
      "10.0.0.7",
      "172.16.4.4:47870",
      "100.64.0.1:47870",
      "169.254.1.1",
      "knowlify.local:47870",
      "DESKTOP.LOCAL",
      "desktop",
    ]) {
      expect(isLocalHostHeader(host), host).toBe(true);
    }
  });

  it("rejects public names and public literals even when they resolve privately", () => {
    for (const host of [
      "evil.com",
      "evil.com:47870",
      "8.8.8.8",
      "8.8.8.8:47870",
      "192.0.2.10",
      "evil.local.example.com",
      "localhost.evil.com",
      "",
    ]) {
      expect(isLocalHostHeader(host), host).toBe(false);
    }
    expect(isLocalHostname("[fd00::1]")).toBe(true);
    expect(isLocalHostname("[2001:db8::1]")).toBe(false);
  });

  it("allows the desktop webview, the dev server and the sidecar UI only", () => {
    for (const origin of [
      "tauri://localhost",
      "TAURI://LOCALHOST",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://localhost:5174",
      "http://127.0.0.1:47870",
      "http://192.168.1.20:47870",
      "http://[::1]:47870",
      "http://desktop:47870",
    ]) {
      expect(isLocalOrigin(origin), origin).toBe(true);
    }
    for (const origin of [
      "https://evil.com",
      "https://evil.com:8443",
      "http://localhost.evil.com",
      "http://localhost:5174/path",
      "http://user:pass@localhost:5174",
      "tauri://evil.com",
      "null",
      "file:///tmp/index.html",
      "",
    ]) {
      expect(isLocalOrigin(origin), origin).toBe(false);
    }
  });
});

describe("loopback-only routes", () => {
  it("reserves filesystem, source, settings, token and account surfaces", () => {
    for (const [method, url] of [
      ["GET", "/api/fs"],
      ["GET", "/api/fs?path=%2F"],
      ["POST", "/api/fs"],
      ["POST", "/api/sources"],
      ["DELETE", "/api/sources/abc"],
      ["PUT", "/api/sources"],
      ["PUT", "/api/settings/llm"],
      ["PATCH", "/api/settings/metadata"],
      ["POST", "/api/settings/chat"],
      ["GET", "/api/mcp/tokens"],
      ["POST", "/api/mcp/tokens"],
      ["DELETE", "/api/mcp/tokens/abc"],
      ["GET", "/api/account"],
      ["PUT", "/api/account/password"],
    ] as const) {
      expect(isLoopbackOnlyRoute(method, url), `${method} ${url}`).toBe(true);
    }
  });

  it("keeps reads and the rest of the library available to the phone", () => {
    for (const [method, url] of [
      ["GET", "/api/sources"],
      ["GET", "/api/settings/llm"],
      ["GET", "/api/settings/metadata?x=1"],
      ["GET", "/api/books?limit=20"],
      ["POST", "/api/books"],
      ["POST", "/api/scan"],
      ["GET", "/health"],
      ["GET", "/opds"],
      ["GET", "/"],
      ["GET", "/library"],
    ] as const) {
      expect(isLoopbackOnlyRoute(method, url), `${method} ${url}`).toBe(false);
    }
  });
});
