import { AccountError } from "./domain/account/Password.js";
import { Account } from "./use-cases/Account.js";
import { EffectiveCredentials, ScryptPasswordHasher } from "./adapters/security/credentials.js";
import { SqliteSettingsRepository } from "./adapters/storage/SqliteSettingsRepository.js";
import { accountRoutes } from "./adapters/http/account.js";
import { aboutRoutes } from "./adapters/http/about.js";
import { loadBuildInfo } from "./adapters/runtime/buildInfo.js";
import { News } from "./use-cases/News.js";
import { SqliteFeedRepository, SqliteBookmarkRepository } from "./adapters/storage/SqliteNewsRepositories.js";
import { MemoryArticleCache } from "./adapters/rss/MemoryArticleCache.js";
import { SafeRssSource } from "./adapters/rss/SafeRssSource.js";
import type { RssSource } from "./ports/news.js";
import { newsRoutes } from "./adapters/http/news/index.js";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Db } from "./adapters/storage/db.js";
import type { Logger } from "./ports/index.js";
import type { IngestionRunner } from "./ports/knowledge.js";
import { SqliteBookRepository, SqliteSourceRepository, SqliteNoteRepository, SqliteProgressRepository, SqliteSyncProgressRepository, SqliteBookDuplicateRepository, SqliteMergeLogRepository, SqliteUnitOfWork, SqliteTagRepository, SqliteIgnoredBookRepository, SqliteMcpTokenRepository, SqliteBookMetadataRepository } from "./adapters/storage/repositories.js";
import { SqliteBookListQuery } from "./adapters/storage/SqliteBookListQuery.js";
import { SqliteBookIndexRepository, SqlitePassageRepository } from "./adapters/storage/SqliteKnowledgeRepositories.js";
import { SqliteBlobVectorStore } from "./adapters/storage/SqliteBlobVectorStore.js";
import { DiskFileStore } from "./adapters/files/FileStore.js";
import { CoverThumbs } from "./adapters/files/CoverThumbs.js";
import { CustomCovers } from "./adapters/files/CustomCovers.js";
import { NodeContentHasher } from "./adapters/files/NodeContentHasher.js";
import { createMetadataExtractors } from "./adapters/files/strategies.js";
import { ContentIdentity } from "./use-cases/ContentIdentity.js";
import { DuplicateFinder } from "./use-cases/DuplicateFinder.js";
import { Notes } from "./use-cases/Notes.js";
import { Progress, SyncProgress } from "./use-cases/Progress.js";
import { BrowseFolders } from "./use-cases/BrowseFolders.js";
import { NotFoundError, ValidationError, ConflictError } from "./domain/errors.js";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { REDACT_PATHS, SafeLogController, safeErrorForLog, safeRequestForLog } from "./adapters/logging/safeLogger.js";
import { safeErrorType } from "./adapters/logging/safeError.js";
import { existsSync } from "node:fs";
import { basicAuth } from "./adapters/http/auth.js";
import { config, defaultPasswordWarning } from "./config.js";
import { openDb } from "./adapters/storage/db.js";
import { Library } from "./use-cases/Library.js";
import { BookRemoval } from "./use-cases/BookRemoval.js";
import { IgnoredBooks } from "./use-cases/IgnoredBooks.js";
import { Tags } from "./use-cases/Tags.js";
import { Favorites } from "./use-cases/Favorites.js";
import { apiRoutes } from "./adapters/http/api.js";
import { favoriteRoutes } from "./adapters/http/favorites.js";
import { tagRoutes } from "./adapters/http/tags.js";
import { booksBulkRoutes } from "./adapters/http/books-bulk.js";
import { SqliteFavoriteRepository } from "./adapters/storage/SqliteFavoriteRepository.js";
import { ignoredRoutes } from "./adapters/http/ignored.js";
import { fsRoutes } from "./adapters/http/fs.js";
import { noteRoutes } from "./adapters/http/notes.js";
import { mcpTokenRoutes } from "./adapters/http/mcp-tokens.js";
import { registerMcp } from "./adapters/mcp/registerMcp.js";
import { McpAccess } from "./use-cases/McpAccess.js";
import { McpTokenCodec } from "./adapters/security/McpTokenCodec.js";
import { MCP_TOKEN_LIMITS } from "./domain/access/McpToken.js";
import { sourceRoutes } from "./adapters/http/sources.js";
import { duplicateRoutes } from "./adapters/http/duplicates.js";
import { Scanner } from "./use-cases/Scanner.js";
import { kosyncRoutes } from "./adapters/http/kosync.js";
import { opdsRoutes } from "./adapters/http/opds.js";
import { Indexing } from "./use-cases/Indexing.js";
import { PassageSearch } from "./use-cases/PassageSearch.js";
import { knowledgeRoutes } from "./adapters/http/knowledge.js";
import { chatRoutes } from "./adapters/http/chat.js";
import { Chat } from "./use-cases/Chat.js";
import { createLlmClient } from "./adapters/llm/createLlmClient.js";
import { SwitchableLlmClient } from "./adapters/llm/SwitchableLlmClient.js";
import { createGuardedFetch } from "./adapters/llm/GuardedFetch.js";
import { observedFetch } from "./adapters/outboundDebug.js";
import { OpenAiModelsProbe } from "./adapters/llm/OpenAiModelsProbe.js";
import { AnthropicModelsProbe } from "./adapters/llm/AnthropicModelsProbe.js";
import { NoLlmClient } from "./adapters/llm/NoLlmClient.js";
import { LazySecretBox } from "./adapters/security/SecretBox.js";
import { SecretFile } from "./adapters/security/SecretFile.js";
import { SqliteLlmConfigStore, SqliteMetadataConfigStore, SqliteTutorPromptStore } from "./adapters/storage/SqliteSettingsRepository.js";
import { LlmSettings } from "./use-cases/LlmSettings.js";
import { MetadataSettings } from "./use-cases/MetadataSettings.js";
import { TutorPromptSettings } from "./use-cases/TutorPromptSettings.js";
import { BookMetadata } from "./use-cases/BookMetadata.js";
import { BookLocks } from "./use-cases/BookLocks.js";
import { MetadataLookup } from "./use-cases/MetadataLookup.js";
import { CoverDownloader } from "./adapters/metadata/CoverDownloader.js";
import { GoogleBooks } from "./adapters/metadata/GoogleBooks.js";
import { OpenLibrary } from "./adapters/metadata/OpenLibrary.js";
import { MetadataCache } from "./adapters/metadata/MetadataCache.js";
import { metadataRoutes } from "./adapters/http/metadata.js";
import { readVersion } from "./adapters/runtime/buildInfo.js";
import { parseAllowPrivate } from "./domain/net/IpClassification.js";
import { SqliteConversationRepository } from "./adapters/storage/SqliteConversationRepository.js";
import type { EmbedderConfig } from "./adapters/indexing/embed/create.js";

