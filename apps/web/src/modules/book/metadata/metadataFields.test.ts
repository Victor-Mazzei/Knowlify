import { describe, expect, it } from "vitest";
import type { MetadataField } from "../types";
import { noOverrides, sampleBookDetail } from "./mockMetadataBook";
import {
  draftFromMetadata,
  fieldOrigin,
  originLabel,
  patchFromDraft,
  validateDraft,
} from "./metadataFields";

const metadata = () => sampleBookDetail().metadata;

describe("metadata form fields", () => {
  it("starts the draft from the effective values", () => {
    const draft = draftFromMetadata({
      ...metadata(),
      year: 2005,
      series: "Cycles",
      seriesIndex: 2,
    });
    expect(draft.title).toBe("The Quiet Library");
    expect(draft.year).toBe("2005");
    expect(draft.seriesIndex).toBe("2");
    expect(draft.isbn13).toBe("");
  });

  it("mirrors the server limits and checksums", () => {
    const draft = draftFromMetadata(metadata());
    expect(validateDraft({ ...draft, title: " " })).toMatchObject({ title: "Title is required." });
    expect(validateDraft({ ...draft, isbn10: "0306406153" })).toHaveProperty(
      "isbn10",
      expect.stringContaining("check digit"),
    );
    expect(validateDraft({ ...draft, isbn13: "9780306406157" })).not.toHaveProperty("isbn13");
    expect(validateDraft({ ...draft, year: "3000" }, new Date("2026-01-01"))).toHaveProperty("year");
    expect(validateDraft({ ...draft, language: "english!" })).toHaveProperty("language");
    expect(validateDraft({ ...draft, seriesIndex: "2" })).toHaveProperty("seriesIndex");
    expect(validateDraft({ ...draft, description: "x".repeat(5001) })).toHaveProperty("description");
  });

  it("does not validate values staged for reset", () => {
    const draft = draftFromMetadata(metadata());
    const cleared = new Set<MetadataField>(["title", "isbn13"]);
    expect(validateDraft({ ...draft, title: "", isbn13: "broken" }, new Date(), cleared)).toEqual({});
  });

  it("sends only changed fields and never sends an untouched override", () => {
    const base = metadata();
    const draft = draftFromMetadata(base);
    draft.title = "A new title";
    draft.publisher = "  New Press ";
    draft.year = "2005";
    draft.series = "Cycles";
    draft.seriesIndex = "1.5";
    expect(patchFromDraft(draft, base, new Set())).toEqual({
      title: "A new title",
      publisher: "New Press",
      year: 2005,
      series: "Cycles",
      seriesIndex: 1.5,
      source: "manual",
    });
    expect(patchFromDraft(draftFromMetadata(base), base, new Set())).toEqual({});
  });

  it("sends null to clear an existing override and keeps author empty as an override", () => {
    const empty = noOverrides();
    const base = sampleBookDetail(
      {},
      {
        title: "Edited",
        author: "Edited Author",
        overridden: { ...empty, title: true, author: true },
        file: { title: "File title", author: "File author" },
      },
    ).metadata;
    const draft = draftFromMetadata(base);
    draft.author = "";
    expect(patchFromDraft(draft, base, new Set())).toEqual({ author: "", source: "manual" });
    expect(patchFromDraft(draft, base, new Set<MetadataField>(["title"]))).toEqual({
      title: null,
      author: "",
      source: "manual",
    });
  });

  it("labels persisted and staged values", () => {
    const empty = noOverrides();
    const base = sampleBookDetail(
      {},
      {
        title: "Edited",
        overridden: { ...empty, title: true, publisher: true },
        file: { title: "File title", author: "Ada North" },
        publisher: "Press",
      },
    ).metadata;
    const draft = draftFromMetadata(base);
    expect(originLabel(fieldOrigin("title", draft, base, new Set()))).toBe("Edited");
    expect(originLabel(fieldOrigin("author", draft, base, new Set()))).toBe("From file");
    expect(originLabel(fieldOrigin("publisher", draft, base, new Set()))).toBe("Edited");
    expect(originLabel(fieldOrigin("language", draft, base, new Set()))).toBe("Not set");
    expect(originLabel(fieldOrigin("title", draft, base, new Set<MetadataField>(["title"])))).toBe("From file");
    draft.seriesIndex = "2";
    expect(originLabel(fieldOrigin("seriesIndex", draft, base, new Set()))).toBe("Edited");
  });
});
