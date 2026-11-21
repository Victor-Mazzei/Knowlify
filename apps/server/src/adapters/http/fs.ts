import type { FastifyInstance } from "fastify";
import type { BrowseFolders } from "../../use-cases/BrowseFolders.js";
export async function fsRoutes(app: FastifyInstance, opts: { folders: BrowseFolders }) {
  app.get<{ Querystring: { path?: string } }>("/fs", req => opts.folders.execute(req.query.path));
}
