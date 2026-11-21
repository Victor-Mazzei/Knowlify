import type { FastifyError, FastifyInstance } from "fastify";
import { ConflictError, NotFoundError, ValidationError } from "../../domain/errors.js";
import { IndexingDisabledError, type Indexing } from "../../use-cases/Indexing.js";
import { PassageSearchDisabledError, type PassageSearch } from "../../use-cases/PassageSearch.js";

const reindexBodySchema = {
  type: "object",
  required: ["scope"],
  additionalProperties: false,
  properties: { scope: { type: "string", enum: ["failed", "all"] } },
} as const;

const enqueueBodySchema = {
  type: "object",
  required: ["bookIds"],
  additionalProperties: false,
  properties: {
    bookIds: {
      type: "array",
      minItems: 1,
      maxItems: 500,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    vectors: { type: "boolean" },
  },
} as const;

const searchQuerySchema = {
  type: "object",
  required: ["q"],
  additionalProperties: false,
  properties: {
    q: { type: "string", minLength: 2, maxLength: 500 },
    bookId: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
  },
} as const;

export async function knowledgeRoutes(app: FastifyInstance, opts: { indexing: Indexing; passageSearch: PassageSearch }) {
  const { indexing, passageSearch } = opts;

  app.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error.validation) return reply.code(400).send({ message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ message: error.message });
    if (error instanceof ValidationError) return reply.code(400).send({ message: error.message });
    if (error instanceof ConflictError || error instanceof IndexingDisabledError) {
      return reply.code(409).send({ message: error.message });
    }
    if (error instanceof PassageSearchDisabledError) return reply.code(503).send({ message: error.message });
    return reply.send(error);
  });

  app.get("/index/status", async () => indexing.status());

  app.post("/index/pause", async () => ({ paused: indexing.pause() }));
  app.post("/index/resume", async () => ({ paused: indexing.resume() }));

  app.post<{ Body: { bookIds: string[]; vectors?: boolean } }>(
    "/index/enqueue",
    { schema: { body: enqueueBodySchema } },
    async (req, reply) => {
      const result = indexing.enqueue(req.body.bookIds, req.body.vectors !== false);
      return reply.code(202).send(result);
    },
  );

  app.post<{ Params: { id: string } }>("/books/:id/index", async (req, reply) => {
    const state = indexing.reindex(req.params.id);
    return reply.code(202).send({ state });
  });

  app.post<{ Body: { scope: "failed" | "all" } }>("/index/reindex", { schema: { body: reindexBodySchema } }, async (req, reply) => {
    return reply.code(202).send({ queued: indexing.reindexAll(req.body.scope) });
  });

  app.get<{ Querystring: { q: string; bookId?: string; limit?: number } }>(
    "/passages/search",
    { schema: { querystring: searchQuerySchema } },
    async (req) => passageSearch.search({ q: req.query.q, bookId: req.query.bookId, limit: req.query.limit ?? 8 }),
  );
}
