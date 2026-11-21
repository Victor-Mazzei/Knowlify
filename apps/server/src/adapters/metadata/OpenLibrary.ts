import { isValidIsbn10, isValidIsbn13, stripIsbn } from "../../domain/library/BookMetadata.js";
import type { MetadataCandidate, MetadataLookupQuery, MetadataProvider } from "../../ports/library-metadata.js";
import { htmlText } from "./htmlText.js";
import { isRecord, providerFailure, readJsonCapped, statusFailure, stringValue } from "./httpJson.js";

const BASE_URL = "https://openlibrary.org/search.json";
const MAX_CANDIDATES = 8;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FIELDS = "key,title,author_name,first_publish_year,isbn,publisher,language,cover_i";

export interface OpenLibraryOptions {
  userAgent: string;
}

/** Open Library Search API (ADR-4). The documented covers flow and rate limits guide the query. */
export class OpenLibrary implements MetadataProvider {
  readonly id = "openlibrary" as const;
  readonly keyConfigured = false;

  constructor(
    private readonly fetchFn: typeof globalThis.fetch,
    private readonly options: OpenLibraryOptions,
  ) {}

  private url(query: MetadataLookupQuery): string {
    const params = new URLSearchParams();
    if ("isbn" in query) {
      params.set("isbn", query.isbn);
    } else {
      params.set("title", query.title);
      if (query.author) params.set("author", query.author);
    }
    params.set("limit", String(MAX_CANDIDATES));
    params.set("fields", FIELDS);
    return `${BASE_URL}?${params.toString()}`;
  }

  async search(query: MetadataLookupQuery, signal: AbortSignal): Promise<MetadataCandidate[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url(query), {
        method: "GET",
        signal,
        headers: { "user-agent": this.options.userAgent, accept: "application/json" },
      });
    } catch (error) {
      throw providerFailure(error, signal);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusFailure(response.status);
    }
    const body = await readJsonCapped(response, MAX_RESPONSE_BYTES);
    if (!isRecord(body) || !Array.isArray(body.docs)) return [];
    const candidates: MetadataCandidate[] = [];
    for (const doc of body.docs) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const candidate = this.toCandidate(doc, "isbn" in query ? query.isbn : null);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  private toCandidate(value: unknown, queriedIsbn: string | null): MetadataCandidate | null {
    if (!isRecord(value)) return null;
    const key = stringValue(value.key);
    const title = htmlText(value.title, 300);
    if (!key || !title) return null;
    const rawAuthors = Array.isArray(value.author_name) ? value.author_name : [];
    const authors = rawAuthors
      .map((author) => htmlText(author, 200))
      .filter((author): author is string => author !== null)
      .slice(0, 10);
    const isbns = Array.isArray(value.isbn)
      ? value.isbn.map((isbn) => stringValue(isbn)).filter((isbn): isbn is string => isbn !== null)
      : [];
    let isbn10 = isbns.map(stripIsbn).find(isValidIsbn10) ?? null;
    let isbn13 = isbns.map(stripIsbn).find(isValidIsbn13) ?? null;
    // A lookup by ISBN must surface the queried identifier even when the work lists many editions.
    if (queriedIsbn && isValidIsbn13(queriedIsbn)) isbn13 = queriedIsbn;
    if (queriedIsbn && isValidIsbn10(queriedIsbn)) isbn10 = queriedIsbn;
    const coverId = value.cover_i;
    const coverUrl = typeof coverId === "number" && Number.isInteger(coverId) && coverId > 0 && coverId <= 0x7fffffff
      ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`
      : null;
    const publishers = Array.isArray(value.publisher) ? value.publisher : [];
    const firstPublisher = publishers.map((publisher) => htmlText(publisher, 200)).find((publisher) => publisher !== null);
    const languages = Array.isArray(value.language) ? value.language : [];
    const languageValue = languages
      .map((language) => stringValue(language)?.trim().toLowerCase())
      .find((language): language is string =>
        language !== undefined && /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(language));
    const yearValue = value.first_publish_year;
    const year = typeof yearValue === "number" && Number.isInteger(yearValue) && yearValue >= 1 && yearValue <= 9999
      ? yearValue
      : null;
    const link = /^\/(works|books)\/[A-Za-z0-9]+$/.test(key) ? `https://openlibrary.org${key}` : null;
    return {
      source: "openlibrary",
      id: key,
      title,
      authors,
      // The search endpoint does not return descriptions (ADR-5).
      description: null,
      isbn10,
      isbn13,
      publisher: firstPublisher ?? null,
      year,
      language: languageValue ?? null,
      coverUrl,
      link,
    };
  }
}
