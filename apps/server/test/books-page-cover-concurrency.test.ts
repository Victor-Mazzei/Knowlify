import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverThumbs } from "../src/adapters/files/CoverThumbs.js";

const canvas = vi.hoisted(() => ({ active: 0, peak: 0, calls: 0 }));

vi.mock("@napi-rs/canvas", () => ({
  loadImage: async () => {
    canvas.active += 1;
    canvas.calls += 1;
    canvas.peak = Math.max(canvas.peak, canvas.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    canvas.active -= 1;
    return { width: 480, height: 720 };
  },
  createCanvas: () => ({
    getContext: () => ({ drawImage: () => {} }),
    encode: async () => Buffer.from("jpeg-bytes"),
  }),
}));

const roots: string[] = [];

const makeRoot = async (sources: number): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "knowlify-thumbs-"));
  roots.push(root);
  for (let index = 0; index < sources; index += 1) {
    await writeFile(join(root, `source-${index}.jpg`), `image-${index}`);
  }
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  canvas.active = 0;
  canvas.peak = 0;
  canvas.calls = 0;
});

describe("CoverThumbs", () => {
  it("never decodes/encodes more than two covers at once", async () => {
    const root = await makeRoot(8);
    const thumbs = new CoverThumbs(root);
    const paths = await Promise.all(
      Array.from({ length: 8 }, (_, index) => thumbs.ensure(`id-${index}`, join(root, `source-${index}.jpg`))),
    );
    expect(paths.every((path) => typeof path === "string")).toBe(true);
    expect(canvas.calls).toBe(8);
    expect(canvas.peak).toBe(2);
  });

  it("deduplicates concurrent requests for the same book", async () => {
    const root = await makeRoot(1);
    const thumbs = new CoverThumbs(root);
    const paths = await Promise.all(Array.from({ length: 6 }, () => thumbs.ensure("same", join(root, "source-0.jpg"))));
    expect(new Set(paths).size).toBe(1);
    expect(canvas.calls).toBe(1);
  });
});
