import {
  MetadataDisabledError,
  normalizeLookupQuery,
  type NormalizedLookupQuery,
} from "../domain/library/BookMetadata.js";
import {
  knownProviderErrorReason,
  knownProviderErrorStatus,
} from "../domain/library/ProviderErrorIdentifiers.js";
import type {
  ExternalMetadataSource,
  LookupSwitch,
  MetadataCandidate,
  MetadataFailureLogger,
  MetadataLookupError,
  MetadataLookupErrorCode,
  MetadataLookupFailure,
  MetadataLookupReason,
  MetadataProvider,
} from "../ports/library-metadata.js";

export interface MetadataLookupStatus {
  enabled: boolean;
  providers: Array<{ id: ExternalMetadataSource; keyConfigured: boolean }>;
}

export interface MetadataSearchResult {
  candidates: MetadataCandidate[];
  errors: MetadataLookupError[];
}

/** 429 with `Retry-After`; the route maps fields to the response. */
export class MetadataRateLimitError extends Error {
  readonly code = "rate_limited";
  readonly status = 429;
  constructor(readonly retryAfterSec: number) {
    super("Too many metadata lookups; retry shortly");
    this.name = "MetadataRateLimitError";
  }
}

export interface MetadataCacheLike {
  get(provider: string, query: NormalizedLookupQuery): MetadataCandidate[] | undefined;
  set(provider: string, query: NormalizedLookupQuery, value: MetadataCandidate[]): void;
}

export interface MetadataLookupOptions {
  /** Fixed flag or resolver read on every search (Settings can change it at runtime). */
  enabled: LookupSwitch;
  /** 12 per minute (ADR-5). */
  perMinute?: number;
  windowMs?: number;
  /** Per-provider deadline; providers run in order, later ones only as fallback. */
  providerTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_PER_MINUTE = 12;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 8_000;

const isFailure = (value: unknown): value is MetadataLookupFailure =>
  typeof value === "object" && value !== null && "code" in value
  && ["rate_limited", "timeout", "unavailable"].includes(String((value as { code?: unknown }).code));

const REASONS: readonly MetadataLookupReason[] = [
  "key_unreadable",
  "key_rejected",
  "service_disabled",
  "referrer_or_ip_blocked",
  "forbidden",
  "not_found",
  "rate_limited",
  "upstream_error",
  "http_error",
  "network",
  "blocked_destination",
  "bad_response",
  "timeout",
];

const isReason = (value: unknown): value is MetadataLookupReason =>
  typeof value === "string" && REASONS.includes(value as MetadataLookupReason);

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

const token = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return TOKEN.test(trimmed) ? trimmed : undefined;
};

const httpStatus = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;

/** The legacy code still decides the coarse bucket; the reason adds the diagnosis. */
const defaultReason = (code: MetadataLookupErrorCode): MetadataLookupReason => {
  if (code === "rate_limited") return "rate_limited";
  if (code === "timeout") return "timeout";
  return "network";
};

interface FailureDetails {
  code: MetadataLookupErrorCode;
  reason: MetadataLookupReason;
  status?: number;
  networkCode?: string;
  errorStatus?: string;
  errorReason?: string;
}

const failureDetails = (error: unknown, signal: AbortSignal): FailureDetails => {
  if (isFailure(error)) {
    return {
      code: error.code,
      reason: isReason(error.reason) ? error.reason : defaultReason(error.code),
      status: httpStatus(error.status),
      networkCode: token(error.networkCode),
      errorStatus: knownProviderErrorStatus(error.errorStatus),
      errorReason: knownProviderErrorReason(error.errorReason),
    };
  }
  if (signal.aborted || (error as { name?: unknown } | null)?.name === "TimeoutError") {
    return { code: "timeout", reason: "timeout" };
  }
  return { code: "unavailable", reason: "network" };
};

const completeness = (candidate: MetadataCandidate): number => {
  let score = 1; // title is always present
  if (candidate.authors.length > 0) score += 1;
  if (candidate.description !== null) score += 1;
  if (candidate.isbn10 !== null) score += 1;
  if (candidate.isbn13 !== null) score += 1;
  if (candidate.publisher !== null) score += 1;
  if (candidate.year !== null) score += 1;
  if (candidate.language !== null) score += 1;
  if (candidate.coverUrl !== null) score += 1;
  if (candidate.link !== null) score += 1;
  return score;
};

/**
 * External metadata lookup (ADR-4/ADR-5): manual action only, the first provider is the
 * default and the next ones are fallbacks (failures are reported in `errors`), results are cached for 10 minutes and the
 * endpoint is rate limited. Providers receive fixed, allowlisted URLs.
 */
