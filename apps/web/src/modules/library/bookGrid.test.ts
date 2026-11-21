import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_BOOK_CARD_GAP,
  FALLBACK_BOOK_CARD_HEIGHT,
  parseCssPixels,
  readBookGridMetrics,
  resolveBookGridMetrics,
} from "./bookGrid";

const STYLES = join(dirname(fileURLToPath(import.meta.url)), "../../styles");
const GRID_CSS = readFileSync(join(STYLES, "library-grid.css"), "utf8");
const BASE_CSS = readFileSync(join(STYLES, "base.css"), "utf8");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(css: string, selector: string): string {
  const source = `\n${stripComments(css)}`;
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`Missing CSS rule: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

function declaration(body: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
}

function px(value: string): number {
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!match) throw new Error(`Expected a px length, got: ${value}`);
  return Number(match[1]);
}

/**
 * Worst-case height of the card info column, in CSS pixels, using the declared
 * typography in base.css and library-grid.css:
 *   two-line title 37.5 + 10 margins, author 19.5, meta 25.25,
 *   index note 21.25, progress 33.4, padding 24.
 * Any new visual affordance that adds height must be added here and still fit.
 */
const CARD_INFO_MIN_HEIGHT = 170.9;

describe("book grid metrics", () => {
  it("reads the card height and gap from computed CSS and derives the row pitch", () => {
    const values: Record<string, string> = {
      "--book-card-height": "420px",
      "--book-card-gap": "20px",
    };
    expect(resolveBookGridMetrics((property) => values[property] ?? "")).toEqual({
      cardHeight: 420,
      gap: 20,
      rowHeight: 440,
    });
  });

  it("falls back to the stylesheet defaults when the variables are unavailable", () => {
    const fallback = {
      cardHeight: FALLBACK_BOOK_CARD_HEIGHT,
      gap: FALLBACK_BOOK_CARD_GAP,
      rowHeight: FALLBACK_BOOK_CARD_HEIGHT + FALLBACK_BOOK_CARD_GAP,
    };
    expect(resolveBookGridMetrics(() => "")).toEqual(fallback);
    expect(readBookGridMetrics()).toEqual(fallback);
  });

  it("rejects invalid, zero and negative lengths", () => {
    expect(parseCssPixels("12.5px", 1)).toBe(12.5);
    expect(parseCssPixels("var(--missing)", 7)).toBe(7);
    expect(parseCssPixels("-4px", 7)).toBe(7);
    expect(parseCssPixels("0", 7)).toBe(7);
  });

  it("keeps the fallbacks equal to the CSS custom properties", () => {
    const root = ruleBody(GRID_CSS, ":root");
    const space4 = px(declaration(ruleBody(BASE_CSS, ":root"), "--space-4"));

    expect(px(declaration(root, "--book-card-height"))).toBe(FALLBACK_BOOK_CARD_HEIGHT);
    expect(declaration(root, "--book-card-gap")).toBe("var(--space-4)");
    expect(space4).toBe(FALLBACK_BOOK_CARD_GAP);
  });

  it("reserves enough room for a two-line title, note and progress bar", () => {
    const cardHeight = px(declaration(ruleBody(GRID_CSS, ":root"), "--book-card-height"));
    const coverPercent = Number(
      declaration(ruleBody(GRID_CSS, ".virtual-grid .cover"), "height").replace("%", ""),
    );
    // The card link fills the card's content box (borders excluded).
    const infoHeight = (cardHeight - 2) * (1 - coverPercent / 100);
    expect(infoHeight).toBeGreaterThanOrEqual(CARD_INFO_MIN_HEIGHT);
  });

  it("contains the card inside its row so rows cannot overlap", () => {
    const item = ruleBody(GRID_CSS, '.grid-row > [role="listitem"]');
    expect(declaration(item, "height")).toBe("var(--book-card-height)");
    expect(declaration(item, "min-height")).toBe("0");
    expect(declaration(ruleBody(GRID_CSS, ".grid-row"), "gap")).toBe("var(--book-card-gap)");

    const card = ruleBody(GRID_CSS, ".virtual-grid .card");
    expect(declaration(card, "height")).toBe("100%");
    expect(declaration(card, "max-height")).toBe("100%");

    const baseCard = ruleBody(GRID_CSS, ".card");
    expect(declaration(baseCard, "overflow")).toBe("hidden");
    expect(declaration(baseCard, "isolation")).toBe("isolate");

    const info = ruleBody(GRID_CSS, ".virtual-grid .card-info");
    expect(declaration(info, "overflow")).toBe("hidden");
    expect(declaration(ruleBody(GRID_CSS, ".virtual-grid .card-info > *"), "flex")).toBe("none");
  });
});
