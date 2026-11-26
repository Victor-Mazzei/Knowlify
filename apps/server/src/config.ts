import { availableParallelism } from "node:os";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { parseLlmApiStyle, type LlmApiStyle } from "./domain/assistant/LlmApiStyle.js";
import { parseLlmHeadersEnv, type LlmHeaderStored } from "./domain/assistant/LlmHeaders.js";
import { LEGACY_SESSION_HEADER } from "./domain/assistant/legacyHeaders.js";

const dataDir = resolve(process.env.KNOWLIFY_DATA ?? "./data");

const readChoice = <T extends string>(value: string | undefined, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? value as T : fallback;

const readPositive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
};

/** Like readInteger, but zero is meaningful (it disables automatic vectors). */
const readNonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const readFlag = (value: string | undefined): boolean => value === "1" || value === "on" || value === "true";

const readCsv = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Case-insensitive; an unknown value is a boot-time mistake, never a silent fallback. */
export const readLogLevel = (value: string | undefined): LogLevel => {
  const raw = value?.trim().toLowerCase();
  if (!raw) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new Error(`KNOWLIFY_LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
};

const isProxyAddress = (entry: string): boolean => {
  const parts = entry.split("/");
  if (parts.length > 2 || parts[0] === "") return false;
  const family = isIP(parts[0]);
  if (family === 0) return false;
  if (parts.length === 1) return true;
  const prefix = parts[1];
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (family === 6 ? 128 : 32);
};

/**
 * `trustProxy` for Fastify: off by default because a direct client could forge
 * X-Forwarded-For and bypass per-IP limits. Enable it only behind a proxy you control.
 */
export const parseTrustProxy = (value: string | undefined): boolean | number | string => {
  const raw = value?.trim();
  if (!raw || raw.toLowerCase() === "off") return false;
  if (raw.toLowerCase() === "on") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  const entries = raw.split(",").map((entry) => entry.trim());
  if (!entries.every(isProxyAddress)) {
    throw new Error(
      "KNOWLIFY_TRUST_PROXY must be off, on, a hop count, or a comma-separated list of IPs/CIDRs",
    );
  }
  return entries.join(",");
};

export type NetworkGuardMode = "off" | "lan";

/**
 * `lan` turns on the share-on-my-network guard (peer/host/origin allowlists, loopback-only
 * admin routes and the authentication failure limiter). `off` is the historical behaviour,
 * required for Docker and for a deployment behind a public reverse proxy. An unknown value
 * is a boot-time mistake and is never echoed: it could be a mistyped secret.
 */
export const readNetworkGuardMode = (value: string | undefined): NetworkGuardMode => {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "off") return "off";
  if (raw === "lan") return "lan";
  throw new Error("KNOWLIFY_NETWORK_GUARD must be off or lan");
};

/**
 * Daily update check seed. `null` keeps the built-in default (`on`) distinguishable from
 * an explicit `on` in `GET /api/settings/update` (`source: "default"` vs `"env"`). An
 * unknown value is a boot-time mistake and is never echoed.
 */
export const readUpdateCheckMode = (value: string | undefined): boolean | null => {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "on") return true;
  if (raw === "off") return false;
  throw new Error("KNOWLIFY_UPDATE_CHECK must be on or off");
};

const serverHost = process.env.HOST?.trim() || "0.0.0.0";
const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

const SEEDED_PASSWORDS = new Set(["admin", "change-this-password"]);

/**
 * Warning only (never a boot failure): a default password on a network bind is a real risk.
 * The message never includes the password itself.
 */
export const defaultPasswordWarning = (host: string, password: string): string | null => {
  if (isLoopbackHost(host)) return null;
  if (password !== "" && !SEEDED_PASSWORDS.has(password)) return null;
  return "The server is using a default or empty password and listens beyond loopback. "
    + "Set KNOWLIFY_PASSWORD or change the password in Settings before exposing it to the network.";
};

/** Full origins only (scheme + host + optional port); a path or userinfo is a mistake. */
const readOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const explicitMcpHosts = readCsv(process.env.KNOWLIFY_MCP_ALLOWED_HOSTS).map((host) => host.toLowerCase());
const explicitMcpOrigins = readCsv(process.env.KNOWLIFY_MCP_ALLOWED_ORIGINS)
  .map(readOrigin)
  .filter((origin): origin is string => origin !== null);

const MIN_SECRET_CHARS = 32;
const secretValue = process.env.KNOWLIFY_SECRET?.trim() || null;

/**
 * The LLM URL comes from the operator, never from request data (ADR-12), so a private
 * IP is allowed on purpose. It may be the base (…/v1) or the full chat-completions
 * endpoint; the client normalizes it without duplicating the suffix. It still has to be
 * a plain HTTP(S) URL: credentials and fragments would end up in logs or in status
 * responses, and other schemes are not OpenAI-compatible.
 */
const readHttpBaseUrl = (value: string | undefined): string | null => {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.hash) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export type SearchCacheMode = "auto" | "off";

/**
 * `auto` sizes the query cache from the effective memory; `off` passes every read
 * straight to the worker. An unknown value is a boot-time mistake and is never echoed:
 * it could be a mistyped secret, and the message alone is enough to fix it.
 */
export const readSearchCacheMode = (value: string | undefined): SearchCacheMode => {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "off") return "off";
  throw new Error("KNOWLIFY_SEARCH_CACHE must be auto or off");
};

export type SearchWarmupMode = "auto" | "on" | "off";

/** `auto` warms lazily after the first query; `on` warms after the boot; `off` never. */
export const readSearchWarmupMode = (value: string | undefined): SearchWarmupMode => {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "on") return "on";
  if (raw === "off") return "off";
  throw new Error("KNOWLIFY_SEARCH_WARMUP must be auto, on or off");
};

/**
 * Optional ceiling for the warm-up budget. `0` disables warming; an empty value derives
 * the budget from the effective memory. The invalid value is never echoed.
 */
export const readSearchWarmupMaxMb = (value: string | undefined): number | null => {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error("KNOWLIFY_SEARCH_WARMUP_MAX_MB must be a non-negative integer");
  return Number(raw);
};

/**
 * Seed for the saved-session limit. Unset means the built-in default (200); an invalid
 * value is a boot-time mistake and is never echoed (it could be a mistyped secret).
 */
export const readChatMaxConversations = (value: string | undefined): number | null => {
  const raw = value?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error("KNOWLIFY_CHAT_MAX_CONVERSATIONS must be an integer between 20 and 5000");
  }
  const parsed = Number(raw);
  if (parsed < 20 || parsed > 5000) {
    throw new Error("KNOWLIFY_CHAT_MAX_CONVERSATIONS must be an integer between 20 and 5000");
  }
  return parsed;
};

/** Unlike the tolerant numeric readers, an unknown style is a boot-time mistake. */
const readApiStyle = (value: string | undefined): LlmApiStyle => {
  const raw = value?.trim();
  if (!raw) return "openai";
  try {
    return parseLlmApiStyle(raw);
  } catch {
    throw new Error("KNOWLIFY_LLM_API_STYLE must be openai or anthropic");
  }
};

const llmUrl = readHttpBaseUrl(process.env.KNOWLIFY_LLM_URL);
const llmApiStyle = readApiStyle(process.env.KNOWLIFY_LLM_API_STYLE);
const llmHeadersValue = process.env.KNOWLIFY_LLM_HEADERS;
// Undefined keeps the compatibility seed for one release (D6); an empty value or `{}`
// disables custom headers. A later removal of the seed is a documented 2.0 change.
const llmHeaders: LlmHeaderStored[] = llmHeadersValue === undefined
  ? (llmUrl ? [{ ...LEGACY_SESSION_HEADER }] : [])
  : llmHeadersValue.trim() === ""
    ? []
    : parseLlmHeadersEnv(llmHeadersValue, llmApiStyle);

const indexMaxMb = readPositive(process.env.KNOWLIFY_INDEX_MAX_MB, 200);
const embeddingsMode = readChoice(process.env.KNOWLIFY_EMBEDDINGS, ["none", "local", "http"] as const, "none");
const libraryPaths = (process.env.KNOWLIFY_LIBRARY_PATHS ?? "").split(",").map((p) => p.trim()).filter(Boolean);
const browseRootsValue = (process.env.KNOWLIFY_BROWSE_ROOTS ?? "").trim();
// Empty means unrestricted, the pre-existing behaviour. In the Docker image the library
// paths are set, so the default becomes the mounted /library instead of the whole container.
const browseRoots = browseRootsValue.toLowerCase() === "any"
  ? []
  : (browseRootsValue ? browseRootsValue.split(",") : libraryPaths).map((p) => p.trim()).filter(Boolean);
const embeddingThreads = readInteger(
  process.env.KNOWLIFY_EMBEDDINGS_THREADS,
  Math.max(1, Math.min(4, availableParallelism())),
);
// Worker pools stay small so metadata extraction and ingestion leave a core for the API.
const defaultWorkers = Math.max(1, Math.min(3, availableParallelism() - 1));

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: serverHost,
  /** Fastify/Pino level; debug and trace add the diagnostic outbound/auth/index events. */
  logLevel: readLogLevel(process.env.KNOWLIFY_LOG_LEVEL),
  // Opt-in: only a deployment behind a trusted proxy should believe X-Forwarded-For.
  trustProxy: parseTrustProxy(process.env.KNOWLIFY_TRUST_PROXY),
  // Opt-in LAN share guard; the desktop sidecar sets `lan` in every local mode.
  networkGuard: readNetworkGuardMode(process.env.KNOWLIFY_NETWORK_GUARD),
  dataDir,
  dbFile: resolve(dataDir, "knowlify.db"),
  booksDir: resolve(dataDir, "books"),
  coversDir: resolve(dataDir, "covers"),
  webDir: process.env.KNOWLIFY_WEB_DIR ? resolve(process.env.KNOWLIFY_WEB_DIR) : undefined,
  libraryPaths,
  browseRoots,
  scanIntervalSec: Number(process.env.KNOWLIFY_SCAN_INTERVAL ?? 600),
  /** Concurrent `stat`/directory reads while walking a source (ADR-B1). */
  scanConcurrency: readInteger(process.env.KNOWLIFY_SCAN_CONCURRENCY, 8),
  /** Worker threads for metadata extraction (ADR-B2). */
  metadataWorkers: readInteger(process.env.KNOWLIFY_METADATA_WORKERS, defaultWorkers),
  user: process.env.KNOWLIFY_USER ?? "admin",
  // Desktop local locks account changes; recovery ignores stored credentials.
  accountLocked: process.env.KNOWLIFY_ACCOUNT_LOCKED === "1",
  forceEnvPassword: process.env.KNOWLIFY_FORCE_ENV_PASSWORD === "1",
  password: process.env.KNOWLIFY_PASSWORD ?? "admin",
  indexing: {
    enabled: readChoice(process.env.KNOWLIFY_INDEXING, ["on", "off"] as const, "on") === "on",
    // The ingestion runner has one worker thread and serializes jobs. Values above 1 are
    // accepted for forward compatibility but the wiring passes min(value, 1) to Indexing.
    concurrency: Math.min(2, Math.max(1, Math.floor(readPositive(process.env.KNOWLIFY_INDEX_CONCURRENCY, 1)))),
    maxMb: indexMaxMb,
    maxBytes: indexMaxMb * 1024 * 1024,
    backfill: readChoice(process.env.KNOWLIFY_INDEX_BACKFILL, ["auto", "on", "off"] as const, "auto"),
    /** Ingestion workers (ADR-C1); the wiring clamps by embedding mode. */
    workers: readInteger(process.env.KNOWLIFY_INDEX_WORKERS, defaultWorkers),
    /** Books that get vectors automatically; 0 means demand-only (ADR-C1). */
    vectorsMaxBooks: readNonNegativeInteger(process.env.KNOWLIFY_INDEX_VECTORS_MAX_BOOKS, 1000),
    /** Above this many vectors, an unscoped vector scan falls back to lexical pre-filter. */
    vectorScanMax: readInteger(process.env.KNOWLIFY_VECTOR_SCAN_MAX, 300_000),
    embeddings: {
      mode: embeddingsMode,
      model: process.env.KNOWLIFY_EMBEDDINGS_MODEL?.trim()
        || (embeddingsMode === "local" ? "Xenova/multilingual-e5-small" : null),
      url: process.env.KNOWLIFY_EMBEDDINGS_URL?.trim() || null,
      apiKey: process.env.KNOWLIFY_EMBEDDINGS_API_KEY || null,
      offline: readFlag(process.env.KNOWLIFY_EMBEDDINGS_OFFLINE),
      modelsDir: process.env.KNOWLIFY_MODELS_DIR ? resolve(process.env.KNOWLIFY_MODELS_DIR) : resolve(dataDir, "models"),
      // Explicit thread count disables ORT's automatic affinity probing, which fails on
      // containers with a cpuset (pthread_setaffinity_np). The worker owns these threads.
      threads: embeddingThreads,
    },
  },
  llm: {
    url: llmUrl,
    apiKey: process.env.KNOWLIFY_LLM_API_KEY?.trim() || null,
    model: process.env.KNOWLIFY_LLM_MODEL?.trim() || null,
    maxTokens: readInteger(process.env.KNOWLIFY_LLM_MAX_TOKENS, 1024),
    timeoutSec: readInteger(process.env.KNOWLIFY_LLM_TIMEOUT_SEC, 120),
    ratePerMin: readInteger(process.env.KNOWLIFY_LLM_RATE_PER_MIN, 20),
    apiStyle: llmApiStyle,
    headers: llmHeaders,
    legacySessionHeader: llmHeadersValue === undefined && llmUrl !== null,
  },
  // Saved-session limit (ADR-13): environment seed, overridden by Settings unless
  // KNOWLIFY_LLM_LOCKED is set. `null` means the built-in default (200).
  chat: {
    maxConversations: readChatMaxConversations(process.env.KNOWLIFY_CHAT_MAX_CONVERSATIONS),
  },
  // UI-managed LLM settings (ADR-13..17). The env block above remains the seed when
  // no database record exists; these control the interface and the SSRF policy.
  llmLocked: readFlag(process.env.KNOWLIFY_LLM_LOCKED),
  llmAllowPrivate: process.env.KNOWLIFY_LLM_ALLOW_PRIVATE?.trim() ?? "",
  // 1 locks the metadata lookup settings to the environment (PUT → 403 metadata_locked).
  metadataLocked: readFlag(process.env.KNOWLIFY_METADATA_LOCKED),
  // Daily release check. `enabled: null` means the operator never set KNOWLIFY_UPDATE_CHECK,
  // so GET /api/settings/update reports `source: "default"`. No boot-time network call.
  update: {
    enabled: readUpdateCheckMode(process.env.KNOWLIFY_UPDATE_CHECK),
    locked: readFlag(process.env.KNOWLIFY_UPDATE_LOCKED),
  },
  // External metadata lookup (ADR-5). Explicit user action only; `off` hides the feature
  // and makes the lookup/cover-by-URL routes answer 403, while manual editing stays on.
  metadata: {
    lookup: readChoice(process.env.KNOWLIFY_METADATA_LOOKUP, ["on", "off"] as const, "on") === "on",
    /** Optional Google Books key. Never logged, never returned by any route. */
    googleBooksApiKey: process.env.KNOWLIFY_GOOGLE_BOOKS_API_KEY?.trim() || null,
  },
  // Retrieval cache (ADR-3). `auto` sizes it from the effective memory limit; `off`
  // bypasses it. Warming is a separate switch with its own budget (ADR-2).
  search: {
    cache: readSearchCacheMode(process.env.KNOWLIFY_SEARCH_CACHE),
    warmup: {
      mode: readSearchWarmupMode(process.env.KNOWLIFY_SEARCH_WARMUP),
      maxMb: readSearchWarmupMaxMb(process.env.KNOWLIFY_SEARCH_WARMUP_MAX_MB),
    },
  },
  // MCP endpoint (ADR-3..7). Disabled means the route is not registered at all.
  mcp: {
    enabled: readChoice(process.env.KNOWLIFY_MCP, ["on", "off"] as const, "on") === "on",
    path: "/mcp",
    ratePerMin: readInteger(process.env.KNOWLIFY_MCP_RATE_PER_MIN, 120),
    writeRatePerMin: readInteger(process.env.KNOWLIFY_MCP_WRITE_RATE_PER_MIN, 20),
    /** Failed Bearer attempts per IP, to stop a token-guessing loop. */
    authFailurePerMin: 10,
    maxActiveTokens: 20,
    maxBodyBytes: 256 * 1024,
    maxResponseBytes: 60 * 1024,
    allowedOrigins: explicitMcpOrigins,
    // A proxy deployment does not know its public Host, so an explicit list is opt-in.
    // A loopback bind keeps the standard DNS-rebinding guard.
    allowedHosts: explicitMcpHosts.length > 0
      ? explicitMcpHosts
      : isLoopbackHost(serverHost) ? ["localhost", "127.0.0.1", "[::1]"] : null,
  },
  secret: {
    value: secretValue !== null && secretValue.length >= MIN_SECRET_CHARS ? secretValue : null,
    invalid: secretValue !== null && secretValue.length < MIN_SECRET_CHARS,
    file: resolve(dataDir, "secret.key"),
  },
};
