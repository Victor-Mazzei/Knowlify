#!/usr/bin/env node
/**
 * Capture the public screenshots for the Knowlify site.
 *
 * Prerequisites:
 * - A demo server running with the fixture library and the fake LLM
 *   (see scripts/site-screenshots/README.md).
 * - playwright-core and a Chromium binary, installed outside this repository.
 *
 * Usage:
 *   KNOWLIFY_BASE_URL=http://127.0.0.1:8787 \
 *   KNOWLIFY_USER=admin KNOWLIFY_PASSWORD=demo-library-pass \
 *   CHROMIUM_PATH=/path/to/chrome \
 *   NODE_PATH=/path/to/node_modules \
 *   node scripts/site-screenshots/capture.mjs
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUT = resolve(process.env.SITE_IMAGE_DIR ?? join(ROOT, "site/assets/img"));
const BASE = (process.env.KNOWLIFY_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const USER = process.env.KNOWLIFY_USER ?? "admin";
const PASS = process.env.KNOWLIFY_PASSWORD ?? "demo-library-pass";
const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  (existsSync(join(process.env.HOME ?? "", ".cache/ms-playwright"))
    ? findChromium()
    : "/usr/bin/chromium");

function findChromium() {
  const base = join(process.env.HOME ?? "", ".cache/ms-playwright");
  const entries = readdirSync(base, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("chromium-"));
  const last = entries.sort().at(-1);
  return last ? join(base, last, "chrome-linux64", "chrome") : "/usr/bin/chromium";
}

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");

async function api(path) {
  const response = await fetch(`${BASE}${path}`, { headers: { authorization: auth } });
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return response.json();
}

let chromium;
try {
  const require = createRequire(import.meta.url);
  const playwright = require("playwright-core");
  ({ chromium } = playwright);
} catch {
  throw new Error("playwright-core is not installed. Set NODE_PATH to a directory that contains it (see README).");
}

const books = (await api("/api/books?limit=200&sort=title")).items;
const bookId = (title) => {
  const book = books.find((candidate) => candidate.title === title);
  if (!book) throw new Error(`Book not found: ${title}`);
  return book.id;
};

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ["--hide-scrollbars", "--force-device-scale-factor=1"],
});

const work = await mkdtemp(join(tmpdir(), "knowlify-site-"));
await mkdir(OUT, { recursive: true });

async function newContext({ width = 1440, height = 900, colorScheme = "light", scale = 1 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme,
    locale: "en-US",
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ([credentials]) => {
      localStorage.setItem("knowlify-credentials", JSON.stringify(credentials));
    },
    [{ user: USER, pass: PASS }],
  );
  return context;
}

async function settle(page, extra = 600) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = [...document.images];
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((done) => {
              image.addEventListener("load", done, { once: true });
              image.addEventListener("error", done, { once: true });
            }),
      ),
    );
  });
  await page.waitForTimeout(extra);
}

async function capture(page, name, { scale = 1 } = {}) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const png = join(work, `${name}.png`);
  await page.screenshot({ path: png });
  const image = sharp(png);
  const meta = await image.metadata();
  const width = Math.round((meta.width ?? 0) / scale);
  await image
    .resize({ width: meta.width, withoutEnlargement: true })
    .webp({ quality: scale > 1 ? 84 : 82, effort: 6, smartSubsample: true })
    .toFile(join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${width}x${Math.round((meta.height ?? 0) / scale)}`);
}

const errors = [];

async function openLibrary(context, path = "/") {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
  page.on("console", (message) => {
    // epub.js renders script-less pages in a sandboxed iframe; Chromium logs one
    // Permissions Policy notice for the iframe's deprecated unload listener.
    if (message.type() === "error" && !message.text().includes("Permissions policy violation: unload")) {
      errors.push(`${path}: console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().startsWith(BASE)) {
      errors.push(`${path}: HTTP ${response.status()} ${response.url().slice(BASE.length)}`);
    }
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("main, .reader", { timeout: 30_000 });
  return page;
}

// 1. Library grid, light.
{
  const context = await newContext();
  const page = await openLibrary(context);
  await page.waitForSelector(".card .cover");
  await settle(page, 1500);
  await capture(page, "library-light");
  await context.close();
}

// 2. Library grid, dark.
{
  const context = await newContext({ colorScheme: "dark" });
  const page = await openLibrary(context);
  await page.waitForSelector(".card .cover");
  await settle(page, 1500);
  await capture(page, "library-dark");
  await context.close();
}

// 3. Library filtered to favorites, showing removable filter chips.
{
  const context = await newContext();
  const page = await openLibrary(context, "/?favorite=1");
  await page.waitForSelector(".card .cover");
  await page.waitForSelector(".filter-chip, .chips button", { timeout: 10_000 }).catch(() => undefined);
  await settle(page, 900);
  await capture(page, "library-filters");
  await context.close();
}

// 4. Book details.
{
  const context = await newContext();
  const page = await openLibrary(context, `/book/${bookId("Pride and Prejudice")}`);
  await page.waitForSelector(".book-details-grid");
  await page.waitForSelector(".book-details-cover-image");
  await settle(page, 1000);
  await capture(page, "book-details");
  await context.close();
}

// 5. Reader with the tutor open and an answer.
{
  const context = await newContext();
  const page = await openLibrary(context, `/read/${bookId("Pride and Prejudice")}`);
  await page.waitForSelector("#tutor-reader-toggle", { timeout: 30_000 });
  // Wait for the page map, then open a chapter instead of the front matter.
  await page.waitForSelector(".page-input", { timeout: 30_000 });
  await page.waitForTimeout(3500);
  await page.locator(".page-input").fill("40");
  await page.locator(".page-input").press("Enter");
  await page.waitForTimeout(1800);
  await page.click("#tutor-reader-toggle");
  const composer = page.locator(".asst-input");
  await composer.waitFor({ timeout: 15_000 });
  await composer.fill("Why does Darcy's first proposal fail?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes("Darcy's first proposal fails"),
    undefined,
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
  await settle(page, 500);
  await capture(page, "reader-tutor");
  await context.close();
}

// 6. Notes grouped by book.
{
  const context = await newContext();
  const page = await openLibrary(context, "/notes");
  await page.waitForSelector(".note-group");
  await settle(page, 900);
  await capture(page, "notes");
  await context.close();
}

// 7. Settings: the MCP access section, with its own route and menu, without tokens.
{
  const context = await newContext();
  const page = await openLibrary(context, "/settings/mcp");
  await page.getByRole("heading", { name: "MCP access", level: 1 }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "MCP access", level: 2 }).waitFor({ timeout: 30_000 });
  await settle(page, 900);
  await capture(page, "settings-mcp");
  await context.close();
}

// 8. Mobile library.
{
  const context = await newContext({ width: 390, height: 844, colorScheme: "light" });
  const page = await openLibrary(context);
  await page.waitForSelector(".card .cover");
  await settle(page, 1500);
  await capture(page, "library-mobile");
  await context.close();
}

// 8b. Responsive variants: the feature plates render about 640 CSS px, the
// hero plate and the reader plate render at most about 1066 CSS px.
for (const name of ["library-filters", "book-details", "notes", "settings-mcp"]) {
  const source = join(OUT, `${name}.webp`);
  await sharp(source)
    .resize({ width: 720, withoutEnlargement: true })
    .webp({ quality: 80, effort: 6, smartSubsample: true })
    .toFile(join(OUT, `${name}-720.webp`));
  console.log(`${name}-720.webp 720w`);
}
for (const name of ["library-light", "library-dark", "reader-tutor"]) {
  for (const width of [720, 1080]) {
    await sharp(join(OUT, `${name}.webp`))
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: width === 720 ? 80 : 81, effort: 6, smartSubsample: true })
      .toFile(join(OUT, `${name}-${width}.webp`));
    console.log(`${name}-${width}.webp ${width}w`);
  }
}

// 9. Open Graph card. Built from the light library screenshot, the mark and Geist.
{
  const mark = await readFile(resolve(ROOT, "assets/brand/logo-mark.svg"), "utf8");
  const markData = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;
  const shot = `data:image/webp;base64,${(await readFile(join(OUT, "library-light.webp"))).toString("base64")}`;
  const font = await readFile(resolve(ROOT, "node_modules/@fontsource/geist/files/geist-latin-600-normal.woff2"));
  const fontData = `data:font/woff2;base64,${font.toString("base64")}`;
  const fontRegular = await readFile(resolve(ROOT, "node_modules/@fontsource/geist/files/geist-latin-400-normal.woff2"));
  const fontRegularData = `data:font/woff2;base64,${fontRegular.toString("base64")}`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
@font-face { font-family: Geist; src: url(${fontData}) format("woff2"); font-weight: 600; }
@font-face { font-family: Geist; src: url(${fontRegularData}) format("woff2"); font-weight: 400; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  display: grid; grid-template-columns: minmax(0, 1fr) 520px; gap: 48px;
  padding: 64px; background: #101812; color: #f2f6f2; font-family: Geist, sans-serif;
}
.copy { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
.brand img { width: 52px; height: 52px; }
h1 { margin: 0 0 18px; font-size: 56px; line-height: 0.98; letter-spacing: -0.05em; font-weight: 600; }
p { margin: 0; font-size: 22px; line-height: 1.4; color: #b8c9ba; max-width: 30ch; }
.meta { font-family: ui-monospace, monospace; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #86a58d; }
.shot { align-self: center; border: 1px solid #314633; border-radius: 10px; overflow: hidden; background: #1a261c; }
.shot img { display: block; width: 100%; height: auto; }
</style>
<div class="copy">
  <div class="brand"><img src="${markData}" alt="">Knowlify</div>
  <div>
    <h1>Your books.<br>Your notes.<br>Your machine.</h1>
    <p>A self-hosted library for PDF and EPUB books, with search, notes and an optional AI tutor.</p>
  </div>
  <p class="meta">Local-first / Self-hosted / AGPL-3.0</p>
</div>
<div class="shot"><img src="${shot}" alt=""></div>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const png = join(work, "og.png");
  await page.screenshot({ path: png });
  await sharp(png).png({ compressionLevel: 9, palette: true }).toFile(join(OUT, "og.png"));
  console.log("og.png 1200x630");
  await page.close();
}

await browser.close();
await rm(work, { recursive: true, force: true });

if (errors.length > 0) {
  console.error("Browser errors:");
  for (const message of new Set(errors)) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log("No browser console errors.");
}