export { REDACT_PATHS };

/**
 * Placeholder used when no ingestion adapter is wired. Keeping the API usable without a
 * runner matters for tests and for the window between the BE-core and BE-ingest merges;
 * indexing reports itself as disabled instead of marking every book as failed.
 */
const NO_INGESTION_RUNNER: IngestionRunner = {
  run: async () => { throw Object.assign(new Error("Ingestion runner is not configured"), { code: "unknown" }); },
  embedQuery: async () => null,
  embeddings: () => ({ mode: "none", model: null, state: "off" }),
  indexVersion: () => "1|none",
  onEmbeddingsReady: () => {},
  close: async () => {},
};

export type IndexingSettings = typeof config.indexing;

/**
 * Ingestion parallelism by embedding mode (ADR-C1): local inference already uses several
 * internal threads, so it stays at one worker; HTTP is opt-in network work and allows two;
 * lexical extraction scales up to the configured worker count.
 */
export function indexingWorkers(settings: IndexingSettings): number {
  const requested = Math.max(1, settings.workers);
  switch (settings.embeddings.mode) {
    case "local":
      return 1;
    case "http":
      return Math.min(2, requested);
    default:
      return requested;
  }
}

type JsonBodyParser = (
  request: FastifyRequest,
  body: string,
  done: (error: Error | null, body?: unknown) => void,
) => void;

function logIndexing(message: string, error?: unknown): void {
  // The worker/console path has no Pino serializer; keep only the safe error class.
  if (error) console.error(`[indexing] ${message} (${safeErrorType(error)})`);
  else console.warn(`[indexing] ${message}`);
}

