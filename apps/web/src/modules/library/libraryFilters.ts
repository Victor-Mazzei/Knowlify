import type { BookSelectionFilter, BookOrder, BookSort, Format, IndexFilter, ReadFilter, Source, TagWithCount } from "../../types";

/** UI state of the library filters. Every list is an OR; dimensions combine with AND. */
export type LibraryFilters = {
  /** Empty means every format; with two formats, both checked is the unfiltered state. */
  format: Format[];
  read: ReadFilter[];
  index: IndexFilter[];
  /** Folder source ids plus `upload`; at most 10. */
  source: string[];
  notes: boolean;
  favorite: boolean;
  /** Tag ids; at most 10. */
  tag: string[];
};

export type LibrarySearchState = {
  query: string;
  sort: BookSort;
  filters: LibraryFilters;
};

export type FilterChip = {
  key: string;
  label: string;
  next: LibraryFilters;
};

export const READ_FILTERS: readonly ReadFilter[] = ["unread", "reading", "finished"];
export const INDEX_FILTERS: readonly IndexFilter[] = ["ready", "pending", "error"];
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SOURCES = 10;
export const MAX_QUERY_LENGTH = 200;

export const READ_LABELS: Record<ReadFilter, string> = {
  unread: "Not started",
  reading: "Reading",
  finished: "Finished",
};

export const INDEX_LABELS: Record<IndexFilter, string> = {
  ready: "Index ready",
  pending: "Index pending",
  error: "Index error",
};

/** Panel labels; the group legend already says "Indexing". */
export const INDEX_OPTION_LABELS: Record<IndexFilter, string> = {
  ready: "Ready",
  pending: "Pending",
  error: "Error",
};

export const EMPTY_FILTERS: LibraryFilters = {
  format: [],
  read: [],
  index: [],
  source: [],
  notes: false,
  favorite: false,
  tag: [],
};

/** The UI opens on "in reading first"; the server keeps `added` as its own default. */
export const DEFAULT_SORT: BookSort = "reading";
export const EXTENDED_SORTS: readonly BookSort[] = ["lastRead", "author", "reading"];
const SORTS: readonly BookSort[] = ["added", "title", ...EXTENDED_SORTS];
const FORMATS: readonly Format[] = ["pdf", "epub"];
export const MAX_TAGS = 10;
export const TAG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ordered = <T extends string>(values: readonly T[], allowed: readonly T[]): T[] => {
  const selected = new Set(values);
  return allowed.filter((value) => selected.has(value));
};

const csv = <T extends string>(params: URLSearchParams, name: string, allowed: readonly T[], max: number): T[] => {
  const raw = params.get(name);
  if (!raw) return [];
  const valid = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is T => (allowed as readonly string[]).includes(value));
  return ordered(valid, allowed).slice(0, max);
};

export function parseBookSort(params: URLSearchParams): BookSort {
  const value = params.get("sort");
  return SORTS.find((sort) => sort === value) ?? DEFAULT_SORT;
}

/** The URL's explicit sort (invalid values included); null when the URL has none. */
export function parseExplicitBookSort(input: string | URLSearchParams): BookSort | null {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  return params.has("sort") ? parseBookSort(params) : null;
}

export function isExtendedSort(sort: BookSort): boolean {
  return EXTENDED_SORTS.includes(sort);
}

export function orderForSort(sort: BookSort): BookOrder {
  return sort === "title" || sort === "author" ? "asc" : "desc";
}
/** Invalid and unknown values are discarded instead of reaching the API. */
export function parseLibrarySearch(input: string | URLSearchParams): LibrarySearchState {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const rawFormat = params.get("format");
  const format = FORMATS.find((value) => value === rawFormat);
  const rawQuery = params.get("q") ?? "";
  const sources = (params.get("source") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => SOURCE_ID_PATTERN.test(value));
  const tags = (params.get("tag") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => TAG_ID_PATTERN.test(value));
  return {
    query: rawQuery.slice(0, MAX_QUERY_LENGTH),
    sort: parseBookSort(params),
    filters: {
      format: format ? [format] : [],
      read: csv(params, "read", READ_FILTERS, READ_FILTERS.length),
      index: csv(params, "index", INDEX_FILTERS, INDEX_FILTERS.length),
      source: [...new Set(sources)].slice(0, MAX_SOURCES),
      notes: params.get("notes") === "1",
      favorite: params.get("favorite") === "1",
      tag: [...new Set(tags)].slice(0, MAX_TAGS),
    },
  };
}

/** Only filters, in the canonical order, for list and facets requests. */
export function filtersQuery(filters: LibraryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.format.length === 1) params.set("format", filters.format[0]!);
  const read = ordered(filters.read, READ_FILTERS);
  if (read.length) params.set("read", read.join(","));
  const index = ordered(filters.index, INDEX_FILTERS);
  if (index.length) params.set("index", index.join(","));
  const source = [...new Set(filters.source)].slice(0, MAX_SOURCES);
  if (source.length) params.set("source", source.join(","));
  if (filters.notes) params.set("notes", "1");
  if (filters.favorite) params.set("favorite", "1");
  const tag = [...new Set(filters.tag)].filter((value) => TAG_ID_PATTERN.test(value)).slice(0, MAX_TAGS);
  if (tag.length) params.set("tag", tag.join(","));
  return params;
}

export function filtersKey(filters: LibraryFilters): string {
  return filtersQuery(filters).toString();
}

