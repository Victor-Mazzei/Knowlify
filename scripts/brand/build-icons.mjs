#!/usr/bin/env node
/**
 * Regenerates every raster brand asset from the SVGs in assets/brand.
 *
 * The generated PNG/ICO files are committed so CI, Docker and the Tauri build
 * never need to rasterize anything. Run this only after changing a source SVG.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BRAND = join(ROOT, "assets/brand");
const PUBLIC = join(ROOT, "apps/web/public");
const PREVIEW = join(tmpdir(), "knowlify-brand");

const source = (name) => readFileSync(join(BRAND, name), "utf8");

/** Rasterizes an SVG source to PNG bytes at the requested width. */
function png(svg, width) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

function write(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  const label = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
  console.log(`  ${label} (${bytes} bytes)`);
}

/** Builds a multi-resolution ICO from PNG payloads (16/32/48). */
function ico(payloads) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(payloads.length, 4);
  const entries = [];
  let offset = 6 + 16 * payloads.length;
  for (const { size, data } of payloads) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...payloads.map((item) => item.data)]);
}

const masterLight = source("logo-mark-light.svg");
const masterDark = source("logo-mark-dark.svg");
const mono = source("logo-mark-mono.svg");
const smallLight = source("logo-mark-small.svg");
const maskable = source("logo-mark-maskable.svg");

console.log("Brand assets");
write(join(BRAND, "logo-1024.png"), png(masterLight, 1024));

write(join(PUBLIC, "favicon.svg"), smallLight);
write(join(PUBLIC, "apple-touch-icon.png"), png(maskable, 180));
write(join(PUBLIC, "icon-192.png"), png(masterLight, 192));
write(join(PUBLIC, "icon-512.png"), png(masterLight, 512));
write(join(PUBLIC, "icon-maskable-512.png"), png(maskable, 512));

const faviconSizes = [16, 32, 48].map((size) => ({ size, data: png(smallLight, size) }));
write(join(PUBLIC, "favicon.ico"), ico(faviconSizes));

const bannerMark = png(masterLight, 260).toString("base64");
const watermark = png(mono.replace("currentColor", "#4b7862"), 560).toString("base64");
const bannerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f3f7f4"/>
  <image x="320" y="35" width="560" height="560" href="data:image/png;base64,${watermark}" opacity="0.06"/>
  <image x="470" y="185" width="260" height="260" href="data:image/png;base64,${bannerMark}"/>
</svg>`;
write(join(BRAND, "banner.png"), png(bannerSvg, 1200));

// Local preview only (never committed). The 16/32/48 entries are shown at their
// true pixel size; the HTML version enlarges them with image-rendering: pixelated.
const PREVIEW_SIZES = [16, 24, 32, 48, 180, 512];
const previews = [];
for (const [theme, sourceSvg] of [["light", masterLight], ["dark", masterDark]]) {
  for (const size of PREVIEW_SIZES) {
    const data = png(sourceSvg, size);
    previews.push({ theme, size, b64: data.toString("base64") });
    write(join(PREVIEW, `${theme}-${size}.png`), data);
  }
}
const row = (theme, background) => `<div class="row" style="background:${background}">${previews
  .filter((item) => item.theme === theme)
  .map(
    (item) =>
      `<figure><img src="${theme}-${item.size}.png" width="${item.size <= 48 ? item.size * 8 : item.size}" height="${item.size <= 48 ? item.size * 8 : item.size}"><figcaption>${item.size}px</figcaption></figure>`,
  )
  .join("")}</div>`;
write(
  join(PREVIEW, "contact-sheet.html"),
  `<!doctype html><meta charset="utf-8"><title>Knowlify brand preview</title>
<style>body{margin:0;font:12px ui-monospace,monospace;color:#4b7862}figure{margin:0;text-align:center}
.row{display:flex;gap:24px;align-items:flex-start;padding:24px}img{image-rendering:pixelated;display:block}</style>
${row("light", "#f3f7f4")}${row("dark", "#0d100e")}`,
);

function contactRow(theme, y) {
  let x = 24;
  return previews
    .filter((item) => item.theme === theme)
    .map((item) => {
      const image = `<image x="${x}" y="${y}" width="${item.size}" height="${item.size}" href="data:image/png;base64,${item.b64}"/>`;
      x += item.size + 20;
      return image;
    })
    .join("");
}
const contactSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1040" viewBox="0 0 960 1040">
  <rect width="960" height="520" fill="#f3f7f4"/>
  <rect y="520" width="960" height="520" fill="#0d100e"/>
  ${contactRow("light", 4)}
  ${contactRow("dark", 524)}
</svg>`;
write(join(PREVIEW, "contact-sheet.png"), png(contactSvg, 960));

console.log(`\nPreview (not committed): ${join(PREVIEW, "contact-sheet.html")}`);
console.log("Desktop icons: npm exec --yes --package @tauri-apps/cli@^2 -- tauri icon assets/brand/logo-1024.png -o apps/desktop/src-tauri/icons");
