import type { FastifyInstance, FastifyRequest } from "fastify";
import { isLoopbackPeerAddress } from "../../domain/network/PeerAddress.js";
import type { UpdateNotice } from "../../use-cases/UpdateNotice.js";
import { RateWindow } from "../RateWindow.js";

const CHECKS_PER_MINUTE = 6;

export interface UpdateRoutesOptions {
  updateNotice: UpdateNotice;
  /** `KNOWLIFY_NETWORK_GUARD=lan`: a remote LAN peer may read but not act. */
  lanGuard: boolean;
}

/**
 * `GET /api/update` and `POST /api/update/check`. Reads never block on the network;
 * "Check now" awaits the exchange and is limited to 6 calls per minute. There is no
 * error field: a failed check keeps the previous cache and stays silent.
 */
export async function updateRoutes(app: FastifyInstance, opts: UpdateRoutesOptions): Promise<void> {
  const checks = new RateWindow(CHECKS_PER_MINUTE);
  const canManage = (request: FastifyRequest): boolean =>
    !opts.lanGuard || isLoopbackPeerAddress(request.socket.remoteAddress ?? "");

  app.get("/update", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return opts.updateNotice.view(canManage(request));
  });

  app.post("/update/check", async (request, reply) => {
    const verdict = checks.hit("check");
    if (!verdict.allowed) {
      reply.header("Retry-After", String(verdict.retryAfterSec));
      return reply.code(429).send({ message: "Too many update checks", code: "rate_limited" });
    }
    reply.header("Cache-Control", "no-store");
    return opts.updateNotice.checkNow(canManage(request));
  });
}
