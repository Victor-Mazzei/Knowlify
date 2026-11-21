import type { FastifyInstance } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import type { IgnoredBooks } from "../../use-cases/IgnoredBooks.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const parseLimit = (value: unknown): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
};

const parseOffset = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ValidationError("offset must be a non-negative integer");
  }
  return Number(value);
};

export async function ignoredRoutes(app: FastifyInstance, opts: { ignoredBooks: IgnoredBooks }) {
  const { ignoredBooks } = opts;
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/ignored-books", async (req) =>
    ignoredBooks.list(parseLimit(req.query.limit), parseOffset(req.query.offset)));

  app.post<{ Body: { ids?: unknown } }>("/ignored-books/restore", async (req) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)) {
      throw new ValidationError("ids must be an array of ignored book ids");
    }
    return ignoredBooks.restore(ids as string[]);
  });
}
