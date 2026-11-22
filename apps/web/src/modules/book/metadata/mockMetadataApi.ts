import type { ApiFn } from "../../../components/dialogs";
import type { Book } from "../../../types";
import type { BookDetail, MetadataCandidate, MetadataLookupError } from "../types";
import { sampleBookDetail } from "./mockMetadataBook";
import { MOCK_METADATA_CANDIDATES } from "./mockMetadataCandidates";
import { applyMetadataPatch, metadataOf, type MockMetadataState } from "./mockMetadataPatch";
import { isValidIsbn10, isValidIsbn13, normalizeIsbn } from "./isbn";
import {
  searchScenarioFor,
  type MockMetadataScenario,
} from "./mockMetadataScenarios";

export type MockMetadataOptions = {
  /** Books the mock knows; the detail/list fields come from here. */
  books?: Book[];
  /** `off` answers 403 `lookup_disabled`; `unsupported` answers 404 on the lookup routes. */
  lookup?: "on" | "off" | "unsupported";
  /** Number of searches accepted before the next answers 429. `0` fails the first one. */
  rateLimitAfter?: number;
  /** Provider failures returned next to the candidates. */
  searchErrors?: MetadataLookupError[];
  candidates?: MetadataCandidate[];
  /** A ready-made search outcome, also selectable by `?mock=metadata-search&scenario=…`. */
  scenario?: MockMetadataScenario;
};

const ONE_PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="),
  (char) => char.charCodeAt(0),
);
const COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const COVER_MAX_BYTES = 5 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const badRequest = (message: string, field?: string) => json({ message, ...(field ? { field } : {}) }, 400);
const notFound = () => json({ message: "Not found" }, 404);

const bodyOf = (init?: RequestInit): unknown => {
  try {
    return JSON.parse(String(init?.body ?? "{}"));
  } catch {
    return null;
  }
};

function stateFrom(book: Book): MockMetadataState {
  return {
    file: { title: book.title, author: book.author },
    override: {},
    source: null,
    updatedAt: null,
    hasFileCover: book.hasCover,
    customCover: book.hasCover && book.coverRev != null,
    coverRev: book.coverRev ?? null,
  };
}

function detailOf(book: Book, state: MockMetadataState): BookDetail {
  const metadata = metadataOf(state);
  return {
    ...book,
    title: metadata.title,
    author: metadata.author,
    hasCover: state.hasFileCover || state.customCover,
    favorite: book.favorite ?? false,
    coverRev: state.coverRev,
    tagIds: book.tagIds ?? [],
    metadata,
  };
}

const isCoverUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (["books.google.com", "books.googleusercontent.com", "covers.openlibrary.org", "archive.org"].includes(host) ||
        host.endsWith(".archive.org"))
    );
  } catch {
    return false;
  }
};

function matchingCandidates(candidates: MetadataCandidate[], search: URLSearchParams): MetadataCandidate[] {
  const isbn = normalizeIsbn(search.get("isbn") ?? "");
  if (isbn) {
    return candidates.filter((candidate) =>
      [candidate.isbn10, candidate.isbn13].some((value) => value && normalizeIsbn(value) === isbn),
    );
  }
  const title = (search.get("title") ?? "").toLowerCase();
  const author = (search.get("author") ?? "").toLowerCase();
  return candidates.filter((candidate) => {
    const haystack = `${candidate.title} ${candidate.authors.join(" ")}`.toLowerCase();
    return (!title || haystack.includes(title)) && (!author || haystack.includes(author));
  });
}

/**
 * In-memory `GET /api/books/:id` + metadata routes. It validates like the server, keeps
 * override/cover state between calls and simulates disabled lookup and rate limiting.
 */
