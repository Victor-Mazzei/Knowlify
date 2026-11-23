import type { IndexEpoch } from "../../ports/index-epoch.js";

/**
 * The only implementation: a plain counter in the API process. Every write path
 * receives this same instance from the composition root, so `bump()` is synchronous
 * with the commit and readers observe it before the next cache lookup.
 */
export class IndexEpochCounter implements IndexEpoch {
  private epoch = 0;

  current(): number {
    return this.epoch;
  }

  bump(): void {
    this.epoch += 1;
  }
}
