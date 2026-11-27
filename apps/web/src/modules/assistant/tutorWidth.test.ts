import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readStyle = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");

const TUTOR_CSS = readStyle("./tutor.css");
const ASSISTANT_CSS = readStyle("./assistant.css");

const SRC_DIR = `${resolve(process.cwd(), "src")}/`;
const cssFilesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFilesIn(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
const ALL_CSS = cssFilesIn(SRC_DIR).map((path) => ({
  file: relative(SRC_DIR, path),
  css: readFileSync(path, "utf8"),
}));

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
};

/**
 * Properties that can change the size or placement of a box. A selector tied to
 * Ask/Session may still change color, borders or decoration; it may not touch
 * these, otherwise the geometry stops being independent of the mode.
 */
const GEOMETRY_PROPERTIES = new Set([
  "width",
  "min-width",
  "max-width",
  "inline-size",
  "min-inline-size",
  "max-inline-size",
  "height",
  "min-height",
  "max-height",
  "block-size",
  "min-block-size",
  "max-block-size",
  "display",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "flex",
  "flex-basis",
  "flex-grow",
  "flex-shrink",
  "flex-direction",
  "flex-wrap",
  "order",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "grid",
  "grid-template",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-column",
  "grid-row",
  "gap",
  "row-gap",
  "column-gap",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "overflow",
  "overflow-x",
  "overflow-y",
  "container",
  "container-type",
  "container-name",
  "font-size",
  "font-family",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "transform",
  "translate",
  "scale",
  "zoom",
]);

/** `.ask`, `.session`, `#ask`, `#session` and `[data-mode…]` are mode hooks. */
const MODE_SELECTOR =
  /(?:\.ask\b|#ask\b|\.session\b|#session\b|\[data-(?:[a-z-]*-)?mode[^\]]*\])/;

const styleRules = (css: string) =>
  [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!,
  }));

const declarations = (body: string) =>
  body
    .split(";")
    .map((part) => part.split(":", 1)[0]?.trim().toLowerCase())
    .filter((property): property is string => Boolean(property));

const modeLinked = (selector: string) =>
  MODE_SELECTOR.test(selector) ||
  (selector.includes("tutor-mode") && /(?::checked|\[data-active="true"\])/.test(selector));

const modeGeometryViolations = (file: string, css: string) => {
  const offenders: string[] = [];
  for (const rule of styleRules(css)) {
    if (!modeLinked(rule.selector)) continue;
    for (const property of declarations(rule.body)) {
      if (GEOMETRY_PROPERTIES.has(property)) {
        offenders.push(`${file}: ${rule.selector} sets ${property}`);
      }
    }
  }
  return offenders;
};

describe("tutor width stability", () => {
  it("reserves the scrollbar in every surface that can start scrolling", () => {
    for (const [css, selector] of [
      [TUTOR_CSS, ".tutor-page"],
      [TUTOR_CSS, ".tutor-page .asst-rail"],
      [TUTOR_CSS, ".tutor-dock"],
      [ASSISTANT_CSS, ".asst-scroll"],
    ] as const) {
      expect(ruleBody(stripComments(css), selector)).toContain("scrollbar-gutter: stable;");
    }
  });

  it("always reserves every scrollbar that can change between modes or content", () => {
    const scroll = ruleBody(stripComments(ASSISTANT_CSS), ".asst-scroll");
    expect(scroll).toContain("overflow-y: scroll;");
    expect(scroll).toContain("min-width: 0;");
    expect(scroll).toContain("min-height: 0;");
    expect(ruleBody(stripComments(TUTOR_CSS), ".tutor-page .asst-rail")).toContain(
      "overflow-y: scroll;",
    );
    expect(ruleBody(stripComments(TUTOR_CSS), ".tutor-dock")).toContain("overflow-y: scroll;");
  });

  it("gives /ask one content-independent page width and one shared two-column grid", () => {
    const page = ruleBody(stripComments(TUTOR_CSS), ".tutor-page");
    expect(page).toContain("width: 100%;");
    expect(page).toContain(
      "grid-template-columns: var(--tutor-rail-width) minmax(0, var(--tutor-chat-max));",
    );
    expect(page).toContain("grid-template-rows: minmax(0, 1fr);");
    expect(page).toContain("justify-content: center;");
    expect(page).toContain("align-items: stretch;");
    expect(page).not.toContain("fit-content");
    expect(page).not.toContain("max-content");
    expect(page).not.toContain("width: auto");
  });

  it("caps the chat column at a constant width with a zero minimum", () => {
    const main = ruleBody(stripComments(TUTOR_CSS), ".tutor-page .asst-main");
    expect(main).toContain("width: 100%;");
    expect(main).toContain("max-width: var(--tutor-chat-max, 68ch);");
    expect(main).toContain("min-width: 0;");
    expect(main).toContain("height: 100%;");
    expect(main).not.toContain("fit-content");
    expect(main).not.toContain("max-content");
  });

  it("lets the transcript shrink to its 120px floor instead of making the page scroll", () => {
    const thread = ruleBody(stripComments(ASSISTANT_CSS), ".asst-thread");
    expect(thread).toContain("min-height: var(--tutor-min-thread, 7.5rem);");
    expect(thread).toContain("flex: 1 1 var(--tutor-thread-basis, max(7.5rem, 25dvh));");
  });

  it("never lets a mode-linked selector set a size or position property", () => {
    expect(ALL_CSS.flatMap(({ file, css }) => modeGeometryViolations(file, css))).toEqual([]);
  });

  it("would catch a mode-linked width or position regression", () => {
    const sample = `
      .tutor-page[data-mode="ask"] { width: 120%; }
      .tutor-mode-option[data-active="true"] { padding-left: 40px; }
      .tutor-mode-switch { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tutor-page[data-mode="session"] { color: var(--ink); }
    `;
    expect(modeGeometryViolations("sample.css", sample)).toEqual([
      'sample.css: .tutor-page[data-mode="ask"] sets width',
      'sample.css: .tutor-mode-option[data-active="true"] sets padding-left',
    ]);
  });
});
