import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const THUMB_WIDTH = 240;
const THUMB_QUALITY = 75;
const CONCURRENCY = 2;

const statOrNull = async (path: string) => stat(path).then((value) => value, () => null);

/**
 * On-demand cover thumbnails (ADR-A4). Generation is limited to two images at a time
 * because JPEG decode/encode is synchronous once it starts and covers arrive in bursts.
 */
export class CoverThumbs {
  private active = 0;
  private waiting: Array<() => void> = [];
  private inFlight = new Map<string, Promise<string | null>>();

  constructor(private coversDir: string) {}

  thumbnailPath(id: string): string {
    return join(this.coversDir, "thumbs", `${id}.jpg`);
  }

  /** Drops the cached thumbnail of a removed book; generation state is keyed by id. */
  async invalidate(id: string): Promise<void> {
    this.inFlight.delete(id);
    await rm(this.thumbnailPath(id), { force: true });
  }

  /** Returns the cached/generated JPEG path, or null when the source is not a readable image. */
  async ensure(id: string, source: string): Promise<string | null> {
    const path = this.thumbnailPath(id);
    const cached = await statOrNull(path);
    const sourceFile = await statOrNull(source);
    if (!sourceFile?.isFile()) return null;
    // Re-extracted metadata overwrites the source cover; regenerate when it is newer.
    if (cached && cached.mtimeMs >= sourceFile.mtimeMs) return path;
    const running = this.inFlight.get(id);
    if (running) return running;
    const job = this.generate(path, source, sourceFile.mtimeMs).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, job);
    return job;
  }

  private async generate(path: string, source: string, sourceMtimeMs: number): Promise<string | null> {
    return this.withSlot(async () => {
      // Another request may have produced a fresh file while this one waited for a slot.
      const cached = await statOrNull(path);
      if (cached && cached.mtimeMs >= sourceMtimeMs) return path;
      const input = await readFile(source).catch(() => null);
      if (!input) return null;
      const image = await loadImage(input).catch(() => null);
      if (!image) return null;
      const width = Math.min(THUMB_WIDTH, image.width);
      const height = Math.max(1, Math.round(image.height * (width / image.width)));
      const canvas = createCanvas(width, height);
      canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      const jpeg = await canvas.encode("jpeg", THUMB_QUALITY);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, jpeg, { mode: 0o600 });
      await rename(temporary, path);
      return path;
    });
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
