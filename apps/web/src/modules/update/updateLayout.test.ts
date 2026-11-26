import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src/modules/update/update.css"), "utf8");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const ruleBody = (selector: string): string => {
  const source = `\n${stripComments(CSS)}`;
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`Missing CSS rule: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
};

const mediaBlock = (query: string): string => {
  const source = stripComments(CSS);
  const start = source.indexOf(`@media (${query})`);
  if (start === -1) throw new Error(`Missing media query: ${query}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  return source.slice(open + 1, close);
};

describe("update notice CSS contract", () => {
  it("lets the banner wrap instead of scrolling horizontally", () => {
    const banner = ruleBody(".update-banner");
    expect(banner).toContain("display: flex;");
    expect(banner).toContain("flex-wrap: wrap;");
    expect(banner).not.toContain("animation");
    expect(banner).not.toContain("white-space: nowrap");
  });

  it("lets the copy shrink and break long words", () => {
    const copy = ruleBody(".update-banner-copy");
    expect(copy).toContain("min-width: 0;");
    expect(copy).toContain("overflow-wrap: anywhere;");
  });

  it("moves the banner actions to their own row below 480 px", () => {
    const narrow = mediaBlock("max-width: 480px");
    expect(narrow).toContain(".update-banner-copy { flex-basis: 100%; }");
    expect(narrow).toContain(".update-banner-actions { width: 100%; margin-left: 0; }");
  });

  it("keeps the card and its state inside the settings column", () => {
    expect(ruleBody(".update-card")).toContain("min-width: 0;");
    expect(ruleBody(".update-state")).toContain("max-width: 100%;");
    expect(ruleBody(".update-privacy")).toContain("overflow-wrap: anywhere;");
  });

  it("removes the switch transition when motion is reduced", () => {
    expect(mediaBlock("prefers-reduced-motion: reduce")).toContain(
      ".update-switch span[aria-hidden] { transition: none; }",
    );
  });
});
