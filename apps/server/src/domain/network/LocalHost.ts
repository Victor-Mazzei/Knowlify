import { isIP } from "node:net";
import { classify, type IpKind } from "../net/IpClassification.js";

/** `hostname` or `hostname:port`, with an IPv6 literal in brackets. */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::(\d{1,5}))?$/i;

const isLocalKind = (kind: IpKind | null): boolean =>
  kind === "loopback" || kind === "private" || kind === "link-local";

export function hostnameFromHostHeader(header: string): string | null {
  const match = HOST_HEADER.exec(header.trim());
  if (!match) return null;
  const port = match[2];
  if (port !== undefined && Number(port) > 65_535) return null;
  return match[1]!.toLowerCase();
}

/**
 * DNS-rebinding guard: the `Host` hostname must be local. A public name is rejected even
 * when it resolves to a private address, because the browser only sees the name.
 */
export function isLocalHostHeader(header: string): boolean {
  const hostname = hostnameFromHostHeader(header);
  return hostname !== null && isLocalHostname(hostname);
}

export function isLocalHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === "localhost") return true;
  // WHATWG URL keeps the brackets in `hostname`; Node's socket address does not.
  if (value.startsWith("[") && value.endsWith("]")) return isLocalIp(value.slice(1, -1));
  if (isIP(value) === 4) return isLocalIp(value);
  // `.local` names need the OS resolver (mDNS or hosts file); a single label is a LAN name.
  if (value.endsWith(".local") && value.length > ".local".length) return true;
  return !value.includes(".");
}

function isLocalIp(value: string): boolean {
  return isLocalKind(classify(value));
}

/**
 * Origins allowed while sharing: the desktop webview (`tauri://localhost`, its Windows
 * `http(s)://tauri.localhost` form), the dev server and the UI served by this server.
 */
export function isLocalOrigin(origin: string): boolean {
  const value = origin.trim();
  if (value.toLowerCase() === "tauri://localhost") return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  return url.hostname === "tauri.localhost" || isLocalHostname(url.hostname);
}