export class MetadataLookup {
  private readonly hits: number[] = [];
  private readonly perMinute: number;
  private readonly windowMs: number;
  private readonly providerTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly providers: readonly MetadataProvider[],
    private readonly cache: MetadataCacheLike,
    private readonly options: MetadataLookupOptions,
  ) {
    this.perMinute = Math.max(1, options.perMinute ?? DEFAULT_PER_MINUTE);
    this.windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.providerTimeoutMs = Math.max(1, options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.isEnabled();
  }

  status(): MetadataLookupStatus {
    return {
      enabled: this.isEnabled(),
      providers: this.providers.map((provider) => ({ id: provider.id, keyConfigured: provider.keyConfigured })),
    };
  }

  async search(raw: unknown, log?: MetadataFailureLogger): Promise<MetadataSearchResult> {
    if (!this.isEnabled()) throw new MetadataDisabledError();
    const query = normalizeLookupQuery(raw);
    // Validation still teaches the caller the contract; the limit only counts valid calls.
    this.assertWithinLimit();
    // Providers are ordered by preference: later ones are only asked when every earlier
    // one failed or found nothing, so a normal search sends the query to a single provider.
    const errors: MetadataSearchResult["errors"] = [];
    const merged: Array<{ candidate: MetadataCandidate; order: number }> = [];
    for (const provider of this.providers) {
      const result = await this.one(provider, query, log);
      if (result.error) errors.push(result.error);
      for (const candidate of result.candidates) merged.push({ candidate, order: merged.length });
      if (merged.length > 0) break;
    }
    return { candidates: mergeCandidates(merged, query), errors };
  }

  private isEnabled(): boolean {
    return typeof this.options.enabled === "function" ? this.options.enabled() : this.options.enabled;
  }

  private assertWithinLimit(): void {
    const now = this.now();
    const start = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0]! <= start) this.hits.shift();
    if (this.hits.length >= this.perMinute) {
      const oldest = this.hits[0] ?? now;
      throw new MetadataRateLimitError(Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)));
    }
    this.hits.push(now);
  }

  private async one(
    provider: MetadataProvider,
    query: NormalizedLookupQuery,
    log?: MetadataFailureLogger,
  ): Promise<{
    provider: ExternalMetadataSource;
    candidates: MetadataCandidate[];
    error?: MetadataLookupError;
  }> {
    const cached = this.cache.get(provider.id, query);
    if (cached) return { provider: provider.id, candidates: cached };
    const signal = AbortSignal.timeout(this.providerTimeoutMs);
    try {
      const candidates = await provider.search(query, signal);
      this.cache.set(provider.id, query, candidates);
      return { provider: provider.id, candidates };
    } catch (error) {
      const failure = failureDetails(error, signal);
      this.logFailure(provider.id, failure, log);
      return {
        provider: provider.id,
        candidates: [],
        error: { source: provider.id, code: failure.code, reason: failure.reason },
      };
    }
  }

  /**
   * One line per failed provider per request. It carries only stable identifiers and the
   * HTTP/transport metadata: never the query, the ISBN, the key, a URL or provider text.
   * `errorStatus`/`errorReason` are re-checked against the closed allowlist so a provider
   * that echoes the key or the query in those fields cannot reach the log.
   */
  private logFailure(
    provider: ExternalMetadataSource,
    failure: FailureDetails,
    log?: MetadataFailureLogger,
  ): void {
    if (!log?.warn) return;
    const fields = [`provider=${provider}`, `reason=${failure.reason}`];
    if (failure.status !== undefined) fields.push(`status=${failure.status}`);
    if (failure.networkCode !== undefined) fields.push(`networkCode=${failure.networkCode}`);
    const errorStatus = knownProviderErrorStatus(failure.errorStatus);
    if (errorStatus !== undefined) fields.push(`errorStatus=${errorStatus}`);
    const errorReason = knownProviderErrorReason(failure.errorReason);
    if (errorReason !== undefined) fields.push(`errorReason=${errorReason}`);
    log.warn(`metadata lookup failed ${fields.join(" ")}`);
  }
}

/** Exact ISBN first, then completeness; duplicates by ISBN-13 keep the richer candidate. */
function mergeCandidates(
  merged: Array<{ candidate: MetadataCandidate; order: number }>,
  query: NormalizedLookupQuery,
): MetadataCandidate[] {
  const isbn = "isbn" in query ? query.isbn : null;
  const sorted = [...merged].sort((left, right) => {
    const exactLeft = isbn !== null && (left.candidate.isbn13 === isbn || left.candidate.isbn10 === isbn) ? 0 : 1;
    const exactRight = isbn !== null && (right.candidate.isbn13 === isbn || right.candidate.isbn10 === isbn) ? 0 : 1;
    if (exactLeft !== exactRight) return exactLeft - exactRight;
    const complete = completeness(right.candidate) - completeness(left.candidate);
    if (complete !== 0) return complete;
    return left.order - right.order;
  });
  const seen = new Set<string>();
  const candidates: MetadataCandidate[] = [];
  for (const { candidate } of sorted) {
    if (candidate.isbn13 !== null) {
      if (seen.has(candidate.isbn13)) continue;
      seen.add(candidate.isbn13);
    }
    candidates.push(candidate);
  }
  return candidates;
}
