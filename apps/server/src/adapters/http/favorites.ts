import type { FastifyInstance } from "fastify";
import { ValidationError } from "../../domain/errors.js";
import type { BookSelection } from "../../ports/index.js";
import { FAVORITE_LIMITS, type Favorites } from "../../use-cases/Favorites.js";
import { parseSelection } from "./books-bulk.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface FavoritePatch {
  selection: BookSelection;
  favorite: boolean;
}

/**
 * `PATCH /api/books/favorite` body: the shared `BookSelection` fields (`ids` or
 * `filter`+`expectedTotal`) plus the required boolean, at the top level.
 */
export function parseFavoritePatch(body: unknown, indexingEnabled: boolean): FavoritePatch {
  if (!isRecord(body)) throw new ValidationError("Invalid favorite batch");
  if (typeof body.favorite !== "boolean") throw new ValidationError("favorite must be a boolean");
  return {
    selection: parseSelection(body, indexingEnabled, FAVORITE_LIMITS.maxIds),
    favorite: body.favorite,
  };
}

export async function favoriteRoutes(
  app: FastifyInstance,
  opts: { favorites: Favorites; indexingEnabled: boolean },
): Promise<void> {
  const { favorites } = opts;

  app.put<{ Params: { id: string } }>("/books/:id/favorite", async (req) => ({
    favorite: favorites.setOne(req.params.id, true),
  }));

  app.delete<{ Params: { id: string } }>("/books/:id/favorite", async (req) => ({
    favorite: favorites.setOne(req.params.id, false),
  }));

  // Static segment, so it wins over /books/:id for PATCH (same rule as /books/tags).
  app.patch("/books/favorite", async (req) => {
    const patch = parseFavoritePatch(req.body, opts.indexingEnabled);
    return favorites.apply(patch.selection, patch.favorite);
  });
}