export function createServices(
  db: Db,
  log: Logger = { info: () => {}, error: () => {}, warn: () => {} },
  rss: RssSource = new SafeRssSource(undefined, undefined, log),
  ingestionRunner?: IngestionRunner,
) {
  const books = new SqliteBookRepository(db);
  // HMAC key for opaque cursors. An operator-provided secret keeps cursors valid across
  // restarts; otherwise a per-process key is enough because a rejected cursor restarts paging.
  const bookList = new SqliteBookListQuery(db, config.secret.value ?? undefined);
  const sources = new SqliteSourceRepository(db);
  const noteRepository = new SqliteNoteRepository(db);
  const files = new DiskFileStore(config.booksDir, config.coversDir);
  const coverThumbs = new CoverThumbs(config.coversDir);
  const bookMetadataRepository = new SqliteBookMetadataRepository(db);
  const customCovers = new CustomCovers(config.coversDir);
  // One lock registry shared by every cover writer: metadata edits, merges and deletion
  // of the same book must not interleave their database and file steps.
  const bookLocks = new BookLocks();
  const clock = { now: () => Date.now() };
  const ids = { next: () => randomUUID() };
  const duplicateRepository = new SqliteBookDuplicateRepository(db);
  const tagRepository = new SqliteTagRepository(db);
  const ignoredRepository = new SqliteIgnoredBookRepository(db);
  const unitOfWork = new SqliteUnitOfWork(db);
  const favoriteRepository = new SqliteFavoriteRepository(db);
  const contentHasher = new NodeContentHasher();
  const contentIdentity = new ContentIdentity(books, duplicateRepository, contentHasher, files, sources, clock, ignoredRepository);
  const metadata = createMetadataExtractors(config.metadataWorkers, {
    // Tests use the reference extractors in-process; the pool has its own tests.
    inline: process.env.VITEST !== undefined,
    log: (message, error) => error === undefined ? log.warn?.(message) : log.error(error, message),
  });
  const settingsRepository = new SqliteSettingsRepository(db);
  const secretBox = new LazySecretBox({ envSecret: config.secret.value, file: new SecretFile(config.secret.file) });
  const metadataSettings = new MetadataSettings({
    store: new SqliteMetadataConfigStore(db),
    secrets: secretBox,
    env: { lookup: config.metadata.lookup, googleBooksApiKey: config.metadata.googleBooksApiKey },
    locked: config.metadataLocked,
    clock,
    log,
  });
  metadataSettings.bootstrap();
  const credentials = new EffectiveCredentials(settingsRepository, new ScryptPasswordHasher(), config);
  const bookIndexes = new SqliteBookIndexRepository(db);
  const passages = new SqlitePassageRepository(db);
  const vectors = new SqliteBlobVectorStore(db);
  const runner = ingestionRunner ?? NO_INGESTION_RUNNER;
  const workers = indexingWorkers(config.indexing);
  const indexing = new Indexing(bookIndexes, passages, books, runner, clock, {
    // Without a real runner the feature is off, even if the env says otherwise.
    enabled: config.indexing.enabled && ingestionRunner !== undefined,
    maxBytes: config.indexing.maxBytes,
    // One job per worker: the runner owns the pool and each slot accepts one run at a time.
    concurrency: workers,
    workers,
    backfill: config.indexing.backfill,
    vectorsMaxBooks: config.indexing.vectorsMaxBooks,
    settings: settingsRepository,
    backpressure: { enabled: true },
  }, log);
  const passageSearch = new PassageSearch(passages, vectors, runner, books, bookIndexes, {
    enabled: indexing.enabled,
    vectorScanMax: config.indexing.vectorScanMax,
  }, log);
  const conversations = new SqliteConversationRepository(db);
  const progressRepository = new SqliteProgressRepository(db);
  const duplicateFinder = new DuplicateFinder(
    books,
    duplicateRepository,
    contentHasher,
    sources,
    noteRepository,
    conversations,
    progressRepository,
    files,
    unitOfWork,
    new SqliteMergeLogRepository(db),
    clock,
    ids,
    log,
    { checkpoint: () => bookIndexes.walCheckpoint() },
    tagRepository,
    favoriteRepository,
    bookMetadataRepository,
    customCovers,
    bookLocks,
  );
  const allowPrivate = parseAllowPrivate(config.llmAllowPrivate);
  const outbound = (provider: string) => ({ provider, log });
  const guardedFetch = createGuardedFetch({ policy: allowPrivate.policy, debug: outbound("llm") });
  // External metadata is always public: it must not inherit the operator's LLM private
  // exception, so it uses its own policy that blocks loopback/private/link-local (ADR-5).
  const publicPolicy = { mode: "off" } as const;
  const openLibraryFetch = createGuardedFetch({ policy: publicPolicy, debug: outbound("openlibrary") });
  const googleBooksFetch = createGuardedFetch({ policy: publicPolicy, debug: outbound("googlebooks") });
  const coverFetch = createGuardedFetch({ policy: publicPolicy, debug: outbound("cover") });
  const plainLlmFetch = observedFetch(globalThis.fetch, "llm", log);
  const userAgent = `Knowlify/${readVersion(undefined, (message) => log.warn?.(message))}`;
  const coverDownloader = new CoverDownloader({ fetch: coverFetch, userAgent });
  const bookMetadata = new BookMetadata(
    books,
    bookMetadataRepository,
    customCovers,
    coverThumbs,
    clock,
    {
      coverFetcher: coverDownloader,
      lookupEnabled: () => metadataSettings.isLookupEnabled(),
      log,
    },
    bookLocks,
  );
  const metadataLookup = new MetadataLookup(
    [
      new OpenLibrary(openLibraryFetch, { userAgent }),
      new GoogleBooks(googleBooksFetch, { resolveKey: () => metadataSettings.googleBooksKey(), userAgent }),
    ],
    new MetadataCache(),
    { enabled: () => metadataSettings.isLookupEnabled() },
  );
  const llmRuntime = new SwitchableLlmClient((runtime) => {
    if (!runtime) return new NoLlmClient();
    return createLlmClient(
      {
        url: runtime.url,
        apiKey: runtime.apiKey,
        model: runtime.model,
        timeoutSec: runtime.timeoutSec,
        apiStyle: runtime.apiStyle,
        headers: runtime.headers,
      },
      { fetch: runtime.guard ? guardedFetch : plainLlmFetch, warn: (message) => log.warn?.(message) },
    );
  });
  const llmSettings = new LlmSettings({
    store: new SqliteLlmConfigStore(db),
    secrets: secretBox,
    runtime: llmRuntime,
    probes: {
      plain: {
        openai: new OpenAiModelsProbe(observedFetch(globalThis.fetch, "llm-probe", log)),
        anthropic: new AnthropicModelsProbe(observedFetch(globalThis.fetch, "llm-probe", log)),
      },
      guarded: {
        openai: new OpenAiModelsProbe(createGuardedFetch({ policy: allowPrivate.policy, debug: outbound("llm-probe") })),
        anthropic: new AnthropicModelsProbe(createGuardedFetch({ policy: allowPrivate.policy, debug: outbound("llm-probe") })),
      },
    },
    clock,
    log,
    env: config.llm,
    locked: config.llmLocked,
    policy: allowPrivate.policy,
  });
  llmSettings.bootstrap();
  const tutorPromptSettings = new TutorPromptSettings({
    store: new SqliteTutorPromptStore(db),
    clock,
    log,
    locked: config.llmLocked,
  });
  tutorPromptSettings.bootstrap();
  const chat = new Chat(
    llmRuntime,
    passageSearch,
    conversations,
    books,
    clock,
    ids,
    () => ({ ...llmSettings.currentLimits(), libraryScope: indexing.enabled }),
    () => tutorPromptSettings.current(),
    log,
  );
  const scanner = new Scanner(books, sources, files, clock, ids, metadata, log, indexing, config.browseRoots, {
    scanConcurrency: config.scanConcurrency,
    metadataWorkers: config.metadataWorkers,
  }, { identity: contentIdentity, aliases: duplicateRepository, onScanComplete: () => duplicateFinder.trigger() }, ignoredRepository);
  const tags = new Tags(tagRepository, bookList, unitOfWork, clock, ids);
  const favorites = new Favorites(favoriteRepository, bookList, unitOfWork);
  const mcpAccess = new McpAccess(
    new SqliteMcpTokenRepository(db),
    new McpTokenCodec(),
    clock,
    ids,
    { maxActive: config.mcp.maxActiveTokens, lastUsedThrottleMs: MCP_TOKEN_LIMITS.lastUsedThrottleMs },
  );
  const removal = new BookRemoval(
    books,
    noteRepository,
    conversations,
    ignoredRepository,
    duplicateRepository,
    bookList,
    unitOfWork,
    files,
    coverThumbs,
    clock,
    ids,
    log,
    bookLocks,
  );
  const ignoredBooks = new IgnoredBooks(ignoredRepository, () => { void scanner.scan(); });
  return {
    credentials,
    account: new Account(credentials, clock, config),
    news: new News(new SqliteFeedRepository(db), new SqliteBookmarkRepository(db), rss, new MemoryArticleCache(clock), clock, ids),
    library: new Library(books, noteRepository, files, clock, ids, metadata, indexing, conversations, bookList, contentIdentity, ignoredRepository, tagRepository),
    coverThumbs,
    notes: new Notes(noteRepository, books, clock, ids),
    progress: new Progress(progressRepository, books, clock),
    syncProgress: new SyncProgress(new SqliteSyncProgressRepository(db), clock),
    folders: new BrowseFolders(files, config.libraryPaths, config.browseRoots),
    scanner,
    metadataExtractors: metadata,
    duplicateRepository,
    contentHasher,
    contentIdentity,
    duplicates: duplicateFinder,
    tags,
    favorites,
    removal,
    ignoredBooks,
    tagRepository,
    ignoredRepository,
    indexing,
    passageSearch,
    chat,
    llmSettings,
    metadataSettings,
    tutorPromptSettings,
    bookMetadata,
    metadataLookup,
    mcpAccess,
    ingestionRunner: runner,
  };
}

