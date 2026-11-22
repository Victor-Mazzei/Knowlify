import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";

import type { Extracted } from "../../ports/index.js";
export type { Extracted } from "../../ports/index.js";

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (v && typeof v === "object" && "#text" in v) return text((v as Record<string, unknown>)["#text"]);
  return undefined;
};

export async function extractEpub(file: string): Promise<Extracted> {
  const zip = new AdmZip(file);
  const container = zip.getEntry("META-INF/container.xml");
  if (!container) return {};
  const rootfile = arr(xml.parse(container.getData().toString()).container?.rootfiles?.rootfile)[0];
  const opfPath: string | undefined = rootfile?.["@_full-path"];
  const opfEntry = opfPath && zip.getEntry(opfPath);
  if (!opfPath || !opfEntry) return {};
  const pkg = xml.parse(opfEntry.getData().toString()).package;
  const meta = pkg?.metadata ?? {};
  const out: Extracted = {
    title: text(arr(meta.title)[0]),
    author: arr(meta.creator).map(text).filter(Boolean).join(", ") || undefined,
  };

  const items = arr<Record<string, string>>(pkg?.manifest?.item);
  const coverId = arr<Record<string, string>>(meta.meta).find((m) => m["@_name"] === "cover")?.["@_content"];
  const item =
    items.find((i) => i["@_properties"]?.split(" ").includes("cover-image")) ??
    items.find((i) => i["@_id"] === coverId);
  if (item?.["@_href"]) {
    const entry = zip.getEntry(posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(item["@_href"]))));
    if (entry) out.cover = { data: entry.getData(), ext: item["@_media-type"] === "image/png" ? "png" : "jpg" };
  }
  return out;
}

const COVER_WIDTH = 480;

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

/**
 * Extracts the title/author from the PDF info dictionary and renders page 1 to a
 * JPEG. A single pdf.js document parse serves both; the previous pdf-lib parse
 * doubled the CPU cost of every PDF during a scan (ADR-B2).
 */
export async function extractPdf(file: string): Promise<Extracted> {
  const bytes = await readFile(file);
  const [{ getDocument }, { createCanvas }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("@napi-rs/canvas"),
  ]);
  // pdf.js 5 moved the image codecs (JPEG 2000, JBIG2, ICC) to wasm files next
  // to the package. Without the URL the wasm decoder never initializes and
  // pages that rely on those codecs lose their cover, which pdf.js 4 rendered.
  // The bundled standard fonts keep Base-14 covers independent of host fonts
  // (the slim Docker image installs none).
  const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const loading = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    standardFontDataUrl: `${join(pdfjsDir, "standard_fonts")}/`,
    wasmUrl: `${join(pdfjsDir, "wasm")}/`,
    verbosity: 0,
  });
  const doc = await loading.promise.catch(() => null);
  if (!doc) {
    // Metadata is optional: an unreadable PDF is still a valid library entry.
    await loading.destroy().catch(() => undefined);
    return {};
  }
  const out: Extracted = {};
  try {
    try {
      const metadata = await doc.getMetadata();
      const info = metadata.info as { Title?: unknown; Author?: unknown } | undefined;
      out.title = nonEmpty(info?.Title);
      out.author = nonEmpty(info?.Author);
    } catch {
      /* metadata is optional */
    }
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      out.cover = { data: canvas.toBuffer("image/jpeg", 80), ext: "jpg" };
    } catch {
      /* cover is optional */
    }
  } finally {
    await loading.destroy().catch(() => undefined);
  }
  return out;
}
