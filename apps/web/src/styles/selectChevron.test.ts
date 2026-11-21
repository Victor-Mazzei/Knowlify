import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readStyle = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");

const baseCss = readStyle("./base.css");
const settingsCss = readStyle("./settings.css");

const ruleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
};

const declaration = (body: string, property: string): string => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[;\\n])\\s*${escaped}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS declaration: ${property}`);
  return match[1].trim();
};

const numberBeforePx = (value: string): number => {
  const match = value.match(/(\d+(?:\.\d+)?)px/);
  if (!match) throw new Error(`Expected a px length, got: ${value}`);
  return Number(match[1]);
};

const selectRule = ruleBody(baseCss, "select");
const chevronOffsets = [...declaration(selectRule, "background-position").matchAll(/calc\(100% - (\d+(?:\.\d+)?)px\)/g)]
  .map((match) => Number(match[1]));

describe("select chevron", () => {
  it("keeps a 16-20px visual gap to the right edge", () => {
    expect(chevronOffsets).toHaveLength(2);
    const rightmostEdge = Math.min(...chevronOffsets);
    expect(rightmostEdge).toBeGreaterThanOrEqual(16);
    expect(rightmostEdge).toBeLessThanOrEqual(20);
  });

  it("reserves padding for truncated labels beyond the whole chevron", () => {
    const chevronSize = numberBeforePx(declaration(selectRule, "background-size"));
    expect(Math.abs(chevronOffsets[0] - chevronOffsets[1])).toBe(chevronSize);

    const arrowLeftmostEdge = Math.max(...chevronOffsets) + chevronSize;
    const paddingRight = numberBeforePx(declaration(selectRule, "padding-right"));
    expect(paddingRight - arrowLeftmostEdge).toBeGreaterThanOrEqual(8);
    expect(declaration(selectRule, "text-overflow")).toBe("ellipsis");
  });

  it("keeps the custom chevron for every select", () => {
    expect(declaration(selectRule, "-webkit-appearance")).toBe("none");
    expect(declaration(selectRule, "appearance")).toBe("none");
  });

  it("restores the native control in forced-colors mode", () => {
    const match = baseCss.match(/@media \(forced-colors: active\) \{\s*select \{([^}]*)\}\s*\}/);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? "";
    expect(declaration(body, "-webkit-appearance")).toBe("auto");
    expect(declaration(body, "appearance")).toBe("auto");
    expect(declaration(body, "background-image")).toBe("none");
  });

  it("does not shrink the chevron room when a layout overrides select padding", () => {
    const override = ruleBody(settingsCss, ".llm-input-row select");
    const padding = declaration(override, "padding").split(/\s+/);
    const paddingRight = numberBeforePx(padding[1] ?? "");
    expect(paddingRight).toBeGreaterThanOrEqual(numberBeforePx(declaration(selectRule, "padding-right")));
  });
});
