import type { Options } from "react-markdown";
import type { Citation, RecommendedBook } from "../types";

type RemarkPlugin = NonNullable<Options["remarkPlugins"]>[number];

/**
 * Minimal mdast shape: the plugins only touch `text` nodes and link children,
 * so they do not need the full unist type surface.
 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, string | number> };
  children?: MdNode[];
};

export type MarkerKind = "citation" | "book";

/** Properties that only this plugin adds; the renderer trusts nothing else. */
export const MARKER_KIND_PROPERTY = "data-knowlify-marker";
export const MARKER_NUMBER_PROPERTY = "data-knowlify-marker-n";

const MARKER = /(\[\d+\]|\[book:\d+\])/g;
const CITATION = /^\[(\d+)\]$/;
const BOOK = /^\[book:(\d+)\]$/;
const CITATION_HREF = "#knowlify-cite-";
const BOOK_HREF = "#knowlify-book-";

const textNode = (value: string): MdNode => ({ type: "text", value });
const markerLink = (kind: MarkerKind, number: number, value: string): MdNode => ({
  type: "link",
  url: `${kind === "citation" ? CITATION_HREF : BOOK_HREF}${number}`,
  data: {
    hProperties: {
      [MARKER_KIND_PROPERTY]: kind,
      [MARKER_NUMBER_PROPERTY]: number,
    },
  },
  children: [textNode(value)],
});

/**
 * Turns `[n]` and `[book:n]` into links that the renderer swaps for chips.
 * These links carry the marker properties below; the renderer trusts those
 * properties and never a link href, so a model-written Markdown link cannot
 * forge a chip by copying a marker URL. Markers inside code, links and images
 * stay untouched; an unknown citation stays literal and an unknown book marker
 * disappears, matching the old plain-text renderer. Doing this in the AST keeps
 * chips working inside lists, emphasis and table cells.
 */
export function createMarkerPlugin(
  citations: Citation[] | null,
  books: RecommendedBook[] | undefined,
): RemarkPlugin {
  const knownCitations = new Set((citations ?? []).map((citation) => citation.n));
  const knownBooks = new Set((books ?? []).map((book) => book.n));

  return () => (tree) => {
    const visit = (node: MdNode, blocked: boolean) => {
      if (!node.children) return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && !blocked) {
          const value = child.value ?? "";
          for (const part of value.split(MARKER)) {
            if (!part) continue;
            const citation = CITATION.exec(part);
            if (citation) {
              const number = Number(citation[1]);
              next.push(
                knownCitations.has(number)
                  ? markerLink("citation", number, part)
                  : textNode(part),
              );
              continue;
            }
            const book = BOOK.exec(part);
            if (book) {
              const number = Number(book[1]);
              if (knownBooks.has(number)) next.push(markerLink("book", number, part));
              continue;
            }
            next.push(textNode(part));
          }
          continue;
        }

        const nestedBlocked =
          blocked ||
          child.type === "code" ||
          child.type === "inlineCode" ||
          child.type === "html" ||
          child.type === "link" ||
          child.type === "image";
        visit(child, nestedBlocked);
        next.push(child);
      }
      node.children = next;
    };

    visit(tree as unknown as MdNode, false);
  };
}

/**
 * A single newline in a chat answer means a line break, not a space. Markdown
 * soft breaks are text nodes containing `\n`; converting them to `break` nodes
 * keeps the previous `white-space: pre-wrap` behavior in formatted output.
 */
export const remarkSoftBreaks: RemarkPlugin = () => (tree) => {
  const visit = (node: MdNode, blocked: boolean) => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && !blocked && (child.value ?? "").includes("\n")) {
        const lines = (child.value ?? "").split("\n");
        lines.forEach((line, index) => {
          if (index > 0) next.push({ type: "break" });
          if (line) next.push(textNode(line));
        });
        continue;
      }
      const nestedBlocked =
        blocked || child.type === "code" || child.type === "inlineCode" || child.type === "html";
      visit(child, nestedBlocked);
      next.push(child);
    }
    node.children = next;
  };

  visit(tree as unknown as MdNode, false);
};
