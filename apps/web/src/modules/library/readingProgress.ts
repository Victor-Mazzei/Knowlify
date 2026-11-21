export type RemainingProgress = {
  /** Whole percent read (1–100), used for the bar width and aria-valuenow. */
  read: number;
  /** Visible label: "X% left" or "Finished". */
  label: string;
};

/**
 * Turns the stored 0–1 fraction into how much of the book is still unread.
 * Returns null when the book is missing progress, effectively unstarted or
 * invalid, so callers can render nothing at all.
 */
export function formatRemaining(percentage: number | null | undefined): RemainingProgress | null {
  if (typeof percentage !== "number" || !Number.isFinite(percentage)) return null;
  const progress = Math.min(1, Math.max(0, percentage));
  const rounded = Math.round(progress * 100);
  if (rounded < 1) return null;
  // EPUB positions rarely reach exactly 1, so the last percent is "Finished".
  if (progress >= 0.99) return { read: 100, label: "Finished" };
  const read = Math.min(98, rounded);
  return { read, label: `${100 - read}% left` };
}
