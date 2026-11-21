import { isValidIsbn10, isValidIsbn13, stripIsbn } from "../../domain/library/BookMetadata.js";
import type {
  GoogleBooksKeyResolution,
  MetadataCandidate,
  MetadataLookupQuery,
  MetadataProvider,
} from "../../ports/library-metadata.js";
import { htmlText, providerLink } from "./htmlText.js";
import { isRecord, MetadataProviderError, providerFailure, readJsonCapped, statusFailure, stringValue } from "./httpJson.js";

const BASE_URL = "https://www.googleapis.com/books/v1/volumes";
const MAX_CANDIDATES = 8;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BOOK_HOSTS = ["books.google.com"] as const;
const COVER_HOSTS = ["books.google.com", "books.googleusercontent.com"] as const;

export interface GoogleBooksOptions {
  /**
   * Resolved on every search so a key saved in Settings applies without a restart.
   * The key travels in `x-goog-api-key`, never in the URL or an error.
   */
  resolveKey: () => GoogleBooksKeyResolution;
  userAgent: string;
}

/** Google Books Volumes API (ADR-4). The key never appears in an error or log. */
export class GoogleBooks implements MetadataProvider {
  readonly id = "googlebooks" as const;

  constructor(
    private readonly fetchFn: typeof globalThis.fetch,
    private readonly options: GoogleBooksOptions,
  ) {}

  get keyConfigured(): boolean {
    return this.options.resolveKey().state === "ok";
  }

  private url(query: MetadataLookupQuery): string {
    const params = new URLSearchParams();
    params.set("q", "isbn" in query ? `isbn:${query.isbn}` : googleQuery(query));
    // The documented maximum is 40; the contract asks for at most 8 candidates.
    params.set("maxResults", String(MAX_CANDIDATES));
    params.set("printType", "books");
    return `${BASE_URL}?${params.toString()}`;
  }

  async search(query: MetadataLookupQuery, signal: AbortSignal): Promise<MetadataCandidate[]> {
    const key = this.options.resolveKey();
    // A stored envelope that cannot be decrypted fails closed: never retry unauthenticated
    // with a query the user expected to be authenticated, and never send the sealed value.
    if (key.state === "unreadable") throw new MetadataProviderError("unavailable");
    const headers: Record<string, string> = { "user-agent": this.options.userAgent, accept: "application/json" };
    if (key.state === "ok") headers["x-goog-api-key"] = key.key;
    let response: Response;
    try {
      response = await this.fetchFn(this.url(query), {
        method: "GET",
        signal,
        headers,
      });
    } catch (error) {
      throw providerFailure(error, signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusFailure(response.status);
    }
    const body = await readJsonCapped(response, MAX_RESPONSE_BYTES);
    if (!isRecord(body) || !Array.isArray(body.items)) return [];
    const candidates: MetadataCandidate[] = [];
    for (const item of body.items) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const candidate = this.toCandidate(item);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private toCandidate(value: unknown): MetadataCandidate | null {
    if (!isRecord(value)) return null;
    const id = stringValue(value.id);
    const info = value.volumeInfo;
    if (!id || !isRecord(info)) return null;
    const title = htmlText(info.title, 300);
    if (!title) return null;
    const rawAuthors = Array.isArray(info.authors) ? info.authors : [];
    const authors = rawAuthors
      .map((author) => htmlText(author, 200))
      .filter((author): author is string => author !== null)
      .slice(0, 10);
    const isbn10 = this.identifier(info, "ISBN_10");
    const isbn13 = this.identifier(info, "ISBN_13");
    const publishedDate = stringValue(info.publishedDate);
    const year = publishedDate?.match(/^(\d{4})/)?.[1];
    const languageValue = stringValue(info.language)?.trim().toLowerCase() ?? null;
    const language = languageValue && /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(languageValue) ? languageValue : null;
    const links = isRecord(info.imageLinks) ? info.imageLinks : null;
    const thumbnail = stringValue(links?.thumbnail) ?? stringValue(links?.smallThumbnail);
    const coverUrl = thumbnail ? providerLink(forceHttps(thumbnail), COVER_HOSTS) : null;
    const linkValue = stringValue(info.canonicalVolumeLink) ?? stringValue(info.infoLink);
    const link = linkValue ? providerLink(forceHttps(linkValue), BOOK_HOSTS) : null;
    return {
      source: "googlebooks",
      id,
      title,
      authors,
      description: htmlText(info.description, 5_000, true),
      isbn10,
      isbn13,
      publisher: htmlText(info.publisher, 200),
      year: year && Number(year) >= 1 && Number(year) <= 9999 ? Number(year) : null,
      language,
      coverUrl,
      link,
    };
  }

  private identifier(info: Record<string, unknown>, type: "ISBN_10" | "ISBN_13"): string | null {
    if (!Array.isArray(info.industryIdentifiers)) return null;
    for (const entry of info.industryIdentifiers) {
      if (!isRecord(entry) || entry.type !== type) continue;
      const raw = stringValue(entry.identifier);
      if (!raw) continue;
      const value = stripIsbn(raw);
      if ((type === "ISBN_10" && isValidIsbn10(value)) || (type === "ISBN_13" && isValidIsbn13(value))) {
        return value;
      }
    }
    return null;
  }
}

function googleQuery(query: { title: string; author?: string }): string {
  const phrase = (value: string): string => value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  let q = `intitle:"${phrase(query.title)}"`;
  if (query.author) q += ` inauthor:"${phrase(query.author)}"`;
  return q;
}

const forceHttps = (value: string): string => value.startsWith("http://") ? `https://${value.slice(7)}` : value;
