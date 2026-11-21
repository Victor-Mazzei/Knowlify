import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { posix } from "node:path";

import type { TextSection } from "../../../domain/knowledge/BookIndex.js";
import { IngestError } from "../errors.js";
import { htmlToText } from "./htmlToText.js";
import type { ExtractOptions, TextExtractor } from "./types.js";

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const HTML_TYPES = new Set(["application/xhtml+xml", "text/html"]);

const arr = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  const record = asRecord(value);
  if (record && "#text" in record) return textOf(record["#text"]);
  return undefined;
}

/** Resolves a manifest href inside the archive, refusing paths that escape it. */
function resolveEntry(base: string, href: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#")[0]);
  } catch {
    return null;
  }
  if (!decoded) return null;
  const path = posix.normalize(posix.join(base, decoded));
  return path.startsWith("../") || path === ".." ? null : path;
}

function collectNavTitles(zip: AdmZip, base: string, href: string, titles: Map<string, string>): void {
  const entryPath = resolveEntry(base, href);
  const entry = entryPath ? zip.getEntry(entryPath) : undefined;
  if (!entry || !entryPath) return;
  const source = entry.getData().toString("utf8");
  const anchors = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(source))) {
    const target = resolveEntry(posix.dirname(entryPath), match[1] ?? match[2] ?? "");
    const title = htmlToText(match[3]).split("\n")[0];
    if (target && title && !titles.has(target)) titles.set(target, title);
  }
}

function collectNcxTitles(zip: AdmZip, base: string, href: string, titles: Map<string, string>): void {
  const entryPath = resolveEntry(base, href);
  const entry = entryPath ? zip.getEntry(entryPath) : undefined;
  if (!entry) return;
  const parsed = xml.parse(entry.getData().toString("utf8"));
  const walk = (points: unknown): void => {
    for (const point of arr<unknown>(points)) {
      const record = asRecord(point);
      if (!record) continue;
      const target = asRecord(record.content)?.["@_src"];
      const title = textOf(asRecord(record.navLabel)?.text);
      if (typeof target === "string" && title) {
        const resolved = resolveEntry(base, target);
        if (resolved && !titles.has(resolved)) titles.set(resolved, title);
      }
      walk(record.navPoint);
    }
  };
  walk(asRecord(parsed)?.ncx ? asRecord(asRecord(parsed)?.ncx)?.navMap : undefined);
}

interface SpineItem {
  path: string;
  title: string | null;
}

function readSpine(zip: AdmZip): SpineItem[] {
  const containerEntry = zip.getEntry("META-INF/container.xml");
  if (!containerEntry) throw new IngestError("unreadable", "Invalid EPUB: missing container.xml");
  const container = asRecord(xml.parse(containerEntry.getData().toString("utf8")));
  const rootfile = arr<unknown>(asRecord(asRecord(container?.container)?.rootfiles)?.rootfile)
    .map(asRecord)
    .find((item) => typeof item?.["@_full-path"] === "string");
  const opfPath = rootfile?.["@_full-path"];
  const opfEntry = typeof opfPath === "string" ? zip.getEntry(opfPath) : undefined;
  if (typeof opfPath !== "string" || !opfEntry) throw new IngestError("unreadable", "Invalid EPUB: missing package document");

  const base = posix.dirname(opfPath);
  const pkg = asRecord(asRecord(xml.parse(opfEntry.getData().toString("utf8")))?.package);
  const manifest = new Map<string, Record<string, unknown>>();
  for (const item of arr<unknown>(asRecord(pkg?.manifest)?.item).map(asRecord)) {
    const id = item?.["@_id"];
    if (typeof id === "string" && item) manifest.set(id, item);
  }

  const titles = new Map<string, string>();
  const navigation = [...manifest.values()].find((item) =>
    typeof item["@_properties"] === "string" && item["@_properties"].split(/\s+/).includes("nav"));
  if (navigation && typeof navigation["@_href"] === "string") collectNavTitles(zip, base, navigation["@_href"], titles);
  if (!titles.size) {
    const tocId = asRecord(pkg?.spine)?.["@_toc"];
    const ncx = typeof tocId === "string" ? manifest.get(tocId) : undefined;
    if (ncx && typeof ncx["@_href"] === "string") collectNcxTitles(zip, base, ncx["@_href"], titles);
  }

  const spine: SpineItem[] = [];
  for (const itemref of arr<unknown>(asRecord(pkg?.spine)?.itemref).map(asRecord)) {
    const idref = itemref?.["@_idref"];
    if (typeof idref !== "string") continue;
    const item = manifest.get(idref);
    if (!item) continue;
    const href = item["@_href"];
    if (typeof href !== "string") continue;
    const type = typeof item["@_media-type"] === "string" ? item["@_media-type"] : "";
    const path = resolveEntry(base, href);
    if (!path) continue;
    if (type && !HTML_TYPES.has(type) && !/\.x?html?$/i.test(path)) continue;
    spine.push({ path, title: titles.get(path) ?? posix.basename(path, posix.extname(path)) });
  }
  return spine;
}

/**
 * Extracts one text section per spine entry, in reading order. The archive is
 * only read; nothing is ever written next to the book.
 */
export class EpubTextExtractor implements TextExtractor {
  async *extract(path: string, options: ExtractOptions = {}): AsyncIterable<TextSection> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(path);
    } catch {
      throw new IngestError("unreadable", "Invalid or unreadable EPUB");
    }
    let spine: SpineItem[];
    try {
      spine = readSpine(zip);
    } catch (error) {
      if (error instanceof IngestError) throw error;
      throw new IngestError("unreadable", "Invalid or unreadable EPUB");
    }
    let totalBytes = 0;
    for (let index = 0; index < spine.length; index += 1) {
      const item = spine[index];
      const entry = zip.getEntry(item.path);
      if (!entry) continue;
      const size = entry.header.size;
      totalBytes += size;
      if (size > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES) {
        throw new IngestError("too_large", "EPUB expands beyond the indexing limit");
      }
      let text: string;
      try {
        text = htmlToText(entry.getData().toString("utf8"));
      } catch {
        throw new IngestError("unreadable", "Invalid or unreadable EPUB");
      }
      if (text) yield { text, page: null, section: item.title };
      options.onProgress?.((index + 1) / spine.length);
    }
  }
}
