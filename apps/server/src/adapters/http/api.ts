import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import type { CoverThumbs } from "../files/CoverThumbs.js";
import type { Progress } from "../../use-cases/Progress.js";
import type { Library } from "../../use-cases/Library.js";
import type { Indexing } from "../../use-cases/Indexing.js";
import type { LlmSettings } from "../../use-cases/LlmSettings.js";
import type { MetadataSettings } from "../../use-cases/MetadataSettings.js";
import type { TutorPromptSettings } from "../../use-cases/TutorPromptSettings.js";
import type { UpdateNotice } from "../../use-cases/UpdateNotice.js";
import type { BookRemoval } from "../../use-cases/BookRemoval.js";
import type { BookMetadata } from "../../use-cases/BookMetadata.js";
import { toBookDetailDto } from "./bookDetail.js";
import { parseBookFilters, parseBookListQuery, queryIds, queryOptionalEnum, queryValue } from "./booksQuery.js";
import type { BooksQuerystring } from "./booksQuery.js";
import { toDto } from "./dto.js";
import { settingsLlmRoutes } from "./settings-llm.js";
import { settingsMetadataRoutes } from "./settings-metadata.js";
import { settingsUpdateRoutes } from "./settings-update.js";
import { updateRoutes } from "./update.js";

const MIME = { pdf: "application/pdf", epub: "application/epub+zip" } as const;

