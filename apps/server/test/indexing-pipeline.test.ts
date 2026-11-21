import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EmbeddingsStatus, IngestBatch, IngestSink } from "../src/ports/knowledge.js";
import type { Embedder } from "../src/adapters/indexing/embed/Embedder.js";
import { IngestError } from "../src/adapters/indexing/errors.js";
import { EpubTextExtractor } from "../src/adapters/indexing/extract/EpubTextExtractor.js";
import { PdfTextExtractor } from "../src/adapters/indexing/extract/PdfTextExtractor.js";
import { htmlToText } from "../src/adapters/indexing/extract/htmlToText.js";
import { INGEST_BATCH_SIZE, LEXICAL_BATCH_SIZE, ingestFile, type ChunkFn } from "../src/adapters/indexing/pipeline.js";
import { NoEmbedder } from "../src/adapters/indexing/embed/NoEmbedder.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-indexing-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

interface Chapter {
  title: string;
  body: string;
}

async function writeEpub(name: string, chapters: Chapter[]): Promise<string> {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
  );
  const manifest = chapters
    .map((_, index) => `<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = chapters.map((_, index) => `<itemref idref="c${index}"/>`).join("");
  zip.addFile(
    "OEBPS/content.opf",
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><title>Fixture</title></metadata><manifest>${manifest}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spine}</spine></package>`,
    ),
  );
  zip.addFile(
    "OEBPS/nav.xhtml",
    Buffer.from(
      `<html><body><nav><ol>${chapters
        .map((chapter, index) => `<li><a href="c${index}.xhtml">${chapter.title}</a></li>`)
        .join("")}</ol></nav></body></html>`,
    ),
  );
  chapters.forEach((chapter, index) => {
    zip.addFile(
      `OEBPS/c${index}.xhtml`,
      Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title><style>.x{}</style></head><body><h1>${chapter.title}</h1>${chapter.body}</body></html>`,
      ),
    );
  });
  const path = join(root, name);
  await writeFile(path, zip.toBuffer());
  return path;
}

async function writePdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText("Ação, coração e não: acentos em português.", { x: 50, y: 780, size: 12, font });
  page.drawText("Second paragraph of the fixture.", { x: 50, y: 750, size: 12, font });
  const path = join(root, name);
  await writeFile(path, await pdf.save());
  return path;
}

async function writeBlankPdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const path = join(root, name);
  await writeFile(path, await pdf.save());
  return path;
}

function fakeEmbedder(options: { ready?: boolean; dimension?: number; failOn?: number } = {}) {
  const calls: string[][] = [];
  const status = (): EmbeddingsStatus => ({
    mode: "local",
    model: "fake",
    state: options.ready === false ? "unavailable" : "ready",
  });
  const embedder: Embedder = {
    id: "local:fake",
    status,
    prepare: async () => options.ready !== false,
    embedPassages: async (texts: string[]) => {
      calls.push(texts);
      if (options.ready === false) return null;
      if (options.failOn !== undefined && calls.length >= options.failOn) return null;
      const dimension = options.dimension ?? 3;
      return texts.map((_, index) => {
        const vector = new Float32Array(dimension);
        for (let offset = 0; offset < dimension; offset += 1) vector[offset] = index + offset + 1;
        return vector;
      });
    },
    embedQuery: async () => null,
    dispose: async () => {},
  };
  return { embedder, calls };
}

function collect() {
  const batches: IngestBatch[] = [];
  const starts: string[] = [];
  const progress: number[] = [];
  const sink: IngestSink = {
    onStart: (hash) => starts.push(hash),
    onBatch: async (batch) => {
      batches.push(batch);
    },
    onProgress: (fraction) => progress.push(fraction),
  };
  return { sink, batches, starts, progress };
}

/** Emits a fixed number of passages per section, bypassing the domain chunker. */
function fixedChunks(perSection: number): ChunkFn {
  return function* chunk(sections) {
    for (const section of sections) {
      for (let index = 0; index < perSection; index += 1) {
        yield { ordinal: 0, text: `${section.section ?? "page"}-${index}`, page: section.page, section: section.section };
      }
    }
  };
}

const job = (path: string, format: "pdf" | "epub", knownHash: string | null = null, indexVersion = "1|http:m") => ({
  bookId: "book",
  path,
  format,
  knownHash,
  indexVersion,
});

let pdfPath = "";
let blankPdfPath = "";
let epubPath = "";
beforeAll(async () => {
  [pdfPath, blankPdfPath, epubPath] = await Promise.all([writePdf("book.pdf"), writeBlankPdf("blank.pdf"), writeEpub("book.epub", [
    { title: "Capítulo 1", body: '<p>Ação e coração &amp; não.</p><script>bad()</script><p>Outro parágrafo.</p>' },
    { title: "Chapter 2", body: "<p>Second chapter text.</p>" },
  ])]);
});

describe("text extraction", () => {
  it("reads PDF pages with accents and page numbers", async () => {
    const sections = [];
    for await (const section of new PdfTextExtractor().extract(pdfPath)) sections.push(section);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ page: 1, section: null });
    expect(sections[0].text).toContain("Ação, coração e não");
    expect(sections[0].text).toContain("Second paragraph");
  });

  it("reads EPUB chapters in spine order, decoding entities and dropping scripts", async () => {
    const sections = [];
    for await (const section of new EpubTextExtractor().extract(epubPath)) sections.push(section);
    expect(sections.map((section) => section.section)).toEqual(["Capítulo 1", "Chapter 2"]);
    expect(sections[0].page).toBeNull();
    expect(sections[0].text).toContain("Ação e coração & não.");
    expect(sections[0].text).not.toContain("bad()");
    expect(sections[0].text).toContain("Outro parágrafo.");
  });

  it("keeps plain text safe and readable", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b></p><script>alert(1)</script><p>&#233; &#x41;</p>"))
      .toBe("Hello world\n\né A");
  });
});

describe("ingestion pipeline", () => {
  it("defers the hash on a first indexing and streams 32-passage batches", async () => {
    const path = await writeEpub("long.epub", [
      { title: "One", body: "<p>alpha</p>" },
      { title: "Two", body: "<p>beta</p>" },
    ]);
    const { embedder, calls } = fakeEmbedder();
    const { sink, batches, starts, progress } = collect();
    const outcome = await ingestFile(job(path, "epub"), sink, { extractor: new EpubTextExtractor(), embedder, chunk: fixedChunks(20) });

    expect(outcome).toMatchObject({
      kind: "done",
      chunkCount: 40,
      indexVersion: "1|http:m",
      contentHash: createHash("sha256").update(await readFile(path)).digest("hex"),
    });
    // No known hash: the file is not read for hashing before extraction.
    expect(starts).toEqual([null]);
    expect(batches.map((batch) => batch.passages.length)).toEqual([INGEST_BATCH_SIZE, 8]);
    expect(batches.flatMap((batch) => batch.passages.map((passage) => passage.ordinal))).toEqual(
      Array.from({ length: 40 }, (_, index) => index),
    );
    expect(calls.map((batch) => batch.length)).toEqual([32, 8]);
    expect(batches[1].vectors).toHaveLength(8);
    expect(progress).toEqual([0.5, 1]);
  });

  it("uses 128-passage batches and the lexical version on the lexical tier", async () => {
    const path = await writeEpub("lexical.epub", [{ title: "One", body: "<p>alpha</p>" }]);
    const { sink, batches, starts } = collect();
    const outcome = await ingestFile(job(path, "epub", null, "1|lexical"), sink, {
      extractor: new EpubTextExtractor(),
      embedder: new NoEmbedder(),
      chunk: fixedChunks(200),
    });

    expect(outcome).toMatchObject({ kind: "done", chunkCount: 200, indexVersion: "1|lexical" });
    expect(starts).toEqual([null]);
    expect(batches.map((batch) => batch.passages.length)).toEqual([LEXICAL_BATCH_SIZE, 200 - LEXICAL_BATCH_SIZE]);
    expect(batches.every((batch) => batch.vectors === null)).toBe(true);
  });

  it("hashes before extracting when a known hash can short-circuit the job", async () => {
    const hash = createHash("sha256").update(await readFile(epubPath)).digest("hex");
    const { embedder, calls } = fakeEmbedder();
    const { sink, starts } = collect();
    const outcome = await ingestFile(job(epubPath, "epub", "stale-hash"), sink, { extractor: new EpubTextExtractor(), embedder });
    expect(outcome).toMatchObject({ kind: "done", contentHash: hash });
    expect(starts).toEqual([hash]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("skips the whole job when the hash is unchanged", async () => {
    const hash = createHash("sha256").update(await readFile(epubPath)).digest("hex");
    const { embedder, calls } = fakeEmbedder();
    const { sink, batches, starts } = collect();
    const outcome = await ingestFile(job(epubPath, "epub", hash), sink, { extractor: new EpubTextExtractor(), embedder });
    expect(outcome).toEqual({ kind: "unchanged", contentHash: hash, indexVersion: "1|http:m" });
    expect(calls).toHaveLength(0);
    expect(starts).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it("falls back to lexical batches when embeddings are unavailable", async () => {
    const { embedder } = fakeEmbedder({ ready: false });
    const { sink, batches } = collect();
    const outcome = await ingestFile(job(epubPath, "epub"), sink, { extractor: new EpubTextExtractor(), embedder, chunk: fixedChunks(5) });
    expect(outcome).toMatchObject({ kind: "done", chunkCount: 10, indexVersion: "1|none" });
    expect(batches.every((batch) => batch.vectors === null)).toBe(true);
  });

  it("keeps indexing when the embedder fails midway", async () => {
    const { embedder } = fakeEmbedder({ failOn: 2 });
    const { sink, batches } = collect();
    const outcome = await ingestFile(job(epubPath, "epub"), sink, { extractor: new EpubTextExtractor(), embedder, chunk: fixedChunks(20) });
    expect(outcome).toMatchObject({ kind: "done", chunkCount: 40, indexVersion: "1|none" });
    expect(batches[0].vectors).not.toBeNull();
    expect(batches[1].vectors).toBeNull();
  });

  it("reports no text for a PDF without a text layer", async () => {
    const { embedder } = fakeEmbedder();
    const { sink } = collect();
    await expect(
      ingestFile(job(blankPdfPath, "pdf"), sink, { extractor: new PdfTextExtractor(), embedder }),
    ).rejects.toMatchObject({ code: "no_text" });
  });

  it("rejects oversized and missing files before touching the sink", async () => {
    const { embedder } = fakeEmbedder();
    const { sink, starts } = collect();
    await expect(
      ingestFile(job(pdfPath, "pdf"), sink, { extractor: new PdfTextExtractor(), embedder, maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      ingestFile(job(join(root, "missing.epub"), "epub"), sink, { extractor: new EpubTextExtractor(), embedder }),
    ).rejects.toBeInstanceOf(IngestError);
    await expect(
      ingestFile(job(join(root, "missing.epub"), "epub"), sink, { extractor: new EpubTextExtractor(), embedder }),
    ).rejects.toMatchObject({ code: "unreadable" });
    expect(starts).toHaveLength(0);
  });

  it("turns extractor crashes into a classified failure", async () => {
    const { embedder } = fakeEmbedder();
    const { sink } = collect();
    const broken = { extract: async function* () { throw new Error("boom"); } };
    await expect(ingestFile(job(epubPath, "epub"), sink, { extractor: broken, embedder })).rejects.toMatchObject({
      code: "unknown",
      message: "boom",
    });
  });

  it("classifies corrupt books as unreadable instead of unknown", async () => {
    const brokenEpub = join(root, "broken.epub");
    const brokenPdf = join(root, "broken.pdf");
    await writeFile(brokenEpub, Buffer.from("this is not a zip archive"));
    await writeFile(brokenPdf, Buffer.from("%PDF-1.4\nnot a real document"));
    const { embedder } = fakeEmbedder();
    const { sink } = collect();
    await expect(
      ingestFile(job(brokenEpub, "epub"), sink, { extractor: new EpubTextExtractor(), embedder }),
    ).rejects.toMatchObject({ code: "unreadable" });
    await expect(
      ingestFile(job(brokenPdf, "pdf"), sink, { extractor: new PdfTextExtractor(), embedder }),
    ).rejects.toMatchObject({ code: "unreadable" });
  });
});
