#!/usr/bin/env node
/**
 * Download the public-domain EPUBs used by the site screenshots.
 *
 * Project Gutenberg was unavailable when the screenshots were captured (HTTP 503,
 * Retry-After 6 hours), so the fixture uses Standard Ebooks, which produces free
 * EPUB editions of public-domain books. Each download is validated as an EPUB ZIP
 * before it is written.
 *
 * Downloads are restricted to HTTPS on standardebooks.org. Every redirect is
 * checked against the same allowlist, and response bodies are streamed with a
 * hard byte limit instead of being buffered first.
 *
 * Usage:
 *   node scripts/site-screenshots/fetch-books.mjs /tmp/knowlify/ge-site-books/library
 *
 * The target directory must not exist or must be empty. This keeps every capture
 * batch isolated, as untrusted downloads should be.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const ALLOWED_HOSTNAME = "standardebooks.org";
const BASE_URL = `https://${ALLOWED_HOSTNAME}/`;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_BYTES = 40 * 1024 * 1024;

const books = [
  ["pride", "jane-austen/pride-and-prejudice", "Pride and Prejudice"],
  ["alice", "lewis-carroll/alices-adventures-in-wonderland", "Alice's Adventures in Wonderland"],
  ["frankenstein", "mary-shelley/frankenstein", "Frankenstein"],
  ["moby-dick", "herman-melville/moby-dick", "Moby Dick"],
  ["art-of-war", "sun-tzu/the-art-of-war", "The Art of War"],
  ["meditations", "marcus-aurelius/meditations", "Meditations"],
  ["crime-and-punishment", "fyodor-dostoevsky/crime-and-punishment", "Crime and Punishment"],
  ["great-expectations", "charles-dickens/great-expectations", "Great Expectations"],
  ["tale-of-two-cities", "charles-dickens/a-tale-of-two-cities", "A Tale of Two Cities"],
  ["dorian-gray", "oscar-wilde/the-picture-of-dorian-gray", "The Picture of Dorian Gray"],
  ["time-machine", "h-g-wells/the-time-machine", "The Time Machine"],
  ["war-of-the-worlds", "h-g-wells/the-war-of-the-worlds", "The War of the Worlds"],
  ["around-the-world", "jules-verne/around-the-world-in-eighty-days", "Around the World in Eighty Days"],
  ["dracula", "bram-stoker/dracula", "Dracula"],
  ["hound-of-the-baskervilles", "arthur-conan-doyle/the-hound-of-the-baskervilles", "The Hound of the Baskervilles"],
  ["huckleberry-finn", "mark-twain/the-adventures-of-huckleberry-finn", "The Adventures of Huckleberry Finn"],
  ["anna-karenina", "leo-tolstoy/anna-karenina", "Anna Karenina"],
  ["scarlet-letter", "nathaniel-hawthorne/the-scarlet-letter", "The Scarlet Letter"],
];

class DownloadPolicyError extends Error {}

export function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DownloadPolicyError(`invalid URL: ${String(value)}`);
  }
  if (url.protocol !== "https:") {
    throw new DownloadPolicyError(`refusing non-HTTPS URL: ${url.href}`);
  }
  if (url.hostname !== ALLOWED_HOSTNAME) {
    throw new DownloadPolicyError(`refusing host ${url.hostname}; only ${ALLOWED_HOSTNAME} is allowed`);
  }
  if (url.port !== "") {
    throw new DownloadPolicyError(`refusing non-default port ${url.port} on ${url.hostname}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new DownloadPolicyError(`refusing URL with credentials: ${url.href}`);
  }
  return url;
}

function declaredLength(response) {
  const header = response.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header);
}

export async function readBodyWithLimit(response, maxBytes = MAX_BYTES) {
  const declared = declaredLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel();
    throw new DownloadPolicyError(`response declares ${declared} bytes; limit is ${maxBytes}`);
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DownloadPolicyError(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchFollowingRedirects(url, { fetchImpl, signal }) {
  let current = assertAllowedUrl(url);
  const visited = new Set();

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (visited.has(current.href)) {
      throw new DownloadPolicyError(`redirect loop at ${current.href}`);
    }
    visited.add(current.href);

    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "user-agent": "Knowlify site screenshot fixture" },
      signal,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, url: current };
    }

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null) {
      throw new DownloadPolicyError(`HTTP ${response.status} without Location from ${current.href}`);
    }

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new DownloadPolicyError(`invalid redirect from ${current.href}: ${location}`);
    }
    assertAllowedUrl(next);
    current = next;
  }

  throw new DownloadPolicyError(`too many redirects for ${url}`);
}

export async function download(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_BYTES,
    attempts = 3,
    timeoutMs = 120_000,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }
  assertAllowedUrl(url);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response, url: finalUrl } = await fetchFollowingRedirects(url, {
        fetchImpl,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return await readBodyWithLimit(response, maxBytes);
      }
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status} from ${finalUrl.href}`);
    } catch (error) {
      if (error instanceof DownloadPolicyError) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(1200 * attempt);
  }
  throw lastError ?? new Error(`failed to download ${String(url)}`);
}

export function findEpubHref(html) {
  return [...html.matchAll(/href="([^"]+\.epub)"/g)]
    .map((match) => match[1])
    .find((candidate) => !candidate.includes("advanced") && !candidate.includes("kepub"));
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/site-screenshots/fetch-books.mjs <empty-directory>");
    process.exitCode = 1;
    return;
  }

  const out = resolve(target);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) {
    console.error(`Refusing to write into a non-empty directory: ${out}`);
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const [name, page, title] of books) {
    try {
      const html = (await download(`${BASE_URL}ebooks/${page}`)).toString("utf8");
      const href = findEpubHref(html);
      if (!href) throw new Error("no EPUB link on the book page");
      const url = new URL(href, BASE_URL);
      url.searchParams.set("source", "download");
      const data = await download(url);
      if (data.subarray(0, 2).toString() !== "PK") throw new Error("not a ZIP file");
      const zip = new AdmZip(data);
      if (!zip.getEntry("mimetype") || zip.readAsText("mimetype").trim() !== "application/epub+zip") {
        throw new Error("not an EPUB");
      }
      await writeFile(resolve(out, `${name}.epub`), data);
      console.log(`ok ${name.padEnd(24)} ${(data.length / 1024 / 1024).toFixed(1)} MB  ${title}`);
    } catch (error) {
      failures += 1;
      console.error(`failed ${name}: ${error.message}`);
    }
  }

  if (failures > 0) {
    console.error(`${failures} download(s) failed. The target directory is incomplete.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Downloaded ${books.length} EPUBs to ${out}`);
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
  await main();
}