/**
 * High-frequency, low-signal routes: cover polls, index status polling and scan status.
 * Their request lines bury the interesting logs during a backfill (plan item 17).
 */
const QUIET_ROUTES = /^\/(?:api\/books\/[^/?]+\/cover|api\/index\/status|api\/scan)(?:\?|$)/;

export const suppressesRequestLogging = (url: string): boolean => QUIET_ROUTES.test(url);

type AppLogger = boolean | { stream: NodeJS.WritableStream };

/**
 * Compress only text-like payloads above 1 KB (ADR-D2). File streams and images are
 * excluded, and `text/event-stream` must never pass through a transform: the chat route
 * hijacks the reply and writes chunks directly, but the explicit exclusion keeps that
 * guarantee if the route ever moves back to `onSend`.
 */
export async function registerHttpCompression(app: FastifyInstance): Promise<void> {
  await app.register(compress, {
    global: true,
    // Clients never send compressed request bodies; keep the pre-plugin request contract.
    globalDecompression: false,
    threshold: 1024,
    customTypes: (contentType) => {
      const type = contentType.toLowerCase().split(";")[0]!.trim();
      return /^application\/(json|atom\+xml|xml)$/.test(type) || /^text\/(plain|html|css|javascript)$/.test(type);
    },
  });
}