const coverEtag = (size: number, mtimeMs: number): string =>
  `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

const matchesEtag = (header: string | undefined, etag: string): boolean => {
  if (!header) return false;
  return header.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
};

export async function apiRoutes(
  app: FastifyInstance,
  opts: {
    progress: Progress;
    library: Library;
    indexing: Indexing;
    coverThumbs: CoverThumbs;
    llmSettings?: LlmSettings;
    tutorPromptSettings?: TutorPromptSettings;
    metadataSettings?: MetadataSettings;
    removal: BookRemoval;
    bookMetadata: BookMetadata;
    updateNotice?: UpdateNotice;
    /** `KNOWLIFY_NETWORK_GUARD=lan`; the update routes use it for `canManage`. */
    lanGuard?: boolean;
  },
) {
  const { progress, library, indexing, coverThumbs, llmSettings, tutorPromptSettings, metadataSettings, removal, bookMetadata, updateNotice, lanGuard } = opts;

  app.get<{ Querystring: BooksQuerystring }>("/books", async (req, reply) => {
    reply.header("Vary", "Authorization");
    const legacy = req.query.limit === undefined && req.query.ids === undefined;
    if (legacy) {
      // ADR-A2: without limit/ids the response stays byte-for-byte the legacy array.
      const q = typeof req.query.q === "string" ? req.query.q : undefined;
      const books = library.list(q);
      const states = indexing.statesFor(books.map((book) => book.id));
      const storedProgress = progress.forBooks(books.map((book) => book.id));
      reply.header("Deprecation", "true");
      return books.map((book) => toDto(book, states.get(book.id), indexing.enabled, storedProgress.get(book.id)));
    }

    const idsValue = queryValue(req.query.ids, "ids");
    if (idsValue !== undefined) {
      const ids = queryIds(idsValue);
      const format = queryOptionalEnum(queryValue(req.query.format, "format"), "format", ["pdf", "epub"] as const);
      const books = library.booksByIds(ids).filter((book) => format === undefined || book.format === format);
      const states = indexing.statesFor(books.map((book) => book.id));
      const storedProgress = progress.forBooks(books.map((book) => book.id));
      const tagIds = library.tagIdsForBooks(books.map((book) => book.id));
      const items = books.map((book) =>
        toDto(book, states.get(book.id), indexing.enabled, storedProgress.get(book.id), tagIds.get(book.id) ?? []));
      return { items, nextCursor: null, total: items.length };
    }

    const query = parseBookListQuery(req.query, indexing.enabled);
    const page = library.listPage(query);
    const ids = page.rows.map((row) => row.book.id);
    const states = indexing.statesFor(ids);
    const storedProgress = progress.forBooks(ids);
    const tagIds = library.tagIdsForBooks(ids);
    const items = page.rows.map((row) =>
      toDto(row.book, states.get(row.book.id), indexing.enabled, storedProgress.get(row.book.id), tagIds.get(row.book.id) ?? []));
    return {
      items,
      nextCursor: page.nextCursor,
      // The same filter object feeds count(): q, format, read, index, source and notes.
      // lastRead only walks books with progress, so its total applies the same restriction.
      total: library.countBooks(query, { requireProgress: query.sort === "lastRead" }),
    };
  });

  app.get<{ Querystring: BooksQuerystring }>("/books/facets", async (req, reply) => {
    reply.header("Vary", "Authorization");
    const filters = parseBookFilters(req.query, indexing.enabled);
    const facets = library.facets(filters, indexing.enabled);
    // Hashing the serialized body keeps the ETag tied to the exact representation a client
    // caches, and the payload is tiny (no need for a server-side cache).
    const body = JSON.stringify(facets);
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    reply.header("ETag", etag).header("Cache-Control", "private, no-cache").type("application/json; charset=utf-8");
    const candidate = req.headers["if-none-match"];
    if (typeof candidate === "string" && matchesEtag(candidate, etag)) {
      return reply.code(304).send();
    }
    return reply.send(body);
  });

  app.post("/books", async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ message: "Missing file" });
    await mkdir(join(config.dataDir, "tmp"), { recursive: true });
    const tmp = join(config.dataDir, "tmp", randomUUID());
    // The hash is computed on the same pass that writes the temp file: duplicate detection
    // never reads the upload again (ADR-5).
    const hasher = createHash("sha256");
    let size = 0;
    const tee = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
        size += chunk.length;
        hasher.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(part.file, tee, createWriteStream(tmp));
    try {
      const result = await library.importFile(tmp, part.filename, { size, contentHash: hasher.digest("hex") });
      // The queued job may already be claimed, but the upload response always reports the
      // book as pending: the client must not learn anything about ingestion timing.
      const dto = toDto(result.book, undefined, indexing.enabled);
      const restored = result.restoredFromIgnored ? { restoredFromIgnored: true } : {};
      if (result.duplicate) return reply.code(200).send({ ...dto, duplicateOf: result.book.id, ...restored });
      return reply.code(201).send({ ...dto, ...restored });
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      return reply.code(400).send({ message: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/books/:id", async (req, reply) => {
    const detail = bookMetadata.detail(req.params.id);
    if (!detail) return reply.code(404).send({ message: "Not found" });
    const b = detail.book;
    return toBookDetailDto(
      b,
      detail.metadata,
      indexing.statesFor([b.id]).get(b.id),
      indexing.enabled,
      progress.forBooks([b.id]).get(b.id),
      library.tagIdsForBooks([b.id]).get(b.id) ?? [],
    );
  });

  app.get<{ Params: { id: string } }>("/books/:id/file", async (req, reply) => {
    const b = library.get(req.params.id);
    if (!b) return reply.code(404).send({ message: "Not found" });
    const name = encodeURIComponent(`${b.title}.${b.format}`);
    return reply
      .header("Content-Type", MIME[b.format])
      .header("Content-Disposition", `attachment; filename*=UTF-8''${name}`)
      .header("Content-Length", b.size)
      .send(createReadStream(b.path));
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>("/books/:id/cover", async (req, reply) => {
    const size = req.query.size ?? "full";
    if (size !== "full" && size !== "thumb") {
      return reply.code(400).send({ message: "size must be full or thumb" });
    }
    const b = library.get(req.params.id);
    if (!b?.cover_path) return reply.code(404).send({ message: "No cover" });

    let path = b.cover_path;
    let type = extname(path) === ".png" ? "image/png" : "image/jpeg";
    if (size === "thumb") {
      const thumbnail = await coverThumbs.ensure(b.id, b.cover_path);
      if (!thumbnail) return reply.code(404).send({ message: "No cover" });
      path = thumbnail;
      type = "image/jpeg";
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ message: "No cover" });
    const etag = coverEtag(info.size, info.mtimeMs);
    reply.header("Content-Type", type)
      .header("Cache-Control", "private, max-age=86400")
      .header("ETag", etag);
    const candidate = req.headers["if-none-match"];
    if (typeof candidate === "string" && matchesEtag(candidate, etag)) {
      return reply.code(304).send();
    }
    return reply.send(createReadStream(path));
  });

  app.delete<{ Params: { id: string }; Querystring: { confirmNotes?: string } }>("/books/:id", async (req, reply) => {
    const raw = queryValue(req.query.confirmNotes, "confirmNotes");
    if (raw !== undefined && raw !== "0" && raw !== "1") {
      return reply.code(400).send({ message: "confirmNotes must be 0 or 1" });
    }
    const result = await removal.removeOne(req.params.id, { confirmNotes: raw === "1" });
    return result ? reply.code(204).send() : reply.code(404).send({ message: "Not found" });
  });

  app.get<{ Params: { id: string } }>("/books/:id/progress", async (req, reply) => {
    const row = progress.get(req.params.id);
    return row ?? reply.code(404).send({ message: "No progress" });
  });

  app.put<{ Params: { id: string }; Body: { position: string; percentage: number } }>(
    "/books/:id/progress",
    async (req, reply) => {
      progress.save(req.params.id, req.body);
      return reply.code(204).send();
    },
  );

  if (llmSettings && tutorPromptSettings) {
    await app.register(settingsLlmRoutes, { llmSettings, tutorPromptSettings });
  }
  if (metadataSettings) {
    await app.register(settingsMetadataRoutes, { metadataSettings });
  }
  if (updateNotice) {
    await app.register(updateRoutes, { updateNotice, lanGuard: lanGuard ?? false });
    await app.register(settingsUpdateRoutes, { updateNotice });
  }
}
