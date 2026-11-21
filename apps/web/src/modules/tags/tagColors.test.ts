import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TAG_COLORS } from "./tagColors";

const baseCss = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
const lightStart = baseCss.indexOf("/* Tags: fixed palette");
const darkStart = baseCss.indexOf(':root[data-theme="dark"]', lightStart);
const mediaStart = baseCss.indexOf("@media (prefers-color-scheme: dark) {", darkStart);
const lightCss = baseCss.slice(lightStart, darkStart);
const darkCss = baseCss.slice(darkStart, mediaStart);

function token(css: string, name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing token ${name}`);
  return match[1]!.trim();
}

function hslToRgb(value: string): [number, number, number] {
  const match = value.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!match) throw new Error(`Unsupported color ${value}`);
  const hue = Number(match[1]) / 360;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  if (saturation === 0) {
    const channel = Math.round(lightness * 255);
    return [channel, channel, channel];
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (input: number) => {
    let t = input;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(channel(hue + 1 / 3) * 255),
    Math.round(channel(hue) * 255),
    Math.round(channel(hue - 1 / 3) * 255),
  ];
}

function luminance(value: string): number {
  const [red, green, blue] = hslToRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const [light, dark] = first > second ? [first, second] : [second, first];
  return (light + 0.05) / (dark + 0.05);
}

describe("tag palette", () => {
  it("keeps text contrast at or above 4.5:1 in both themes", () => {
    for (const color of TAG_COLORS) {
      for (const [theme, css] of [
        ["light", lightCss],
        ["dark", darkCss],
      ] as const) {
        const background = token(css, `--tag-${color}-bg`);
        const foreground = token(css, `--tag-${color}-fg`);
        expect(contrast(foreground, background), `${color} ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
