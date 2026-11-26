import { isIP } from "node:net";
import { classify, type IpKind } from "../net/IpClassification.js";

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Canonical form for limiter keys: an IPv4-mapped IPv6 address collapses to its IPv4 form
 * so `127.0.0.1` and `::ffff:127.0.0.1` share one bucket. `null` when it is not an IP.
 */
export function normalizePeerAddress(address: string): string | null {
  const value = address.trim().replace(/%.+$/, "");
  if (isIP(value) === 0) return null;
  const mapped = MAPPED_IPV4.exec(value);
  return mapped ? mapped[1]! : value.toLowerCase();
}

const isLocalKind = (kind: IpKind | null): boolean =>
  kind === "loopback" || kind === "private" || kind === "link-local";

/**
 * Peers the LAN share may serve: loopback, RFC 1918, CGNAT (Tailscale) and link-local.
 * The check runs on the socket address, never on X-Forwarded-For.
 */
export function isAllowedPeerAddress(address: string): boolean {
  const normalized = normalizePeerAddress(address);
  return normalized !== null && isLocalKind(classify(normalized));
}

export function isLoopbackPeerAddress(address: string): boolean {
  const normalized = normalizePeerAddress(address);
  return normalized !== null && classify(normalized) === "loopback";
}
