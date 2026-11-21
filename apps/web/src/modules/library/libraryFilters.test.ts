import { describe, expect, it } from "vitest";
import type { Source } from "../../types";
import {
  EMPTY_FILTERS,
  MAX_SOURCES,
  activeFilterCount,
  buildLibrarySearch,
  clearFilters,
  filterChips,
  formatChecked,
  orderForSort,
  parseBookSort,
  parseExplicitBookSort,
  parseLibrarySearch,
  selectionFilter,
  setFavorite,
  setNotes,
  sourceName,
  toggleFormat,
  toggleIndex,
  toggleRead,
  toggleSource,
  type LibraryFilters,
} from "./libraryFilters";

const filters = (overrides: Partial<LibraryFilters> = {}): LibraryFilters => ({ ...EMPTY_FILTERS, ...overrides });

const sources: Source[] = [
  { id: "s1", path: "/library/Fiction", accessible: true, books: 4 },
  { id: "s2", path: "C:\\library\\Reference", accessible: true, books: 2 },
];

describe("parseLibrarySearch", () => {
  it("restores every supported parameter and discards unknown values", () => {
    const state = parseLibrarySearch(
      "?q=dune&format=pdf&read=finished,reading,reading&index=error&source=s1,upload,bad%20id&notes=1&favorite=1&sort=lastRead&order=asc&unknown=x",
    );
    expect(state).toEqual({
      query: "dune",
      sort: "lastRead",
      filters: {
        format: ["pdf"],
        read: ["reading", "finished"],
        index: ["error"],
        source: ["s1", "upload"],
        notes: true,
        favorite: true,
        tag: [],
      },
    });
  });

  it("accepts only favorite=1 and ignores other values", () => {
    expect(parseLibrarySearch("?favorite=1").filters.favorite).toBe(true);
    expect(parseLibrarySearch("?favorite=0").filters.favorite).toBe(false);
    expect(parseLibrarySearch("?favorite=true").filters.favorite).toBe(false);
  });

  it("falls back to defaults for invalid sort and format values", () => {
    const state = parseLibrarySearch("?sort=random&format=pdf,epub&read=nope&notes=yes");
    expect(state.sort).toBe("reading");
    expect(state.filters).toEqual(EMPTY_FILTERS);
  });

  it("keeps at most ten source ids and one format", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${index + 1}`);
    const state = parseLibrarySearch(`?source=${ids.join(",")}&format=epub`);
    expect(state.filters.source).toHaveLength(MAX_SOURCES);
    expect(state.filters.format).toEqual(["epub"]);
  });

  it("clamps an oversized search term", () => {
    const state = parseLibrarySearch(`?q=${"x".repeat(300)}`);
    expect(state.query).toHaveLength(200);
  });
});

describe("buildLibrarySearch", () => {
  it("serializes filters in canonical order and omits defaults", () => {
    const params = buildLibrarySearch({
      query: "dune",
      sort: "lastRead",
      filters: filters({ read: ["finished", "unread"], source: ["s2", "s1"], notes: true, favorite: true }),
    });
    expect(params.get("q")).toBe("dune");
    expect(params.get("sort")).toBe("lastRead");
    expect(params.get("read")).toBe("unread,finished");
    expect(params.get("source")).toBe("s2,s1");
    expect(params.get("notes")).toBe("1");
    expect(params.get("favorite")).toBe("1");
    expect(params.has("format")).toBe(false);
    expect(params.has("index")).toBe(false);
    expect(params.has("order")).toBe(false);
  });

  it("omits the default sort unless the history entry needs it explicit", () => {
    expect(buildLibrarySearch({ query: "", sort: "reading", filters: EMPTY_FILTERS }).toString()).toBe("");
    expect(
      buildLibrarySearch(
        { query: "", sort: "reading", filters: EMPTY_FILTERS },
        { explicitSort: true },
      ).get("sort"),
    ).toBe("reading");
    expect(buildLibrarySearch({ query: "", sort: "added", filters: EMPTY_FILTERS }).get("sort")).toBe("added");
  });
});

describe("sort helpers", () => {
  it("reads only known sorts and defaults an absent one to reading", () => {
    expect(parseBookSort(new URLSearchParams("sort=author"))).toBe("author");
    expect(parseBookSort(new URLSearchParams("sort=reading"))).toBe("reading");
    expect(parseBookSort(new URLSearchParams("sort=bad"))).toBe("reading");
    expect(parseBookSort(new URLSearchParams(""))).toBe("reading");
  });

  it("tells an absent sort apart from an explicit one", () => {
    expect(parseExplicitBookSort("")).toBeNull();
    expect(parseExplicitBookSort("q=dune")).toBeNull();
    expect(parseExplicitBookSort("sort=author")).toBe("author");
    expect(parseExplicitBookSort(new URLSearchParams("sort=bad"))).toBe("reading");
  });

  it("defaults title and author to ascending", () => {
    expect(orderForSort("added")).toBe("desc");
    expect(orderForSort("lastRead")).toBe("desc");
    expect(orderForSort("reading")).toBe("desc");
    expect(orderForSort("title")).toBe("asc");
    expect(orderForSort("author")).toBe("asc");
  });
});

describe("filter toggles", () => {
  it("treats both formats checked as the unfiltered state", () => {
    expect(formatChecked(EMPTY_FILTERS, "pdf")).toBe(true);
    expect(toggleFormat(EMPTY_FILTERS, "pdf").format).toEqual(["epub"]);
    expect(toggleFormat(filters({ format: ["epub"] }), "epub").format).toEqual([]);
    expect(toggleFormat(filters({ format: ["epub"] }), "pdf").format).toEqual([]);
  });

  it("adds and removes read and index values in canonical order", () => {
    expect(toggleRead(EMPTY_FILTERS, "finished").read).toEqual(["finished"]);
    expect(toggleRead(filters({ read: ["finished"] }), "unread").read).toEqual(["unread", "finished"]);
    expect(toggleRead(filters({ read: ["unread"] }), "unread").read).toEqual([]);
    expect(toggleIndex(EMPTY_FILTERS, "error").index).toEqual(["error"]);
  });

  it("caps folder sources and clears every group", () => {
    const full = filters({ source: Array.from({ length: MAX_SOURCES }, (_, index) => `s${index}`) });
    expect(toggleSource(full, "one-more")).toBe(full);
    expect(toggleSource(filters({ source: ["s1"] }), "s1").source).toEqual([]);
    expect(toggleSource(EMPTY_FILTERS, "s1").source).toEqual(["s1"]);
    expect(setNotes(EMPTY_FILTERS, true).notes).toBe(true);
    expect(setFavorite(EMPTY_FILTERS, true).favorite).toBe(true);
    expect(clearFilters()).toEqual(EMPTY_FILTERS);
  });
});

describe("filter summary and chips", () => {
  it("counts active groups, not selected values", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      activeFilterCount(
        filters({
          format: ["pdf"],
          read: ["unread", "reading"],
          index: ["error"],
          source: ["s1", "upload"],
          notes: true,
          favorite: true,
        }),
      ),
    ).toBe(6);
    expect(activeFilterCount(filters({ format: [], read: [], index: [], source: [], notes: false }))).toBe(0);
  });

  it("builds one removable chip per selected value", () => {
    const chips = filterChips(
      filters({ format: ["pdf"], read: ["reading"], index: ["error"], source: ["s1", "upload"], notes: true }),
      sources,
    );
    expect(chips.map((chip) => chip.label)).toEqual(["PDF", "Reading", "Index error", "Fiction", "Added manually", "With notes"]);
    expect(chips.find((chip) => chip.key === "format:pdf")?.next.format).toEqual([]);
    expect(chips.find((chip) => chip.key === "source:s1")?.next.source).toEqual(["upload"]);
  });

  it("adds a removable Favorites chip and keeps it in the bulk filter", () => {
    const value = filters({ favorite: true, format: ["epub"] });
    const chips = filterChips(value, sources);
    expect(chips.find((chip) => chip.key === "favorite")).toEqual({
      key: "favorite",
      label: "Favorites",
      next: { ...value, favorite: false },
    });
    expect(selectionFilter("dune", value)).toEqual({ q: "dune", format: "epub", favorite: "1" });
  });

  it("falls back to the source id when labels are not loaded", () => {
    expect(sourceName("upload", sources)).toBe("Added manually");
    expect(sourceName("s1", sources)).toBe("Fiction");
    expect(sourceName("missing", sources)).toBe("missing");
  });
});
