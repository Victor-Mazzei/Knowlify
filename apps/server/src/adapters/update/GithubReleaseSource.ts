import {
  RELEASE_API_URL,
  parseReleaseTag,
} from "../../domain/update/ReleaseTag.js";
import type {
  ReleaseFetchResult,
  ReleaseSource,
  UpdateFailureReason,
} from "../../ports/update.js";
import { readTextCapped } from "../outbound/cappedBody.js";

/** GitHub's ceiling for this response is tiny; 1 MB leaves room without a memory risk. */
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

/** Fixed request headers. Never an `Authorization`: there is no token on this client. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  // Generic on purpose: no version, commit or installation identifier leaves the server.
  "user-agent": "knowlify-update-check",
};

/** Printable ASCII in the two shapes RFC 9110 allows, so the value is safe to echo back. */
const ETAG_PATTERN = /^(?:W\/)?"[\x21-\x7E]{1,200}"$/;

const JSON_MEDIA_TYPES = new Set(["application/json", "application/vnd.github+json"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readEtag = (response: Response): string | null => {
  const raw = response.headers.get("etag");
  return raw !== null && ETAG_PATTERN.test(raw) ? raw : null;
};

const mediaTypeOf = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

/** `Retry-After` seconds or the `x-ratelimit-reset` epoch; the use case clamps the result. */
const retryAfterMs = (response: Response): number | undefined => {
  const retry = response.headers.get("retry-after");
  if (retry !== null && /^\d{1,9}$/.test(retry)) return Number(retry) * 1000;
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset !== null && /^\d{1,12}$/.test(reset)) {
    const at = Number(reset) * 1000;
    return Math.max(0, at - Date.now());
  }
  return undefined;
};

const failure = (
  reason: UpdateFailureReason,
  details: { status?: number; retryAfterMs?: number } = {},
): ReleaseFetchResult => ({ outcome: "failed", reason, ...details });

const errorName = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined;

export interface GithubReleaseSourceOptions {
  /** Injected in the composition root; the default is a public-only guarded fetch. */
  fetch: typeof globalThis.fetch;
  /** Test seam; production keeps the documented 8 s. */
  timeoutMs?: number;
}

/**
 * Reads `releases/latest` from the fixed public repository. The response is untrusted:
 * only `tag_name` (plus `draft`/`prerelease`) is read, the release link is built from the
 * validated tag, and every failure is returned as a closed category instead of thrown.
 */
export class GithubReleaseSource implements ReleaseSource {
  private readonly timeoutMs: number;

  constructor(private readonly options: GithubReleaseSourceOptions) {
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async latest(etag: string | null): Promise<ReleaseFetchResult> {
    const headers: Record<string, string> = { ...REQUEST_HEADERS };
    if (etag !== null && ETAG_PATTERN.test(etag)) headers["if-none-match"] = etag;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.options.fetch(RELEASE_API_URL, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted || errorName(error) === "TimeoutError" || errorName(error) === "AbortError") {
        return failure("timeout");
      }
      // GuardedFetchError (blocked destination, TLS, DNS) and transport failures all map
      // to the same silent network category; the raw message never leaves this function.
      return failure("network");
    }

    const newEtag = readEtag(response);
    if (response.status === 304) return { outcome: "not_modified", etag: newEtag };
    if (response.status === 403 || response.status === 429) {
      const wait = retryAfterMs(response);
      return failure("rate_limited", {
        status: response.status,
        ...(wait === undefined ? {} : { retryAfterMs: wait }),
      });
    }
    if (response.status !== 200) {
      // Redirects are not followed, and every other status is a silent failure.
      return failure("http_error", { status: response.status });
    }
    if (!JSON_MEDIA_TYPES.has(mediaTypeOf(response))) {
      return failure("bad_response", { status: response.status });
    }

    let text: string | null;
    try {
      text = await readTextCapped(response, MAX_BODY_BYTES, {
        signal,
        mapError: (error) => (error instanceof Error ? error : new Error("update body read failed")),
      });
    } catch (error) {
      if (signal.aborted || errorName(error) === "TimeoutError" || errorName(error) === "AbortError") {
        return failure("timeout");
      }
      return failure("network");
    }
    if (text === null) return failure("bad_response", { status: response.status });

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return failure("bad_response", { status: response.status });
    }
    if (!isRecord(payload)) return failure("bad_response", { status: response.status });
    // Defense in depth: `releases/latest` already hides both, but a hostile response could
    // still claim them. Drafts and prereleases are never announced.
    if (payload.draft === true || payload.prerelease === true) {
      return failure("bad_tag", { status: response.status });
    }
    const release = parseReleaseTag(payload.tag_name);
    if (release === null) return failure("bad_tag", { status: response.status });
    return { outcome: "ok", release, etag: newEtag };
  }
}
