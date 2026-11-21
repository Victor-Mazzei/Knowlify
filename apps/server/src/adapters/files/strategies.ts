import type { Book, MetadataExtractor } from "../../ports/index.js";
import { extractEpub, extractPdf } from "./metadata.js";
import { WorkerPoolMetadataExtractor } from "./WorkerPoolMetadataExtractor.js";
export class EpubMetadataExtractor implements MetadataExtractor { extract(path: string) { return extractEpub(path); } }
export class PdfMetadataExtractor implements MetadataExtractor { extract(path: string) { return extractPdf(path); } }

export interface MetadataExtractors extends Record<Book["format"], MetadataExtractor> {
  close(): Promise<void>;
}

export interface CreateMetadataExtractorsOptions {
  /** Tests and hosts without worker support run the reference extractors in-process. */
  inline?: boolean;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Builds the format-keyed extractor map used by the scanner and uploads. A single
 * pool serves both formats; the facades only pin the format for the worker task.
 */
export function createMetadataExtractors(workers: number, options: CreateMetadataExtractorsOptions = {}): MetadataExtractors {
  if (options.inline || workers < 1) {
    return { epub: new EpubMetadataExtractor(), pdf: new PdfMetadataExtractor(), close: async () => {} };
  }
  const pool = new WorkerPoolMetadataExtractor({ workers, log: options.log });
  return {
    epub: pool.forFormat("epub"),
    pdf: pool.forFormat("pdf"),
    close: () => pool.close(),
  };
}
