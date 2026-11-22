import { readFile } from "node:fs/promises";

import type { TextSection } from "../../../domain/knowledge/BookIndex.js";
import { IngestError } from "../errors.js";
import type { ExtractOptions, TextExtractor } from "./types.js";

interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

interface Line {
  y: number;
  items: PdfTextItem[];
}

function isTextItem(value: unknown): value is PdfTextItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { str?: unknown; transform?: unknown };
  return typeof item.str === "string" && Array.isArray(item.transform);
}

function lineText(items: PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.transform[4] - b.transform[4]);
  let text = "";
  let previousEnd: number | null = null;
  let previousSize = 10;
  for (const item of sorted) {
    const raw = item.str;
    if (!raw) continue;
    const x = item.transform[4];
    const size = item.height || Math.abs(item.transform[3]) || previousSize;
    if (text && previousEnd !== null && !/\s$/.test(text) && !/^\s/.test(raw) && x - previousEnd > size * 0.2) {
      text += " ";
    }
    text += raw;
    previousEnd = x + (item.width ?? 0);
    previousSize = size;
  }
  return text.replace(/[ \t]+/g, " ").trim();
}

/** Groups positioned text items into lines, keeping paragraphs apart. */
function pageText(values: unknown[]): string {
  const lines = new Map<number, Line>();
  for (const value of values) {
    if (!isTextItem(value) || !value.str) continue;
    const y = Math.round(value.transform[5] * 2) / 2;
    const line = lines.get(y);
    if (line) line.items.push(value);
    else lines.set(y, { y, items: [value] });
  }
  const ordered = [...lines.values()].sort((a, b) => b.y - a.y);
  const gaps = ordered.slice(1).map((line, index) => ordered[index].y - line.y).filter((gap) => gap > 0);
  const median = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  let out = "";
  for (let index = 0; index < ordered.length; index += 1) {
    const text = lineText(ordered[index].items);
    if (!text) continue;
    if (out) {
      const gap = ordered[index - 1].y - ordered[index].y;
      out += median > 0 && gap > median * 1.6 ? "\n\n" : "\n";
    }
    out += text;
  }
  return out;
}

/**
 * Extracts text page by page with pdf.js. Pages are released as soon as they
 * have been read so a large book never holds every page object in memory.
 */
export class PdfTextExtractor implements TextExtractor {
  async *extract(path: string, options: ExtractOptions = {}): AsyncIterable<TextSection> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      throw new IngestError("unreadable", "Book file is not readable");
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: bytes,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    let document: Awaited<typeof loading.promise>;
    try {
      document = await loading.promise;
    } catch {
      await loading.destroy().catch(() => undefined);
      throw new IngestError("unreadable", "Invalid or unreadable PDF");
    }
    try {
      const total = document.numPages || 1;
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          const text = pageText(content.items as unknown[]);
          if (text) yield { text, page: number, section: null };
        } finally {
          page.cleanup();
        }
        options.onProgress?.(number / total);
      }
    } catch (error) {
      if (error instanceof IngestError) throw error;
      throw new IngestError("unreadable", "Invalid or unreadable PDF");
    } finally {
      await loading.destroy();
    }
  }
}
