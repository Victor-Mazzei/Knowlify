import type { FastifyReply, FastifyRequest } from "fastify";
import { isAllowedPeerAddress, isLoopbackPeerAddress } from "../../domain/network/PeerAddress.js";
import { isLocalHostHeader, isLocalOrigin } from "../../domain/network/LocalHost.js";
import { isLoopbackOnlyRoute } from "../../domain/network/LoopbackOnlyRoutes.js";
import { safeAddress } from "../outboundDebug.js";

export type NetworkRejection = "peer" | "host" | "origin" | "route";

export interface NetworkGuardRequest {
  method: string;
  url: string;
  headers: { host?: string | undefined; origin?: string | undefined };
  /**
   * Host headers seen on the wire. `req.headers.host` keeps only one value, so a duplicate
   * is invisible there; more than one Host is a smuggling attempt and fails as `host`.
   */
  hostHeaderCount?: number;
}

/**
 * First failing check, in the order the guard documents. The peer is the socket address:
 * X-Forwarded-For never widens the allowlist, even with a trusted proxy configured.
 */
export function networkRejection(
  peer: string | undefined,
  request: NetworkGuardRequest,
): NetworkRejection | null {
  if (peer === undefined || !isAllowedPeerAddress(peer)) return "peer";
  if (request.hostHeaderCount !== undefined && request.hostHeaderCount > 1) return "host";
  const host = request.headers.host;
  if (host === undefined || !isLocalHostHeader(host)) return "host";
  const origin = request.headers.origin;
  if (origin !== undefined && !isLocalOrigin(origin)) return "origin";
  if (!isLoopbackPeerAddress(peer) && isLoopbackOnlyRoute(request.method, request.url)) return "route";
  return null;
}

/** Every Host value on the wire, in order; Node keeps just one in `req.headers`. */
export function hostHeaderValues(rawHeaders: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "host") values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
}

/**
 * The only rejection the UI needs to explain: the phone may read and change the library,
 * but folders, sources, settings, MCP tokens and account stay on the desktop. The other
 * rejections keep the bare body so a probing client learns nothing.
 */
const forbiddenBody = (rejection: NetworkRejection): { message: string; code?: "local_only" } =>
  rejection === "route" ? { message: "Forbidden", code: "local_only" } : { message: "Forbidden" };

export interface NetworkGuardLog {
  debug(message: string): void;
}

/**
 * `KNOWLIFY_NETWORK_GUARD=lan`: registered as the first `onRequest` hook, before CORS and
 * authentication, so every route (API, OPDS, KOSync, MCP, `/health` and the static UI)
 * goes through it. A rejection answers a generic 403: the failing check is only a category
 * in the debug log, never the Host, Origin, URL or credentials.
 */
export function networkGuard(log?: NetworkGuardLog) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const peer = req.socket.remoteAddress;
    const hosts = hostHeaderValues(req.raw.rawHeaders);
    const rejection = networkRejection(peer, {
      method: req.method,
      url: req.url,
      headers: { host: hosts[0] ?? req.headers.host, origin: req.headers.origin },
      hostHeaderCount: hosts.length,
    });
    if (rejection === null) return;
    log?.debug(`network guard rejected category=${rejection} ip=${safeAddress(peer)}`);
    return reply.code(403).send(forbiddenBody(rejection));
  };
}
