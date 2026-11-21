import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CustomCovers, CoverImageError } from "../src/adapters/files/CustomCovers.js";
import { sniffImage } from "../src/adapters/metadata/imageInfo.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-custom-covers-"));
let covers: CustomCovers;

beforeAll(() => { covers = new CustomCovers(join(root, "covers")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function image(type: "png" | "jpeg" | "webp", width = 1600, height = 2400): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#336699";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(10, 10, width - 20, 40);
  return canvas.encode(type as "png");
}

function statusOf(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => { throw new Error("expected the cover to be rejected"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CoverImageError);
      return (error as CoverImageError).status;
    },
  );
}

function pixelBombPng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe("custom cover storage", () => {
  it("accepts PNG, JPEG and WebP and re-encodes them to a bounded JPEG", async () => {
    for (const type of ["png", "jpeg", "webp"] as const) {
      const id = `book-${type}`;
      const path = await covers.save(id, await image(type));
      expect(path).toBe(join(root, "covers", "custom", `${id}.jpg`));
      const stored = await readFile(path);
      const header = sniffImage(stored);
      expect(header).toMatchObject({ format: "jpeg", width: 1200, height: 1800 });
      expect((await stat(path)).isFile()).toBe(true);
    }
  });

  it("keeps smaller images at their own size", async () => {
    const path = await covers.save("small", await image("png", 100, 150));
    expect(sniffImage(await readFile(path))).toMatchObject({ format: "jpeg", width: 100, height: 150 });
  });

  it("rejects malformed bytes, false magic and truncated images with 415", async () => {
    expect(await statusOf(covers.save("bad-1", Buffer.from("not an image")))).toBe(415);
    expect(await statusOf(covers.save("bad-2", Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])))).toBe(415);
    expect(await statusOf(covers.save("bad-3", pixelBombPng(10, 10)))).toBe(415);
    const fakeWebp = Buffer.alloc(44);
    fakeWebp.write("RIFF", 0, "ascii");
    fakeWebp.write("WEBP", 8, "ascii");
    fakeWebp.write("VP8X", 12, "ascii");
    expect(await statusOf(covers.save("bad-4", fakeWebp))).toBe(415);
    // A truncated JPEG used to abort the native decoder and kill the server process.
    const solid = createCanvas(200, 200);
    const context = solid.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 200, 200);
    const jpeg = await solid.encode("jpeg");
    expect(await statusOf(covers.save("bad-5", jpeg.subarray(0, Math.floor(jpeg.length / 2))))).toBe(415);
  });

  it("rejects decompression bombs from the header with 400 before decoding", async () => {
    expect(await statusOf(covers.save("bomb-1", pixelBombPng(9000, 100)))).toBe(400);
    expect(await statusOf(covers.save("bomb-2", pixelBombPng(7000, 7000)))).toBe(400);
  });

  it("moves and removes the managed file", async () => {
    await covers.save("from", await image("png", 20, 30));
    const moved = await covers.move("from", "to");
    expect(moved).toBe(join(root, "covers", "custom", "to.jpg"));
    await expect(stat(join(root, "covers", "custom", "from.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sniffImage(await readFile(moved!))).toMatchObject({ format: "jpeg", width: 20, height: 30 });
    expect(await covers.move("from", "to")).toBeNull();
    await covers.remove("to");
    await expect(stat(join(root, "covers", "custom", "to.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    await covers.remove("to");
  });
});
