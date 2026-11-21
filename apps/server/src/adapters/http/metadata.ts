import type { FastifyInstance, FastifyReply } from "fastify";
import { METADATA_LIMITS, MetadataDisabledError } from "../../domain/library/BookMetadata.js";
import type { BookMetadata, DetailedBook } from "../../use-cases/BookMetadata.js";
import { MetadataRateLimitError, type MetadataLookup } from "../../use-cases/MetadataLookup.js";
import type { Indexing } from "../../use-cases/Indexing.js";
import type { Library } from "../../use-cases/Library.js";
import type { Progress } from "../../use-cases/Progress.js";
import { CoverFetchError } from "../metadata/CoverDownloader.js";
import { CoverImageError } from "../files/CustomCovers.js";
import { toBookDetailDto } from "./bookDetail.js";

export interface MetadataRouteOptions {
  bookMetadata: BookMetadata;
  lookup: MetadataLookup;
  library: Library;
  progress: Progress;
  indexing: Indexing;
}

/** Maps the typed adapter failures to the frozen status codes; plain errors bubble up. */
function sendKnown(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof MetadataDisabledError) {
    reply.code(403).send({ message: error.message, code: "lookup_disabled" });
    return true;
  }
  if (error instanceof MetadataRateLimitError) {
    reply.header("Retry-After", String(error.retryAfterSec)).code(429)
      .send({ message: error.message, code: "rate_limited" });
    return true;
  }
  if (error instanceof CoverFetchError) {
    reply.code(error.status).send({ message: error.message, code: error.code });
    return true;
  }
  if (error instanceof CoverImageError) {
    reply.code(error.status).send({ message: error.message, code: error.code });
    return true;
  }
  return false;
}

export async function metadataRoutes(app: FastifyInstance, opts: MetadataRouteOptions) {
  const { bookMetadata, lookup, library, progress, indexing } = opts;

  const detailDto = (detail: DetailedBook) => {
    const id = detail.book.id;
    return toBookDetailDto(
      detail.book,
      detail.metadata,
      indexing.statesFor([id]).get(id),
      indexing.enabled,
      progress.forBooks([id]).get(id),
      library.tagIdsForBooks([id]).get(id) ?? [],
    );
  };

  app.get("/metadata/status", async () => lookup.status());

  app.get<{ Querystring: { isbn?: string; title?: string; author?: string } }>(
    "/metadata/search",
    async (req, reply) => {
      try {
        return await lookup.search(req.query);
      } catch (error) {
        if (sendKnown(error, reply)) return reply;
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/books/:id/metadata",
    { bodyLimit: METADATA_LIMITS.patchBytes },
    async (req, reply) => {
      const detail = bookMetadata.patch(req.params.id, req.body);
      return detail ? detailDto(detail) : reply.code(404).send({ message: "Not found" });
    },
  );

  app.delete<{ Params: { id: string } }>("/books/:id/metadata", async (req, reply) => {
    const detail = await bookMetadata.reset(req.params.id);
    return detail ? detailDto(detail) : reply.code(404).send({ message: "Not found" });
  });

  app.put<{ Params: { id: string } }>("/books/:id/cover", async (req, reply) => {
    let data: Buffer;
    try {
      const part = await req.file({ limits: { fileSize: METADATA_LIMITS.coverUploadBytes } });
      if (!part) return reply.code(400).send({ message: "Missing file" });
      data = await part.toBuffer();
      if (part.file.truncated) return reply.code(413).send({ message: "The cover image is too large" });
    } catch (error) {
      if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ message: "The cover image is too large" });
      }
      throw error;
    }
    try {
      const detail = await bookMetadata.setCover(req.params.id, data);
      return detail ? detailDto(detail) : reply.code(404).send({ message: "Not found" });
    } catch (error) {
      if (sendKnown(error, reply)) return reply;
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/books/:id/cover/from-url",
    { bodyLimit: METADATA_LIMITS.patchBytes },
    async (req, reply) => {
      try {
        const detail = await bookMetadata.setCoverFromUrl(req.params.id, req.body);
        return detail ? detailDto(detail) : reply.code(404).send({ message: "Not found" });
      } catch (error) {
        if (sendKnown(error, reply)) return reply;
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/books/:id/cover", async (req, reply) => {
    const detail = await bookMetadata.clearCover(req.params.id);
    return detail ? detailDto(detail) : reply.code(404).send({ message: "Not found" });
  });
}
