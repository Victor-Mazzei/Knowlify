import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type CssRule = { file: string; selector: string; body: string };

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = dirname(STYLES_DIR);

const cssFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFilesUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const matchingBrace = (css: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const cssRules = (path: string): CssRule[] => {
  const css = stripComments(readFileSync(path, "utf8"));
  const file = relative(SOURCE_DIR, path).split("\\").join("/");
  const rules: CssRule[] = [];
  const visit = (source: string) => {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf("{", cursor);
      if (open === -1) return;
      const close = matchingBrace(source, open);
      if (close === -1) return;
      const selector = source.slice(cursor, open).trim();
      const body = source.slice(open + 1, close);
      if (selector.startsWith("@")) visit(body);
      else if (selector) rules.push({ file, selector, body });
      cursor = close + 1;
    }
  };
  visit(css);
  return rules;
};

const allRules = cssFilesUnder(SOURCE_DIR).flatMap(cssRules);

const selectorList = (selector: string): string[] =>
  selector.split(",").map((part) => part.replace(/\s+/g, " ").trim());

const startsWithElement = (selector: string, element: "input" | "select" | "textarea"): boolean =>
  selectorList(selector).some((part) => new RegExp(`^${element}(?![\\w-])`).test(part));

const appliesToElement = (selector: string, element: "input" | "select" | "textarea"): boolean =>
  selectorList(selector).some((part) => new RegExp(`(?:^|[\\s>+~])${element}(?![\\w-])`).test(part));

const declaration = (body: string, property: string): string => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
};

const rulesOf = (file: string): CssRule[] => allRules.filter((rule) => rule.file === file);

const px = (value: string): number => {
  const match = value.match(/(\d+(?:\.\d+)?)px/);
  if (!match) throw new Error(`Expected a px length, got: ${value}`);
  return Number(match[1]);
};

describe("form control styles", () => {
  it("keeps the base input normalization limited to inherited typography", () => {
    const inputRules = rulesOf("styles/base.css").filter((rule) => startsWithElement(rule.selector, "input"));
    expect(inputRules.map((rule) => rule.selector)).toEqual(["button, input, select"]);

    const [normalization] = inputRules;
    expect(declaration(normalization.body, "font")).toBe("inherit");
    expect(declaration(normalization.body, "color")).toBe("inherit");
    expect(normalization.body).not.toMatch(/appearance|background|border|padding|height|width/);
  });

  it("does not apply the custom select chevron to text-like inputs", () => {
    const chevron = rulesOf("styles/base.css").find((rule) => /text-overflow\s*:\s*ellipsis/.test(rule.body));
    expect(chevron?.selector).toBe("select");
    expect(appliesToElement(chevron?.selector ?? "", "input")).toBe(false);
    expect(appliesToElement(chevron?.selector ?? "", "textarea")).toBe(false);
  });

  it("scopes every control chrome rule in area stylesheets", () => {
    const unscoped = allRules
      .filter((rule) => rule.file !== "styles/base.css")
      .filter((rule) => (["input", "select", "textarea"] as const).some((element) => startsWithElement(rule.selector, element)))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(unscoped).toEqual([]);
  });

  it("gives every LLM form control the same height, border and background", () => {
    const shared = rulesOf("styles/settings.css").find((rule) =>
      selectorList(rule.selector).includes(".llm-input-row input"),
    );
    expect(shared).toBeDefined();

    const body = shared?.body ?? "";
    expect(declaration(body, "height")).toBe("38px");
    expect(declaration(body, "padding")).toBe("0 12px");
    expect(declaration(body, "border")).toBe("1px solid var(--hairline-strong)");
    expect(declaration(body, "border-radius")).toBe("var(--radius-control)");
    expect(declaration(body, "background-color")).toBe("var(--surface)");
    expect(declaration(body, "font-weight")).toBe("400");
  });

  it("reserves chevron room without erasing the custom arrow", () => {
    const selectRules = allRules.filter((rule) => appliesToElement(rule.selector, "select"));
    expect(selectRules.length).toBeGreaterThan(0);
    for (const rule of selectRules) {
      expect(rule.body, `${rule.file}: ${rule.selector}`).not.toMatch(/(?:^|[;\n])\s*background\s*:/);
    }

    const base = rulesOf("styles/base.css").find((rule) => rule.selector === "select");
    const override = rulesOf("styles/settings.css").find((rule) => rule.selector === ".llm-input-row select");
    expect(base).toBeDefined();
    expect(override).toBeDefined();

    const basePadding = px(declaration(base?.body ?? "", "padding-right"));
    const overridePadding = px(declaration(override?.body ?? "", "padding").split(/\s+/)[1] ?? "");
    expect(overridePadding).toBeGreaterThanOrEqual(basePadding);
  });
});
