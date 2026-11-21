import { describe, expect, it } from "vitest";
import {
  classify,
  isValidCidr,
  matchesCidr,
  parseAllowPrivate,
} from "../src/domain/net/IpClassification.js";
import { evaluateDestination, evaluateResolvedDestination } from "../src/domain/assistant/LlmConfig.js";

describe("IP classification", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.51.100.1", "reserved"],
    ["203.0.113.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "reserved"],
    ["fe80::1", "link-local"],
    ["fd00::1", "private"],
    ["fc00::1", "private"],
    ["ff02::1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["2001::1", "reserved"],
    ["2002:808:808::1", "reserved"],
    ["3fff::1", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
  ] as const)("classifies %s as %s", (address, expected) => {
    expect(classify(address)).toBe(expected);
  });

  it("unwraps IPv4-mapped IPv6 before classifying", () => {
    expect(classify("::ffff:127.0.0.1")).toBe("loopback");
    expect(classify("::ffff:10.0.0.1")).toBe("private");
    expect(classify("::ffff:8.8.8.8")).toBe("public");
    expect(classify("not-an-ip")).toBeNull();
  });

  it("matches CIDRs for both families and rejects mismatched families", () => {
    expect(matchesCidr("192.168.1.5", "192.168.1.0/24")).toBe(true);
    expect(matchesCidr("192.168.2.5", "192.168.1.0/24")).toBe(false);
    expect(matchesCidr("100.64.0.1", "100.64.0.0/10")).toBe(true);
    expect(matchesCidr("::ffff:192.168.1.5", "192.168.1.0/24")).toBe(true);
    expect(matchesCidr("fc00::1", "fc00::/7")).toBe(true);
    expect(matchesCidr("fd12::1", "fc00::/7")).toBe(true);
    expect(matchesCidr("fe80::1", "fc00::/7")).toBe(false);
    expect(matchesCidr("192.168.1.5", "fc00::/7")).toBe(false);
    expect(matchesCidr("192.168.1.5", "x")).toBe(false);
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
    expect(isValidCidr("10.0.0.0/not-a-prefix")).toBe(false);
  });

  it("parses the allow-private policy with a safe fallback", () => {
    expect(parseAllowPrivate(undefined)).toEqual({ policy: { mode: "off" }, valid: true });
    expect(parseAllowPrivate("off")).toEqual({ policy: { mode: "off" }, valid: true });
    expect(parseAllowPrivate("on")).toEqual({ policy: { mode: "on" }, valid: true });
    expect(parseAllowPrivate("127.0.0.1/32, 192.168.1.0/24")).toEqual({
      policy: { mode: "list", cidrs: ["127.0.0.1/32", "192.168.1.0/24"] },
      valid: true,
    });
    expect(parseAllowPrivate("not-a-cidr")).toEqual({ policy: { mode: "off" }, valid: false });
  });
});

describe("LLM destination policy", () => {
  const httpUrl = new URL("http://api.example.com/v1");
  const httpsUrl = new URL("https://api.example.com/v1");
  const httpsAltPort = new URL("https://api.example.com:8443/v1");

  it("requires HTTPS on port 443 for public destinations", () => {
    expect(evaluateDestination(httpUrl, "8.8.8.8", { mode: "off" })).toBe("https_required");
    expect(evaluateDestination(httpUrl, "8.8.8.8", { mode: "on" })).toBe("https_required");
    expect(evaluateDestination(httpsUrl, "8.8.8.8", { mode: "off" })).toBe("ok");
    expect(evaluateDestination(httpsAltPort, "8.8.8.8", { mode: "off" })).toBe("https_required");
  });

  it("blocks loopback/private by default and allows them with `on`", () => {
    expect(evaluateDestination(httpUrl, "127.0.0.1", { mode: "off" })).toBe("blocked");
    expect(evaluateDestination(httpUrl, "10.0.0.2", { mode: "off" })).toBe("blocked");
    expect(evaluateDestination(httpUrl, "127.0.0.1", { mode: "on" })).toBe("ok");
    expect(evaluateDestination(httpUrl, "10.0.0.2", { mode: "on" })).toBe("ok");
    expect(evaluateDestination(httpUrl, "100.64.0.1", { mode: "on" })).toBe("ok");
  });

  it("never allows link-local or reserved addresses with `on`", () => {
    expect(evaluateDestination(httpUrl, "169.254.169.254", { mode: "on" })).toBe("blocked");
    expect(evaluateDestination(httpUrl, "fe80::1", { mode: "on" })).toBe("blocked");
    expect(evaluateDestination(httpUrl, "8.8.8.8", { mode: "list", cidrs: ["127.0.0.0/8"] })).toBe("blocked");
    expect(evaluateDestination(httpUrl, "169.254.169.254", { mode: "list", cidrs: ["169.254.0.0/16"] })).toBe("ok");
  });

  it("rejects a destination when any resolved address is forbidden", () => {
    expect(evaluateResolvedDestination(httpsUrl, ["8.8.8.8", "10.0.0.1"], { mode: "off" })).toBe("blocked");
    expect(evaluateResolvedDestination(httpsUrl, ["8.8.8.8"], { mode: "off" })).toBe("ok");
    expect(evaluateResolvedDestination(httpUrl, ["10.0.0.1"], { mode: "on" })).toBe("ok");
    expect(evaluateResolvedDestination(httpsUrl, [], { mode: "off" })).toBe("ok");
  });
});
