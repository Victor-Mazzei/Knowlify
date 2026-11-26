const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Admin surfaces a shared device may not reach: filesystem browsing, source management,
 * settings writes, MCP token issuance and account changes stay on the desktop's loopback.
 * Reads stay available so the phone can use the library; there is no route behind these
 * prefixes that a remote device needs.
 */
export function isLoopbackOnlyRoute(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? "";
  if (under(path, "/api/fs")) return true;
  if (under(path, "/api/mcp/tokens")) return true;
  if (under(path, "/api/account")) return true;
  // An update check is an external request: a paired device may read the cached
  // state, but only the computer that runs Knowlify may trigger the network call.
  if (method.toUpperCase() !== "GET" && path === "/api/update/check") return true;
  if (method.toUpperCase() === "GET") return false;
  return under(path, "/api/sources") || under(path, "/api/settings");
}
