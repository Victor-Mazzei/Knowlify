import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import { ApiError, formatError } from "../../services/api";
import type { BookFacets, Source } from "../../types";
import { facetsPath } from "./bookList";
import { filtersKey, type LibraryFilters } from "./libraryFilters";

/** Counts trail rapid filter changes; the list itself never waits for this timer. */
export const FACETS_DEBOUNCE_MS = 150;
/** Index revisions arrive every few seconds; coalesce bursts of library changes. */
export const FACETS_REFRESH_THROTTLE_MS = 2000;

export type FacetsAvailability = "unknown" | "available" | "unavailable";

export type LibraryFacetsState = {
  availability: FacetsAvailability;
  facets: BookFacets | null;
  sources: Source[];
  error: string;
  /** Re-reads the counts after a mutation or an index revision. */
  invalidate: () => void;
  /** Re-reads folder labels after a source is added or removed. */
  invalidateSources: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCounts = (value: unknown, keys: string[]) =>
  isRecord(value) && keys.every((key) => typeof value[key] === "number");

const isSource = (value: unknown): value is Source =>
  isRecord(value) && typeof value.id === "string" && typeof value.path === "string";

const isBookFacets = (value: unknown): value is BookFacets => {
  if (!isRecord(value) || typeof value.total !== "number") return false;
  if (!isCounts(value.format, ["pdf", "epub"]) || !isCounts(value.read, ["unread", "reading", "finished"])) return false;
  if (value.index !== null && !isCounts(value.index, ["ready", "pending", "error"])) return false;
  if (!Array.isArray(value.source) || !value.source.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.count === "number")) return false;
  if (value.tag !== undefined && (!Array.isArray(value.tag) || !value.tag.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.count === "number"))) return false;
  if (value.favorite !== undefined && (!isRecord(value.favorite) || typeof value.favorite.with !== "number")) return false;
  return isRecord(value.notes) && typeof value.notes.with === "number";
};

async function responseError(response: Response) {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.message === "string") return body.message;
  } catch {
    /* keep the status fallback */
  }
  return `Request failed (${response.status})`;
}

/**
 * Probes `GET /api/books/facets` and keeps the counts for the current filters.
 * A 404 (or an unexpected payload) marks filtering as unavailable so an older
 * server is never sent parameters it would ignore or reject.
 */
export function useLibraryFacets(api: ApiFn, request: { query: string; filters: LibraryFilters }): LibraryFacetsState {
  const [availability, setAvailability] = useState<FacetsAvailability>("unknown");
  const [facets, setFacets] = useState<BookFacets | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [sourcesToken, setSourcesToken] = useState(0);
  const unavailable = useRef(false);
  const cooldown = useRef<number | null>(null);
  const pending = useRef(false);
  // The first probe is what unlocks filters and the extended sorts. Debouncing it
  // only delays the UI (and tests) for no benefit; later changes still trail.
  const probed = useRef(false);
  // Index may be rejected when indexing is off, and `favorite` only exists after the
  // favorites contract; the first probe omits both until a response confirms them.
  const indexKnown = facets?.index != null;
  const favoriteKnown = facets?.favorite != null;
  const supported = {
    ...(indexKnown ? request.filters : { ...request.filters, index: [] }),
    favorite: favoriteKnown ? request.filters.favorite : false,
  };
  const effective: LibraryFilters = supported;
  const key = `${request.query}\u0000${filtersKey(effective)}`;
  const latest = useRef(request);
  latest.current = { query: request.query, filters: effective };

  /**
   * A mutation can change every count, but index revisions arrive continuously while a
   * backfill runs. The leading refresh is immediate; calls during the cooldown collapse
   * into one trailing refresh, so counts are never stale for long and never flood the
   * endpoint. Unavailable servers stay quiet.
   */
  const invalidate = useCallback(() => {
    if (unavailable.current) return;
    if (cooldown.current !== null) {
      pending.current = true;
      return;
    }
    setRefreshToken((value) => value + 1);
    const startCooldown = () => {
      cooldown.current = window.setTimeout(() => {
        cooldown.current = null;
        if (!pending.current) return;
        pending.current = false;
        setRefreshToken((value) => value + 1);
        startCooldown();
      }, FACETS_REFRESH_THROTTLE_MS);
    };
    startCooldown();
  }, []);

  const invalidateSources = useCallback(() => {
    if (unavailable.current) return;
    setSourcesToken((value) => value + 1);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldown.current !== null) window.clearTimeout(cooldown.current);
    };
  }, []);

  useEffect(() => {
    if (unavailable.current) return;
    const controller = new AbortController();
    const delay = probed.current ? FACETS_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(() => {
      probed.current = true;
      void (async () => {
        try {
          const response = await api(facetsPath(latest.current), { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!response.ok) {
            if (response.status === 404 || response.status === 405) {
              unavailable.current = true;
              setAvailability("unavailable");
              return;
            }
            const message = await responseError(response);
            if (controller.signal.aborted) return;
            setError(message);
            return;
          }
          const payload: unknown = await response.json();
          if (controller.signal.aborted) return;
          if (!isBookFacets(payload)) {
            unavailable.current = true;
            setAvailability("unavailable");
            return;
          }
          setFacets(payload);
          setError("");
          setAvailability("available");
        } catch (thrown) {
          if (controller.signal.aborted) return;
          if (thrown instanceof ApiError && (thrown.status === 404 || thrown.status === 405)) {
            unavailable.current = true;
            setAvailability("unavailable");
            return;
          }
          setError(formatError(thrown));
        }
      })();
    }, delay);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, key, refreshToken]);

  useEffect(() => {
    if (availability !== "available") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api("/api/sources", { signal: controller.signal });
        if (!response.ok) return;
        const payload: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (Array.isArray(payload)) setSources(payload.filter(isSource));
      } catch {
        // Labels are optional: facet ids remain usable on their own.
      }
    })();
    return () => controller.abort();
  }, [api, availability, sourcesToken]);

  return { availability, facets, sources, error, invalidate, invalidateSources };
}
