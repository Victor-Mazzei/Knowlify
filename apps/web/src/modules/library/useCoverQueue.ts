import { useEffect, useState } from "react";
import type { ApiFn } from "../../components/dialogs";
import type { Book } from "../../types";

export const COVER_CONCURRENCY = 6;
export const COVER_CACHE_LIMIT = 300;

export type CoverSize = "thumb" | "full";

type CoverRequest = {
  key: string;
  id: string;
  size: CoverSize;
  rev: number | null;
  api: ApiFn;
  controller: AbortController;
  subscribers: Map<symbol, (url: string) => void>;
  started: boolean;
  settled: boolean;
  settle: (url: string) => void;
};

const cache = new Map<string, string>();
const pending = new Map<string, CoverRequest>();
let queue: CoverRequest[] = [];
let active = 0;
let generation = 0;

function cacheKey(id: string, size: CoverSize, rev: number | null) {
  return `${size}:${id}:${rev ?? ""}`;
}

function coverPath(id: string, size: CoverSize, rev: number | null) {
  const params = new URLSearchParams({ size });
  if (rev !== null) params.set("v", String(rev));
  return `/api/books/${encodeURIComponent(id)}/cover?${params.toString()}`;
}

function cachedCover(key: string) {
  const url = cache.get(key);
  if (!url) return "";
  // Reinsert on every hit so the oldest entry is the least recently used.
  cache.delete(key);
  cache.set(key, url);
  return url;
}

function keepCover(key: string, url: string) {
  if (!url) return;
  const previous = cache.get(key);
  if (previous) URL.revokeObjectURL(previous);
  cache.set(key, url);
  while (cache.size > COVER_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) URL.revokeObjectURL(evicted);
  }
}

async function fetchCover(id: string, size: CoverSize, rev: number | null, api: ApiFn, signal: AbortSignal) {
  const response = await api(coverPath(id, size, rev), { signal });
  if (response.ok) return response.blob();
  if (size !== "thumb") return null;
  // A server that predates the thumb parameter still has the current endpoint.
  const legacy = await api(`/api/books/${encodeURIComponent(id)}/cover`, { signal });
  return legacy.ok ? legacy.blob() : null;
}

function start(request: CoverRequest) {
  request.started = true;
  active += 1;
  const startedAt = generation;
  void fetchCover(request.id, request.size, request.rev, request.api, request.controller.signal)
    .then((blob) => {
      if (startedAt !== generation || request.controller.signal.aborted || !blob) return;
      const url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
      keepCover(request.key, url);
      request.settle(url);
    })
    .catch(() => {
      if (!request.controller.signal.aborted) request.settle("");
    })
    .finally(() => {
      if (startedAt !== generation) return;
      active = Math.max(0, active - 1);
      if (pending.get(request.key) === request) pending.delete(request.key);
      pump();
    });
}

function pump() {
  while (active < COVER_CONCURRENCY && queue.length > 0) {
    const next = queue.shift();
    if (next && !next.controller.signal.aborted) start(next);
  }
}

function requestCover(
  key: string,
  id: string,
  size: CoverSize,
  rev: number | null,
  api: ApiFn,
): { promise: Promise<string>; release: () => void } {
  let promise: Promise<string>;
  let release: () => void;
  const existing = pending.get(key);
  const request: CoverRequest =
    existing ??
    (() => {
      const controller = new AbortController();
      const created: CoverRequest = {
        key,
        id,
        size,
        rev,
        api,
        controller,
        subscribers: new Map(),
        started: false,
        settled: false,
        settle: (url: string) => {
          if (created.settled) return;
          created.settled = true;
          for (const resolve of created.subscribers.values()) resolve(url);
          created.subscribers.clear();
        },
      };
      pending.set(key, created);
      queue.push(created);
      return created;
    })();

  const subscriber = Symbol("cover");
  promise = new Promise<string>((resolve) => request.subscribers.set(subscriber, resolve));
  release = () => {
    request.subscribers.delete(subscriber);
    if (request.subscribers.size > 0 || request.settled) return;
    request.controller.abort();
    queue = queue.filter((item) => item !== request);
    if (pending.get(key) === request) pending.delete(key);
    request.settle("");
  };
  if (!existing) pump();
  return { promise, release };
}

/**
 * Cover URL for one book, fed by a shared six-request queue and a 300-entry LRU.
 * The details page asks for `full`; cards keep the default thumbnail. `coverRev`
 * is part of the cache key and the request so a replaced cover is never stale.
 */
export function useCover(
  book: Pick<Book, "id" | "hasCover" | "status"> & Pick<Partial<Book>, "coverRev">,
  api: ApiFn,
  size: CoverSize = "thumb",
) {
  const rev = typeof book.coverRev === "number" ? book.coverRev : null;
  const key = cacheKey(book.id, size, rev);
  const [url, setUrl] = useState(() => (book.hasCover && book.status !== "pending" ? cachedCover(key) : ""));
  useEffect(() => {
    if (!book.hasCover || book.status === "pending") {
      setUrl("");
      return;
    }
    const cached = cachedCover(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    const handle = requestCover(key, book.id, size, rev, api);
    void handle.promise.then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
      handle.release();
    };
  }, [api, book.hasCover, book.id, book.status, key, rev, size]);
  return url;
}

/** Aborts queued work and revokes every object URL; exposed for tests. */
export function resetCoverQueue() {
  generation += 1;
  const open = [...queue, ...pending.values()];
  for (const request of open) {
    request.controller.abort();
    request.settle("");
  }
  queue = [];
  pending.clear();
  active = 0;
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}
