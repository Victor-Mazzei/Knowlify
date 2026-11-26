import type { FastifyReply, FastifyRequest } from "fastify";
import type { CredentialVerifier } from "../../ports/account.js";
import { safeAddress } from "../outboundDebug.js";
import type { AuthFailureLimiter } from "./authFailureLimiter.js";

/**
 * A Basic challenge makes browsers pop up their own login dialog on any failed fetch(), on
 * top of the app's login form. Keep it only where a challenge is useful: OPDS readers
 * (KOReader) and direct browser navigation (`Accept: text/html`). Do not key off
 * `Sec-Fetch-Dest`: browsers omit `Sec-Fetch-*` on http://<LAN IP>, which is the common
 * deployment, and the app's own fetches send a wildcard or JSON Accept there.
 */
const wantsBasicChallenge = (req: FastifyRequest): boolean =>
 req.url.startsWith("/opds") || (req.headers.accept ?? "").toLowerCase().includes("text/html");

/** The peer for the failure limiter: the socket address, never X-Forwarded-For. */
const peerAddress = (req: FastifyRequest): string => req.socket.remoteAddress ?? "";

export function basicAuth(credentials: CredentialVerifier, failures?: AuthFailureLimiter) {
 return async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.method === "OPTIONS") return;
  if (!req.url.startsWith("/api") && !req.url.startsWith("/opds")) return;
  const peer = peerAddress(req);
  if (failures) {
    const verdict = failures.blocked(peer);
    if (verdict.blocked) {
      // Category and peer only; the header, the user name and the password never reach the log.
      req.log.debug(`auth rate-limited provider=basic ip=${safeAddress(peer)}`);
      return reply.header("Retry-After", String(verdict.retryAfterSec)).code(429).send({ message: "Too many attempts" });
    }
  }
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const [user = "", ...rest] = Buffer.from(header.slice(6), "base64").toString().split(":");
    if (credentials.verify(user, rest.join(":"))) return;
  }
  failures?.recordFailure(peer);
  // Category only: the header, the user name and the password never reach the log.
  req.log.debug(`auth failed provider=basic ip=${safeAddress(req.ip)} reason=${header === "" ? "credentials_missing" : "credentials_invalid"}`);
  // A challenge is useful to OPDS readers and to direct navigation only. Keying it off
  // Sec-Fetch-Dest is wrong on http://<LAN IP>, where browsers omit Sec-Fetch-* and the
  // app's own fetches would open the native login dialog over the form.
  if (wantsBasicChallenge(req)) reply.header("WWW-Authenticate", 'Basic realm="knowlify"');
  reply.code(401).send({ message: "Unauthorized" });
}
}
