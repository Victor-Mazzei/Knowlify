import type { Book } from "../../types";
import type { DuplicateBook, DuplicateGroup, DuplicatesSummary } from "./types";

const BASE_ADDED = 1_760_000_000_000;
const HASH = "a".repeat(64);

export const MOCK_CANONICAL_BOOK: Book = {
  id: "mock-duplicate-canonical",
  title: "The Left Hand of Darkness",
  author: "Ursula K. Le Guin",
  format: "epub",
  size: 1_800_000,
  addedAt: BASE_ADDED,
  hasCover: false,
  status: "ready",
  source: false,
  index: { state: "ready", error: null },
  progress: null,
};

function book(
  id: string,
  title: string,
  path: string,
  sourceId: string | null,
  sourceLabel: string,
  overrides: Partial<DuplicateBook> = {},
): DuplicateBook {
  return {
    id,
    title,
    author: "Ursula K. Le Guin",
    format: "epub",
    path,
    sourceId,
    sourceLabel,
    addedAt: BASE_ADDED,
    canonical: false,
    hasNotes: false,
    hasProgress: false,
    indexed: false,
    ...overrides,
  };
}

export function seedDuplicateGroups(): DuplicateGroup[] {
  return [
    {
      key: `1800000:${HASH}`,
      size: 1_800_000,
      contentHash: HASH,
      canonicalId: "dup-lh-1",
      books: [
        book("dup-lh-1", "The Left Hand of Darkness", "/library/Fiction/left-hand.epub", "source-fiction", "Fiction", {
          canonical: true,
          hasNotes: true,
          indexed: true,
          addedAt: BASE_ADDED - 90_000,
        }),
        book("dup-lh-2", "The Left Hand of Darkness", "/data/books/left-hand-copy.epub", null, "Added manually", {
          hasProgress: true,
        }),
      ],
      aliases: ["/library/Fiction/left-hand-old-copy.epub"],
    },
    {
      key: `4200000:${HASH}`,
      size: 4_200_000,
      contentHash: HASH,
      canonicalId: "dup-dune-1",
      books: [
        book("dup-dune-1", "Dune", "/library/Reference/dune.pdf", "source-reference", "Reference", {
          format: "pdf",
          canonical: true,
          hasNotes: true,
          hasProgress: true,
          indexed: true,
          addedAt: BASE_ADDED - 120_000,
        }),
        book("dup-dune-2", "Dune", "/data/books/dune.pdf", null, "Added manually", { format: "pdf" }),
        book("dup-dune-3", "Dune", "/library/Fiction/dune.pdf", "source-fiction", "Fiction", {
          format: "pdf",
          hasProgress: true,
        }),
      ],
      aliases: [],
    },
    {
      key: `2400000:${HASH}`,
      size: 2_400_000,
      contentHash: HASH,
      canonicalId: "dup-pir-1",
      books: [
        book("dup-pir-1", "Piranesi", "/library/Fiction/piranesi.epub", "source-fiction", "Fiction", {
          canonical: true,
          hasProgress: true,
          indexed: true,
          addedAt: BASE_ADDED - 60_000,
        }),
        book("dup-pir-2", "Piranesi", "/library/Reference/piranesi.epub", "source-reference", "Reference", {
          hasNotes: true,
        }),
      ],
      aliases: [],
    },
  ];
}

/**
 * Deterministic, varied groups for large-library tests. Every fifth group has
 * three copies, so merge totals cannot be inferred from the group count alone.
 */
export function manyDuplicateGroups(count: number): DuplicateGroup[] {
  return Array.from({ length: count }, (_, index) => {
    const size = 1_000_000 + index;
    const contentHash = index.toString(16).padStart(64, "0");
    const copies = 2 + (index % 5 === 0 ? 1 : 0);
    const canonicalId = `many-${index}-0`;
    const books = Array.from({ length: copies }, (_, copy) =>
      book(
        `many-${index}-${copy}`,
        `Book ${index + 1}`,
        copy === 0 ? `/library/many/book-${index}.epub` : `/data/books/book-${index}-${copy}.epub`,
        copy === 0 ? "source-many" : null,
        copy === 0 ? "Library" : "Added manually",
        {
          canonical: copy === 0,
          hasNotes: copy > 0 && (index + copy) % 7 === 0,
          hasProgress: copy > 0 && (index + copy) % 11 === 0,
          indexed: copy > 0 && (index + copy) % 3 === 0,
          addedAt: BASE_ADDED - index * 1_000 - copy,
        },
      ),
    );
    return { key: `${size}:${contentHash}`, size, contentHash, canonicalId, books, aliases: [] };
  });
}

export const duplicateGroupBytes = (group: DuplicateGroup) =>
  Math.round(group.size * 0.6 * Math.max(0, group.books.length - 1));

export function mockDuplicatesSummary(groups: DuplicateGroup[]): DuplicatesSummary {
  return {
    groups: groups.length,
    redundantBooks: groups.reduce((total, group) => total + Math.max(0, group.books.length - 1), 0),
    reclaimableBytes: groups.reduce((total, group) => total + duplicateGroupBytes(group), 0),
  };
}
