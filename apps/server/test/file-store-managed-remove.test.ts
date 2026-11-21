import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DiskFileStore } from "../src/adapters/files/FileStore.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-managed-remove-"));
const booksDir = join(root, "data", "books");
const coversDir = join(root, "data", "covers");
const outside = join(root, "outside");
const library = join(root, "library");
await mkdir(booksDir, { recursive: true });
await mkdir(coversDir, { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(library, { recursive: true });
await writeFile(join(outside, "external.epub"), "external");
await writeFile(join(library, "book.epub"), "library");

const files = new DiskFileStore(booksDir, coversDir);
const exists = async (path: string) => readFile(path).then(() => true, () => false);

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("DiskFileStore.removeManaged", () => {
  it("removes only files inside the managed upload and cover directories", async () => {
    const book = join(booksDir, "managed.epub");
    const cover = join(coversDir, "managed.jpg");
    await writeFile(book, "managed");
    await writeFile(cover, "cover");

    expect(await files.removeManaged(book)).toBe(true);
    expect(await files.removeManaged(cover)).toBe(true);
    expect(await exists(book)).toBe(false);
    expect(await exists(cover)).toBe(false);
  });

  it("never touches library files, traversal or missing paths", async () => {
    const external = join(outside, "external.epub");
    const traversal = join(booksDir, "..", "..", "outside", "external.epub");

    expect(await files.removeManaged(join(library, "book.epub"))).toBe(false);
    expect(await files.removeManaged(traversal)).toBe(false);
    expect(await files.removeManaged(join(booksDir, "missing.epub"))).toBe(false);
    expect(await files.removeManaged(booksDir)).toBe(false);
    expect(await files.removeManaged(coversDir)).toBe(false);
    expect(await exists(join(library, "book.epub"))).toBe(true);
    expect(await exists(external)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses symlinks that resolve outside the managed directories", async () => {
    const external = join(outside, "external.epub");
    const link = join(booksDir, "escape.epub");
    const linkedDir = join(booksDir, "linked");
    await symlink(external, link);
    await symlink(outside, linkedDir, "dir");

    expect(await files.removeManaged(link)).toBe(false);
    expect(await files.removeManaged(join(linkedDir, "external.epub"))).toBe(false);
    expect(await exists(external)).toBe(true);
  });
});
