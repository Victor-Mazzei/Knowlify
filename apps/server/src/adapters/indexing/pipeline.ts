import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { chunkSections, toLexicalVersion, type Passage, type TextSection } from "../../domain/knowledge/BookIndex.js";
import type { IngestJob, IngestOutcome, IngestSink } from "../../ports/knowledge.js";
import type { Embedder } from "./embed/Embedder.js";
import { IngestError } from "./errors.js";
import type { TextExtractor } from "./extract/types.js";

export const PIPELINE_VERSION = "1";
/** Passages per sink write and per embedding request. */
export const INGEST_BATCH_SIZE = 32;
/** Larger batches for the lexical tier: no embedding request bounds the write size. */
export const LEXICAL_BATCH_SIZE = 128;
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export type ChunkFn = (
  sections: Iterable<TextSection>,
  options?: { size?: number; overlap?: number },
) => Iterable<Passage>;

/**
 * Minimal word-window chunker. The domain owns the real `chunkSections`
 * policy; this exists only as an explicit seam for worker tests that must not
 * depend on another track's implementation (see `ThreadIngestionRunnerOptions.chunking`).
 */
export function* paragraphChunks(sections: Iterable<TextSection>): Iterable<Passage> {
  const max = 1_000;
  for (const section of sections) {
    let buffer = "";
    for (const word of section.text.split(/\s+/)) {
      if (!word) continue;
      if (buffer && buffer.length + word.length + 1 > max) {
        yield { ordinal: 0, text: buffer, page: section.page, section: section.section };
        buffer = "";
      }
      buffer = buffer ? `${buffer} ${word}` : word;
    }
    if (buffer) yield { ordinal: 0, text: buffer, page: section.page, section: section.section };
  }
}

export interface IngestionDeps {
  extractor: TextExtractor;
  embedder: Embedder;
  /** Defaults to the domain `chunkSections`; injected by tests. */
  chunk?: ChunkFn;
  maxBytes?: number;
  /** Defaults to 32 with vectors and 128 on the lexical tier. */
  batchSize?: number;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Ingests one book: streams sections through the chunker, embeds passages when vectors are in
 * play and hands the batches to the sink. The hash is only computed up-front when a previous
 * hash can short-circuit the job (`knownHash`); a first indexing hashes after extracting, so a
 * failed extraction never pays for an extra full read. The worker picks the extractor for the
 * job format before calling this function.
 */
export async function ingestFile(job: IngestJob, sink: IngestSink, deps: IngestionDeps): Promise<IngestOutcome> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const info = await stat(job.path).catch(() => undefined);
  if (!info?.isFile()) throw new IngestError("unreadable", "Book file is not readable");
  if (info.size > maxBytes) {
    throw new IngestError("too_large", `Book is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB indexing limit`);
  }

  let contentHash: string | null = null;
  if (job.knownHash !== null) {
    try {
      contentHash = await hashFile(job.path);
    } catch {
      throw new IngestError("unreadable", "Book file is not readable");
    }
    if (contentHash === job.knownHash) {
      return { kind: "unchanged", contentHash, indexVersion: job.indexVersion };
    }
  }

  sink.onStart(contentHash);
  const lexical = deps.embedder.id === "none";
  const embeddings = lexical ? false : await deps.embedder.prepare();
  // The index version must describe what was actually written: if the provider
  // is already down or fails in any batch, the book cannot claim vectors.
  let degraded = !lexical && !embeddings;
  const chunk = deps.chunk ?? chunkSections;
  const batchSize = deps.batchSize ?? (lexical ? LEXICAL_BATCH_SIZE : INGEST_BATCH_SIZE);
  let ordinal = 0;
  let chunkCount = 0;
  let pending: Passage[] = [];

  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const vectors = embeddings ? await deps.embedder.embedPassages(batch.map((passage) => passage.text)) : null;
    if (vectors === null && !lexical) degraded = true;
    await sink.onBatch({ passages: batch, vectors });
    chunkCount += batch.length;
  };

  try {
    for await (const section of deps.extractor.extract(job.path, { onProgress: (fraction) => sink.onProgress(fraction) })) {
      for (const passage of chunk([section])) {
        pending.push({ ...passage, ordinal: ordinal++ });
        if (pending.length >= batchSize) await flush();
      }
    }
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError("unknown", error instanceof Error ? error.message : "Unexpected extraction error");
  }
  await flush();

  if (chunkCount === 0) throw new IngestError("no_text", "No extractable text was found");
  if (contentHash === null) {
    try {
      contentHash = await hashFile(job.path);
    } catch {
      throw new IngestError("unreadable", "Book file is not readable");
    }
  }
  return {
    kind: "done",
    contentHash,
    chunkCount,
    indexVersion: lexical ? toLexicalVersion(job.indexVersion) : degraded ? `${PIPELINE_VERSION}|none` : job.indexVersion,
  };
}
