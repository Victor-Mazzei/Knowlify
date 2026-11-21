import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ContentHasher } from "../../ports/library-dedup.js";

/**
 * SHA-256 over the whole file in the main process (ADR-9): the measured event-loop p99 is
 * well below the 50 ms budget. The read stream yields between chunks, so the loop is not
 * blocked for the duration of a large file.
 */
export class NodeContentHasher implements ContentHasher {
  async hash(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }
}