/**
 * The URL keeps only state the server understands; defaults are omitted unless the
 * caller needs a deterministic history entry (for example, an explicit `added`).
 */
export function buildLibrarySearch(
  { query, sort, filters }: LibrarySearchState,
  { explicitSort = false }: { explicitSort?: boolean } = {},
): URLSearchParams {
  const params = filtersQuery(filters);
  if (query) params.set("q", query);
  if (sort !== DEFAULT_SORT || explicitSort) params.set("sort", sort);
  return params;
}

export function activeFilterCount(filters: LibraryFilters): number {
  let count = 0;
  if (filters.format.length === 1) count += 1;
  if (filters.read.length > 0) count += 1;
  if (filters.index.length > 0) count += 1;
  if (filters.source.length > 0) count += 1;
  if (filters.notes) count += 1;
  if (filters.favorite) count += 1;
  if (filters.tag.length > 0) count += 1;
  return count;
}

export function hasActiveFilters(filters: LibraryFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/** Both formats checked is "all"; clicking any format box returns to that state. */
export function formatChecked(filters: LibraryFilters, format: Format): boolean {
  return filters.format.length === 0 || filters.format.includes(format);
}

export function toggleFormat(filters: LibraryFilters, format: Format): LibraryFilters {
  if (filters.format.length === 0) {
    return { ...filters, format: [format === "pdf" ? "epub" : "pdf"] };
  }
  return { ...filters, format: [] };
}

export function toggleRead(filters: LibraryFilters, read: ReadFilter): LibraryFilters {
  const next = filters.read.includes(read) ? filters.read.filter((value) => value !== read) : [...filters.read, read];
  return { ...filters, read: ordered(next, READ_FILTERS) };
}

export function toggleIndex(filters: LibraryFilters, index: IndexFilter): LibraryFilters {
  const next = filters.index.includes(index) ? filters.index.filter((value) => value !== index) : [...filters.index, index];
  return { ...filters, index: ordered(next, INDEX_FILTERS) };
}

export function toggleSource(filters: LibraryFilters, id: string): LibraryFilters {
  if (filters.source.includes(id)) {
    return { ...filters, source: filters.source.filter((value) => value !== id) };
  }
  if (filters.source.length >= MAX_SOURCES) return filters;
  return { ...filters, source: [...filters.source, id] };
}

export function setNotes(filters: LibraryFilters, notes: boolean): LibraryFilters {
  return { ...filters, notes };
}

export function setFavorite(filters: LibraryFilters, favorite: boolean): LibraryFilters {
  return { ...filters, favorite };
}

export function toggleTag(filters: LibraryFilters, id: string): LibraryFilters {
  if (filters.tag.includes(id)) {
    return { ...filters, tag: filters.tag.filter((value) => value !== id) };
  }
  if (filters.tag.length >= MAX_TAGS) return filters;
  return { ...filters, tag: [...filters.tag, id] };
}

/**
 * The same strings as the list query, shaped for the bulk endpoints' `filter`
 * selection. The server parses them with the same rules as `GET /api/books`.
 */
export function selectionFilter(query: string, filters: LibraryFilters): BookSelectionFilter {
  const params = filtersQuery(filters);
  const selection: BookSelectionFilter = {};
  const q = query.trim();
  if (q) selection.q = q;
  const format = params.get("format");
  if (format === "pdf" || format === "epub") selection.format = format;
  for (const key of ["read", "index", "source", "notes", "favorite", "tag"] as const) {
    const value = params.get(key);
    if (value !== null) selection[key] = value;
  }
  return selection;
}

export function clearFilters(): LibraryFilters {
  return { ...EMPTY_FILTERS };
}

export function sourceLabel(source: Source): string {
  const parts = source.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? source.path;
}

export function sourceName(id: string, sources: Source[]): string {
  if (id === "upload") return "Added manually";
  const source = sources.find((item) => item.id === id);
  return source ? sourceLabel(source) : id;
}

export function filterChips(filters: LibraryFilters, sources: Source[], tags: TagWithCount[] = []): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const format of filters.format) {
    chips.push({
      key: `format:${format}`,
      label: format.toUpperCase(),
      next: { ...filters, format: [] },
    });
  }
  for (const read of filters.read) {
    chips.push({
      key: `read:${read}`,
      label: READ_LABELS[read],
      next: { ...filters, read: filters.read.filter((value) => value !== read) },
    });
  }
  for (const index of filters.index) {
    chips.push({
      key: `index:${index}`,
      label: INDEX_LABELS[index],
      next: { ...filters, index: filters.index.filter((value) => value !== index) },
    });
  }
  for (const source of filters.source) {
    chips.push({
      key: `source:${source}`,
      label: sourceName(source, sources),
      next: { ...filters, source: filters.source.filter((value) => value !== source) },
    });
  }
  if (filters.notes) {
    chips.push({ key: "notes", label: "With notes", next: { ...filters, notes: false } });
  }
  if (filters.favorite) {
    chips.push({ key: "favorite", label: "Favorites", next: { ...filters, favorite: false } });
  }
  for (const tag of filters.tag) {
    const name = tags.find((item) => item.id === tag)?.name ?? tag;
    chips.push({
      key: `tag:${tag}`,
      label: name,
      next: { ...filters, tag: filters.tag.filter((value) => value !== tag) },
    });
  }
  return chips;
}