export async function buildApp(
  db: Db,
  logger: AppLogger = false,
  rss?: RssSource,
  ingestionRunner?: IngestionRunner,
) {
  // Fastify 5 fails closed on a numeric trustProxy because hop-count trust cannot validate
  // the peer. The env still offers the conventional hop count for deployments reachable only
  // through the proxy; the IP/CIDR form is the safe choice and is documented first.
  const trustProxy = config.trustProxy;
  const trustProxyOption = typeof trustProxy === "number"
    ? (_address: string, hop: number) => hop < trustProxy
    : trustProxy;
  const app = Fastify({
    trustProxy: trustProxyOption,
    ...(logger !== false ? {
      logger: {
        level: config.logLevel,
        redact: REDACT_PATHS,
        serializers: { req: safeRequestForLog, err: safeErrorForLog },
        ...(typeof logger === "object" ? { stream: logger.stream } : {}),
      },
      logController: new SafeLogController({
        disableRequestLogging: (req) => suppressesRequestLogging(req.url),
      }),
    } : { logger: false }),
  });
  // One useful line at boot, without a new route. With `silent` nothing is emitted.
  app.log.info(`log level: ${config.logLevel}`);
  app.log.debug(`database schema version: ${String(db.pragma("user_version", { simple: true }))}`);
  // Fastify 5 rejects an empty body when the content type is application/json, but clients
  // send that header on body-less requests (DELETE). Fastify 4 parsed those as {}. Keep the
  // built-in parser for non-empty bodies so invalid JSON, prototype poisoning and the body
  // limit retain the Fastify 5 behaviour.
  const parseJson: JsonBodyParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser<"string">("application/json", { parseAs: "string" }, (req, body, done) => {
    if (body.length === 0) {
      done(null, {});
      return;
    }
    parseJson(req, body, done);
  });
  const log: Logger = {
    info: (message) => app.log.info(message),
    error: (error, message) => app.log.error(error, message),
    warn: (message) => app.log.warn(message),
    debug: (message) => app.log.debug(message),
  };
  const services = createServices(db, log, rss, ingestionRunner);
  const { scanner, indexing } = services;
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (req.url.split("?")[0] === "/api/account/password" && error.validation) {
      return reply.code(400).send({ message: "Invalid password change request" });
    }
    if (error instanceof AccountError) return reply.code(error.status).send({ message: error.message });
    if (error instanceof NotFoundError || error instanceof ValidationError || error instanceof ConflictError) {
      const domainError = error as NotFoundError | ValidationError | ConflictError;
      const status = error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 400;
      return reply.code(status).send({
        message: domainError.message,
        ...(domainError.code === undefined ? {} : { code: domainError.code }),
        ...(domainError.details ?? {}),
      });
    }
    return reply.send(error);
  });
  // Queue timers and the worker thread must not outlive the app (tests build many apps).
  app.addHook("onClose", async () => {
    indexing.stop();
    services.duplicates.stop();
    await services.metadataExtractors.close();
    await services.ingestionRunner.close();
    // Refresh planner statistics after a session with heavy inserts/deletes (ADR-D1).
    if (db.open) db.pragma("optimize");
  });
  // The browser app reflects any Origin for its own /api calls, but /mcp is a
  // non-browser endpoint: CORS must stay disabled there (ADR-5). The preflight route
  // then falls through to the MCP route, which never emits Access-Control-Allow-Origin.
  const browserCors = {
    origin: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Remote desktop/web clients are cross-origin and authenticate with a header, so
    // every request would otherwise pay an OPTIONS preflight. Repeat calls to the same
    // URL (status polling) then reuse the cached policy.
    maxAge: 600,
  };
  await app.register(cors, {
    delegator: (req, callback) => {
      callback(null, req.url.split("?")[0] === config.mcp.path ? { origin: false } : browserCors);
    },
  });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
  await registerHttpCompression(app);
  app.addHook("onRequest", basicAuth(services.credentials));

  app.get("/health", async () => ({ ok: true }));
  const buildInfo = loadBuildInfo({ warn: (message) => app.log.warn(message) });
  await app.register(aboutRoutes, { prefix: "/api", buildInfo });
  await app.register(accountRoutes, { prefix: "/api", ...services });
  await app.register(apiRoutes, { prefix: "/api", ...services });
  await app.register(metadataRoutes, {
    prefix: "/api",
    bookMetadata: services.bookMetadata,
    lookup: services.metadataLookup,
    library: services.library,
    progress: services.progress,
    indexing: services.indexing,
  });
  await app.register(tagRoutes, { prefix: "/api", tags: services.tags });
  await app.register(favoriteRoutes, {
    prefix: "/api",
    favorites: services.favorites,
    indexingEnabled: services.indexing.enabled,
  });
  await app.register(booksBulkRoutes, {
    prefix: "/api",
    tags: services.tags,
    removal: services.removal,
    indexingEnabled: services.indexing.enabled,
  });
  await app.register(ignoredRoutes, { prefix: "/api", ignoredBooks: services.ignoredBooks });
  await app.register(duplicateRoutes, { prefix: "/api", ...services });
  await app.register(knowledgeRoutes, { prefix: "/api", ...services });
  await app.register(chatRoutes, { prefix: "/api", ...services });
  await app.register(newsRoutes, { prefix: "/api/news", ...services });
  await app.register(noteRoutes, { prefix: "/api", ...services });
  await app.register(mcpTokenRoutes, {
    prefix: "/api",
    mcpAccess: services.mcpAccess,
    enabled: config.mcp.enabled,
    path: config.mcp.path,
  });
  if (config.mcp.enabled) {
    await app.register(registerMcp, {
      mcpAccess: services.mcpAccess,
      library: services.library,
      search: services.passageSearch,
      notes: services.notes,
      tags: services.tags,
      favorites: services.favorites,
      indexing: services.indexing,
      progress: services.progress,
      version: buildInfo.version,
      settings: config.mcp,
      log,
    });
  }
  await app.register(fsRoutes, { prefix: "/api", ...services });
  await app.register(sourceRoutes, { prefix: "/api", ...services });
  await app.register(opdsRoutes, { prefix: "/opds", ...services });
  await app.register(kosyncRoutes, { prefix: "/kosync", ...services });

  if (config.webDir && existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.method === "GET" && !/^\/(api|opds|kosync|mcp)(\/|$)/.test(req.url) && !/\.[a-z0-9]+(\?|$)/i.test(req.url.split("?")[0] ?? "")
        ? reply.sendFile("index.html")
        : reply.code(404).send({ message: "Not found" }),
    );
  }

  return { app, scanner, indexing, duplicates: services.duplicates };
}

