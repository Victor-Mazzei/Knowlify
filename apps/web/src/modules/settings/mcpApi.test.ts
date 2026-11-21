import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../services/api";
import { endpointUrl, isMcpDisabled, isMcpUnavailable } from "./mcpApi";

afterEach(() => {
  delete window.__KNOWLIFY__;
});

describe("endpointUrl", () => {
  it("uses the current origin and the server path", () => {
    expect(endpointUrl()).toBe(`${window.location.origin}/mcp`);
    expect(endpointUrl("mcp")).toBe(`${window.location.origin}/mcp`);
  });

  it("uses the injected desktop API base and trims trailing slashes", () => {
    window.__KNOWLIFY__ = { apiBaseUrl: "https://books.example.com/" };
    expect(endpointUrl()).toBe("https://books.example.com/mcp");
  });
});

describe("MCP error classification", () => {
  it("distinguishes a disabled server from one that predates the route", () => {
    expect(isMcpDisabled(new ApiError(404, "disabled", "mcp_disabled"))).toBe(true);
    expect(isMcpUnavailable(new ApiError(404, "disabled", "mcp_disabled"))).toBe(false);
    expect(isMcpDisabled(new ApiError(404, "Not Found"))).toBe(false);
    expect(isMcpUnavailable(new ApiError(404, "Not Found"))).toBe(true);
    expect(isMcpUnavailable(new ApiError(500, "boom"))).toBe(false);
  });
});
