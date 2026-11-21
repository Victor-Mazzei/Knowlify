import type { FastifyInstance } from "fastify";
import type { Scanner } from "../../use-cases/Scanner.js";
import type { DuplicateFinder, DuplicateStatus } from "../../use-cases/DuplicateFinder.js";

const IDLE: DuplicateStatus = { state: "idle", progress: null, groups: 0, redundantBooks: 0 };

export async function sourceRoutes(app: FastifyInstance, opts: { scanner: Scanner; duplicates?: DuplicateFinder }) {
  const { scanner, duplicates } = opts;
  // The scan status also carries the last duplicate analysis, so clients need one poll only.
  const status = () => ({ ...scanner.status(), duplicates: duplicates?.status() ?? IDLE });
  app.get("/sources", async () => scanner.listSources());
  app.post<{ Body: { path: string } }>("/sources", async (req, reply) => reply.code(201).send(await scanner.addReadableSource(req.body?.path)));
  app.delete<{ Params: { id: string } }>("/sources/:id", async (req, reply) => await scanner.removeSource(req.params.id) ? reply.code(204).send() : reply.code(404).send({ message: "Not found" }));
  app.post("/scan", async (_req, reply) => { void scanner.scan(); return reply.code(202).send(status()); });
  app.get("/scan", async () => status());
}