export function createMockMetadataApi(options: MockMetadataOptions = {}): ApiFn {
  const lookup = options.lookup ?? "on";
  const scenario = searchScenarioFor(options.scenario);
  const candidates = options.candidates ?? scenario?.candidates ?? MOCK_METADATA_CANDIDATES;
  const seed = options.books ?? [
    sampleBookDetail(),
    sampleBookDetail({ id: "meta-2", title: "The Silent Shelf", author: "Mira Costa", hasCover: false }),
  ];
  const books = new Map<string, Book>(seed.map((book) => [book.id, { ...book }]));
  const states = new Map<string, MockMetadataState>(seed.map((book) => [book.id, stateFrom(book)]));
  let searches = 0;

  const entry = (id: string) => {
    const book = books.get(id);
    const state = states.get(id);
    return book && state ? { book, state } : null;
  };
  const detail = (id: string) => {
    const found = entry(id);
    return found ? detailOf(found.book, found.state) : null;
  };
  const setCover = (id: string, custom: boolean) => {
    const found = entry(id);
    if (!found) return null;
    found.state = {
      ...found.state,
      customCover: custom,
      coverRev: custom ? (found.state.coverRev ?? 0) + 1 : null,
      source: custom ? "manual" : found.state.source,
      updatedAt: Date.now(),
    };
    states.set(id, found.state);
    return detail(id);
  };

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, "http://mock.knowlify");
    const method = (init?.method ?? "GET").toUpperCase();
    const lookupRoute = url.pathname === "/api/metadata/status" || url.pathname === "/api/metadata/search";
    if (lookupRoute && lookup === "unsupported") return notFound();
    if (url.pathname === "/api/metadata/status" && method === "GET") {
      return json({
        enabled: lookup !== "off",
        providers: [
          { id: "googlebooks", keyConfigured: false },
          { id: "openlibrary", keyConfigured: false },
        ],
      });
    }
    if (url.pathname === "/api/metadata/search" && method === "GET") {
      if (lookup === "off") return json({ message: "Metadata lookup is disabled.", code: "lookup_disabled" }, 403);
      if (options.rateLimitAfter !== undefined && searches >= options.rateLimitAfter) {
        return new Response(JSON.stringify({ message: "Too many metadata searches. Try again in a minute.", code: "rate_limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        });
      }
      const isbn = url.searchParams.get("isbn");
      const title = url.searchParams.get("title");
      const author = url.searchParams.get("author") ?? "";
      if ((isbn === null) === (title === null)) return badRequest("Send either isbn or title.");
      if (isbn !== null && !isValidIsbn10(isbn) && !isValidIsbn13(isbn)) return badRequest("ISBN checksum is invalid.", "isbn");
      if (title !== null && (title.length < 1 || title.length > 200)) return badRequest("Title must be 1–200 characters.", "title");
      if (author.length > 200) return badRequest("Author must be at most 200 characters.", "author");
      searches += 1;
      return json({
        candidates: matchingCandidates(candidates, url.searchParams),
        errors: options.searchErrors ?? scenario?.errors ?? [],
      });
    }

    const metadata = url.pathname.match(/^\/api\/books\/([^/]+)\/metadata$/);
    if (metadata) {
      const id = decodeURIComponent(metadata[1]!);
      const found = entry(id);
      if (!found) return notFound();
      if (method === "PATCH") {
        const result = applyMetadataPatch(found.state, bodyOf(init)) as
          | { state: MockMetadataState }
          | { error: { message: string; field?: string } };
        if ("error" in result) return badRequest(result.error.message, result.error.field);
        states.set(id, result.state);
        return json(detail(id));
      }
      if (method === "DELETE") {
        states.set(id, { ...found.state, override: {}, source: null, updatedAt: null, customCover: false, coverRev: null });
        return json(detail(id));
      }
      return notFound();
    }

    const coverFromUrl = url.pathname.match(/^\/api\/books\/([^/]+)\/cover\/from-url$/);
    if (coverFromUrl && method === "POST") {
      const id = decodeURIComponent(coverFromUrl[1]!);
      if (!entry(id)) return notFound();
      if (lookup === "off") return json({ message: "Metadata lookup is disabled.", code: "lookup_disabled" }, 403);
      const body = bodyOf(init);
      const value = typeof body === "object" && body !== null && "url" in body ? body.url : null;
      if (typeof value !== "string" || !isCoverUrl(value)) return badRequest("Cover URL is not allowed.");
      return json(setCover(id, true));
    }

    const cover = url.pathname.match(/^\/api\/books\/([^/]+)\/cover$/);
    if (cover) {
      const id = decodeURIComponent(cover[1]!);
      const found = entry(id);
      if (!found) return notFound();
      if (method === "PUT") {
        const file = init?.body instanceof FormData ? init.body.get("file") : null;
        if (!(file instanceof File)) return badRequest("Attach an image in the file field.");
        if (!COVER_TYPES.has(file.type)) return json({ message: "Use a JPEG, PNG or WebP image." }, 415);
        if (file.size === 0 || file.size > COVER_MAX_BYTES) return json({ message: "The image must be at most 5 MB." }, 413);
        return json(setCover(id, true));
      }
      if (method === "DELETE") return json(setCover(id, false));
      if (method === "GET" && (found.state.hasFileCover || found.state.customCover)) {
        return new Response(ONE_PIXEL_PNG, { headers: { "Content-Type": "image/png" } });
      }
      return notFound();
    }

    const bookRoute = url.pathname.match(/^\/api\/books\/([^/]+)$/);
    if (bookRoute && method === "GET") {
      const value = detail(decodeURIComponent(bookRoute[1]!));
      return value ? json(value) : notFound();
    }
    return notFound();
  };
}