/**
 * Composition root only: `buildApp` never calls this factory, so tests can build an app
 * without spawning the worker thread or starting the queue. The queue is started by the
 * `main` block below, right after `listen`.
 */
export async function createIngestionRunner(
  indexing: IndexingSettings = config.indexing,
): Promise<IngestionRunner | undefined> {
  if (!indexing.enabled) return undefined;
  const { ThreadIngestionRunner } = await import("./adapters/indexing/ThreadIngestionRunner.js");
  return new ThreadIngestionRunner({
    embedder: toEmbedderConfig(indexing.embeddings),
    maxBytes: indexing.maxBytes,
    workers: indexingWorkers(indexing),
    log: logIndexing,
  });
}

/**
 * Maps the frozen environment settings to the embedder the worker will build. An HTTP
 * provider without both URL and model is a configuration mistake, not a fatal error:
 * warn once and keep the library searchable with lexical results.
 */
export function toEmbedderConfig(
  embeddings: IndexingSettings["embeddings"],
  warn: (message: string) => void = (message) => logIndexing(message),
): EmbedderConfig {
  switch (embeddings.mode) {
    case "local":
      return {
        kind: "local",
        model: embeddings.model ?? "Xenova/multilingual-e5-small",
        modelsDir: embeddings.modelsDir,
        offline: embeddings.offline,
        threads: embeddings.threads,
      };
    case "http":
      if (!embeddings.url || !embeddings.model) {
        warn("KNOWLIFY_EMBEDDINGS=http requires KNOWLIFY_EMBEDDINGS_URL and KNOWLIFY_EMBEDDINGS_MODEL; using lexical search only");
        return { kind: "none" };
      }
      return {
        kind: "http",
        url: embeddings.url,
        model: embeddings.model,
        ...(embeddings.apiKey ? { apiKey: embeddings.apiKey } : {}),
      };
    default:
      return { kind: "none" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.KNOWLIFY_LLM_URL?.trim() && !config.llm.url) {
    console.warn("[chat] KNOWLIFY_LLM_URL is not a valid http(s) base URL; chat stays disabled");
  }
  if (config.secret.invalid) {
    console.warn("[llm] KNOWLIFY_SECRET must have at least 32 characters; using data/secret.key instead");
  }
  if (!parseAllowPrivate(config.llmAllowPrivate).valid) {
    console.warn("[llm] KNOWLIFY_LLM_ALLOW_PRIVATE is invalid; private destinations stay blocked");
  }
  const db = openDb(config.dbFile);
  // EffectiveCredentials prefers a password changed in Settings unless it is forced back to env.
  const storedPassword = config.forceEnvPassword ? undefined : new SqliteSettingsRepository(db).get("password_hash");
  const passwordWarning = storedPassword === undefined ? defaultPasswordWarning(config.host, config.password) : null;
  if (passwordWarning !== null) console.warn(`[auth] ${passwordWarning}`);
  const ingestionRunner = await createIngestionRunner();
  const { app, scanner, indexing, duplicates } = await buildApp(db, true, undefined, ingestionRunner);
  let timer: NodeJS.Timeout | undefined;
  app.addHook("onClose", async () => { clearInterval(timer); });
  await app.listen({ port: config.port, host: config.host });
  indexing.start();
  duplicates.start();
  for (const path of config.libraryPaths) scanner.addSource(path);
  void scanner.scan();
  if (config.scanIntervalSec > 0) {
    timer = setInterval(() => void scanner.scan(), config.scanIntervalSec * 1000);
    timer.unref();
  }
}
