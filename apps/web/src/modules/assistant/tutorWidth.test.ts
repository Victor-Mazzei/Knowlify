import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readStyle = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");

const TUTOR_CSS = readStyle("./tutor.css");
const ASSISTANT_CSS = readStyle("./assistant.css");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
};

describe("tutor width stability", () => {
  it("reserves the scrollbar gutter in every surface that can start scrolling", () => {
    for (const [css, selector] of [
      [TUTOR_CSS, ".tutor-page"],
      [TUTOR_CSS, ".tutor-page .asst-rail"],
      [TUTOR_CSS, ".tutor-dock"],
      [ASSISTANT_CSS, ".asst-scroll"],
    ] as const) {
      expect(ruleBody(stripComments(css), selector)).toContain("scrollbar-gutter: stable;");
    }
  });

  it("keeps the rail fixed and the chat column in the remaining space", () => {
    expect(ruleBody(stripComments(ASSISTANT_CSS), ".asst-page")).toContain(
      "grid-template-columns: min(15rem, 240px) minmax(0, 1fr);",
    );
  });

  it("gives the chat column a constant maximum width and a zero minimum", () => {
    const main = ruleBody(stripComments(ASSISTANT_CSS), ".asst-main");
    expect(main).toContain("max-width: 68ch;");
    expect(main).toContain("min-width: 0;");
  });
});
