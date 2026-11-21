import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TABLE_ROW_HEIGHT } from "./BookTable";

const STYLES = join(dirname(fileURLToPath(import.meta.url)), "../../styles");
const TABLE_CSS = readFileSync(join(STYLES, "library-table.css"), "utf8");
const COMPONENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BookTable.tsx"), "utf8");

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced CSS block");
}

function ruleBody(css: string, selector: string): string {
  const source = `\n${stripComments(css)}`;
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`Missing CSS rule: ${selector}`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, matchingBrace(source, open));
}

function mediaBody(css: string, query: string): string {
  const source = stripComments(css);
  const start = source.indexOf(`@media ${query}`);
  if (start === -1) throw new Error(`Missing media query: ${query}`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, matchingBrace(source, open));
}

function declaration(body: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
}

const px = (value: string): number => {
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!match) throw new Error(`Expected a px length, got: ${value}`);
  return Number(match[1]);
};

const COLUMNS = ["col-title", "col-author", "col-type", "col-progress", "col-added", "col-actions"];

describe("library table columns", () => {
  it("uses fixed table layout shared by the header and every row", () => {
    const table = ruleBody(TABLE_CSS, ".books-table");
    expect(declaration(table, "table-layout")).toBe("fixed");
    expect(declaration(table, "width")).toBe("100%");
    expect(declaration(table, "min-width")).toBe("var(--books-table-min-width)");
    expect(COMPONENT).toContain("<colgroup>");
    for (const column of COLUMNS) expect(COMPONENT).toContain(`<col className="${column}" />`);
  });

  it("gives every data column a fixed width and leaves only the title flexible", () => {
    const widths = COLUMNS.map((column) => declaration(ruleBody(TABLE_CSS, `.books-table .${column}`), "width"));
    expect(widths[0]).toBe("auto");
    for (const width of widths.slice(1)) {
      expect(width).toMatch(/^var\(--books-table-(author|type|progress|added|actions)\)$/);
    }
    expect(stripComments(TABLE_CSS)).not.toMatch(/\b(?:max-content|min-content|fit-content)\b/);
  });

  it("reserves a minimum width large enough for every fixed column and the title", () => {
    const wrap = ruleBody(TABLE_CSS, ".table-wrap");
    const minWidth = declaration(wrap, "--books-table-min-width");
    for (const name of ["title-min", "author", "type", "progress", "added", "actions"]) {
      expect(minWidth, name).toContain(`var(--books-table-${name})`);
    }
  });

  it("keeps each row at the height the virtualizer advances by", () => {
    expect(TABLE_ROW_HEIGHT).toBe(44);
    expect(px(declaration(ruleBody(TABLE_CSS, ".books-table tbody tr"), "height"))).toBe(TABLE_ROW_HEIGHT);

    const cells = ruleBody(TABLE_CSS, ".books-table th, .books-table td");
    expect(px(declaration(cells, "height"))).toBe(TABLE_ROW_HEIGHT);
    expect(declaration(cells, "padding")).toBe("0 var(--space-4)");
    expect(declaration(cells, "overflow")).toBe("hidden");
    expect(declaration(cells, "text-overflow")).toBe("ellipsis");
    expect(declaration(cells, "min-width")).toBe("0");
    expect(declaration(ruleBody(TABLE_CSS, ".books-table .spacer-row td"), "padding")).toBe("0");
  });

  it("keeps horizontal scrolling out of the sticky containing block", () => {
    const wrap = ruleBody(TABLE_CSS, ".table-wrap");
    expect(wrap).not.toMatch(/(?:^|[;\n])\s*overflow(?:-x)?\s*:/);

    const scroller = ruleBody(TABLE_CSS, ".table-scroll");
    expect(declaration(scroller, "overflow-x")).toBe("auto");
    expect(declaration(scroller, "scrollbar-gutter")).toBe("stable");
    expect(declaration(ruleBody(TABLE_CSS, ".table-sticky-head-scroll"), "scrollbar-gutter")).toBe("stable");
    expect(stripComments(TABLE_CSS)).not.toMatch(/(?:transition|animation)[^;{}]*\bwidth\b/);
  });

  it("sticks the visual header below the app header and keeps the real one accessible", () => {
    const sticky = ruleBody(TABLE_CSS, ".table-sticky-head");
    expect(declaration(sticky, "position")).toBe("sticky");
    expect(declaration(sticky, "top")).toBe("var(--books-table-sticky-top)");
    expect(declaration(sticky, "z-index")).toBe("10");
    expect(declaration(ruleBody(TABLE_CSS, ".table-wrap"), "--books-table-sticky-top")).toBe("var(--topbar)");

    // The body keeps its real table header for assistive technology; clipping
    // removes it from layout without removing it from the accessibility tree.
    const hiddenHead = ruleBody(TABLE_CSS, ".books-table-body > thead");
    expect(declaration(hiddenHead, "position")).toBe("absolute");
    expect(declaration(hiddenHead, "width")).toBe("1px");
    expect(declaration(hiddenHead, "height")).toBe("1px");
    expect(declaration(hiddenHead, "clip-path")).toBe("inset(50%)");

    expect(ruleBody(TABLE_CSS, ".books-table th")).not.toMatch(/(?:^|[;\n])\s*position\s*:\s*sticky/);
  });

  it("hides Progress and Tags below 768px without breaking the shared column tracks", () => {
    const narrow = mediaBody(TABLE_CSS, "(max-width: 768px)").replace(/^[ \t]+/gm, "");
    expect(declaration(ruleBody(narrow, ".table-wrap"), "--books-table-progress")).toBe("0px");
    expect(declaration(ruleBody(narrow, ".table-wrap"), "--books-table-tags")).toBe("0px");

    const progressCells = ruleBody(
      narrow,
      ".books-table .progress-col,\n.books-table .progress-cell,\n.books-table .tags-col,\n.books-table .tags-cell",
    );
    expect(declaration(progressCells, "width")).toBe("0");
    expect(declaration(progressCells, "padding")).toBe("0");
    expect(declaration(progressCells, "visibility")).toBe("hidden");
    // display:none would remove the cells from the column grid and shift every
    // later cell into the wrong track.
    expect(progressCells).not.toMatch(/(?:^|[;\n])\s*display\s*:/);
  });
});
