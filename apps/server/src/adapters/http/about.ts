import type { FastifyInstance } from "fastify";
import type { BuildInfo } from "../runtime/buildInfo.js";

/**
 * Deployment identity for the authenticated UI (ADR-5). `/health` stays public and
 * version-free; build details are read once at startup and never touch request data.
 */
export async function aboutRoutes(app: FastifyInstance, opts: { buildInfo: BuildInfo }): Promise<void> {
  const { buildInfo } = opts;

  app.get("/about", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return buildInfo;
  });
}
