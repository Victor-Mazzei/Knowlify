import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { METADATA_LIMITS } from "../../domain/library/BookMetadata.js";
import type { CustomCoverStore } from "../../ports/library-metadata.js";
import { sniffImage } from "../metadata/imageInfo.js";
import { encodeCoverJpeg } from "./coverEncoder.js";

export type CoverImageErrorCode = "invalid_image" | "dimensions_too_large";

/**
 * A rejected upload/download. The route maps `invalid_image` to 415 and
 * `dimensions_too_large` to 400, as frozen in the HTTP contract.
 */
export class CoverImageError extends Error {
  constructor(readonly code: CoverImageErrorCode, readonly status: 400 | 415, message: string) {
    super(message);
    this.name = "CoverImageError";
  }
}

const invalid = (message = "The image is not a supported JPEG, PNG or WebP"): never => {
  throw new CoverImageError("invalid_image", 415, message);
};

/**
 * Custom covers live under `covers/custom/<id>.jpg`, never in a library folder and never
 * next to the file-extracted cover (`covers/<id>.<ext>`). Every accepted image is
 * re-encoded to JPEG, which drops EXIF and any payload hidden after the image data.
 */
export class CustomCovers implements CustomCoverStore {
  constructor(private readonly coversDir: string) {}

  pathFor(bookId: string): string {
    return join(this.coversDir, "custom", `${bookId}.jpg`);
  }

  async save(bookId: string, data: Buffer): Promise<string> {
    const header = sniffImage(data);
    if (!header) return invalid();
    assertDimensions(header.width, header.height);
    // The child process re-checks dimensions and re-encodes; a decoder crash/timeout
    // never reaches this process (see coverEncoder.ts).
    const jpeg = await encodeCoverJpeg(data).catch(() => invalid());
    const path = this.pathFor(bookId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, jpeg, { mode: 0o600 });
    await rename(temporary, path);
    return path;
  }

  async remove(bookId: string): Promise<void> {
    await rm(this.pathFor(bookId), { force: true });
  }

  async move(fromBookId: string, toBookId: string): Promise<string | null> {
    const from = this.pathFor(fromBookId);
    const info = await stat(from).catch(() => null);
    if (!info?.isFile()) return null;
    const to = this.pathFor(toBookId);
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return to;
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    invalid();
  }
  if (width > METADATA_LIMITS.coverMaxSide || height > METADATA_LIMITS.coverMaxSide
    || width * height > METADATA_LIMITS.coverMaxPixels) {
    throw new CoverImageError("dimensions_too_large", 400, "The image dimensions are too large");
  }
}
