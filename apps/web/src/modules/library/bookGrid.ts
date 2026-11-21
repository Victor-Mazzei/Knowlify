/**
 * Sizing contract between `library-grid.css` and the virtualized grid.
 *
 * The CSS variables are the single source of truth: the absolute rows must use
 * the same pitch as the cards they contain, otherwise a taller card is painted
 * over by the next row. Keep the fallbacks equal to the stylesheet defaults for
 * the environments where computed custom properties are unavailable.
 */
export const BOOK_CARD_HEIGHT_VAR = "--book-card-height";
export const BOOK_CARD_GAP_VAR = "--book-card-gap";

export const FALLBACK_BOOK_CARD_HEIGHT = 380;
export const FALLBACK_BOOK_CARD_GAP = 16;

export type BookGridMetrics = {
  /** Height of one card, border box included. */
  cardHeight: number;
  /** Space between two consecutive rows. */
  gap: number;
  /** Distance between the top of one row and the top of the next. */
  rowHeight: number;
};

export function parseCssPixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Pure resolver, kept separate from the DOM for tests and fallback callers. */
export function resolveBookGridMetrics(resolve: (property: string) => string): BookGridMetrics {
  const cardHeight = parseCssPixels(resolve(BOOK_CARD_HEIGHT_VAR), FALLBACK_BOOK_CARD_HEIGHT);
  const gap = parseCssPixels(resolve(BOOK_CARD_GAP_VAR), FALLBACK_BOOK_CARD_GAP);
  return { cardHeight, gap, rowHeight: cardHeight + gap };
}

export function readBookGridMetrics(): BookGridMetrics {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return resolveBookGridMetrics(() => "");
  }
  const style = getComputedStyle(document.documentElement);
  return resolveBookGridMetrics((property) => style.getPropertyValue(property));
}
