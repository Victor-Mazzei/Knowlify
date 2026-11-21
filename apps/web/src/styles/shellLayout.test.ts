import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLES = dirname(fileURLToPath(import.meta.url));
const BASE = readFileSync(join(STYLES, "base.css"), "utf8");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const ruleBody = (css: string, selector: string): string => {
  const source = `\n${stripComments(css)}`;
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`Missing CSS rule: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
};

describe("shell layout CSS contract", () => {
  it("reserves the scrollbar gutter so pages of different heights keep the same width", () => {
    expect(ruleBody(BASE, "html")).toContain("scrollbar-gutter: stable;");
  });

  it("falls back to a classic scrollbar where scrollbar-gutter is unsupported", () => {
    expect(stripComments(BASE)).toContain("@supports not (scrollbar-gutter: stable)");
    expect(BASE).toContain("overflow-y: scroll;");
  });
});
