import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CustomCovers, CoverImageError } from "../src/adapters/files/CustomCovers.js";
import { sniffImage } from "../src/adapters/metadata/imageInfo.js";

const root = await mkdtemp(join(tmpdir(), "knowlify-custom-covers-"));
let covers: CustomCovers;

/**
 * Every save that reaches the decoder spawns an isolated Node process
 * (adapters/files/coverEncoder.ts) because a malformed image can abort the native
 * codec. A spawn costs ~0.35 s on an idle machine; a loaded CI runner reached
 * ~2.5 s per spawn and the 5 s default timeout failed this suite on 2026-11-21.
 * Locally, four suites sharing two cores pushed the slowest test here to 6.9 s.
 * 30 s gives a >4x margin over that measurement.
 */
const DECODER_TIMEOUT_MS = 30_000;

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
    const formats = ["png", "jpeg", "webp"] as const;
    // Independent book ids: concurrent saves only shorten the wall time, each one
    // still runs its own isolated decoder.
    const saved = await Promise.all(formats.map(async (type) => {
      const id = `book-${type}`;
      const path = await covers.save(id, await image(type));
      return { id, path, header: sniffImage(await readFile(path)), isFile: (await stat(path)).isFile() };
    }));

    for (const { id, path, header, isFile } of saved) {
      expect(path).toBe(join(root, "covers", "custom", `${id}.jpg`));
      expect(header).toMatchObject({ format: "jpeg", width: 1200, height: 1800 });
      expect(isFile).toBe(true);
    }
  }, DECODER_TIMEOUT_MS);

  it("keeps smaller images at their own size", async () => {
    const path = await covers.save("small", await image("png", 100, 150));
    expect(sniffImage(await readFile(path))).toMatchObject({ format: "jpeg", width: 100, height: 150 });
  }, DECODER_TIMEOUT_MS);

  it("rejects malformed bytes, false magic and truncated images with 415", async () => {
    expect(await statusOf(covers.save("bad-1", Buffer.from("not an image")))).toBe(415);
    expect(await statusOf(covers.save("bad-2", Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])))).toBe(415);
    const fakeWebp = Buffer.alloc(44);
    fakeWebp.write("RIFF", 0, "ascii");
    fakeWebp.write("WEBP", 8, "ascii");
    fakeWebp.write("VP8X", 12, "ascii");
    // A truncated JPEG used to abort the native decoder and kill the server process.
    // Cut after the frame header so the cheap sniffing accepts it and the rejection
    // has to come from the isolated decoder, which is the path this test protects.
    const solid = createCanvas(200, 200);
    const context = solid.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 200, 200);
    const jpeg = await solid.encode("jpeg");
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length * 0.7));
    expect(sniffImage(truncated)).toMatchObject({ format: "jpeg", width: 200, height: 200 });

    const [bomb, webp, cut] = await Promise.all([
      statusOf(covers.save("bad-3", pixelBombPng(10, 10))),
      statusOf(covers.save("bad-4", fakeWebp)),
      statusOf(covers.save("bad-5", truncated)),
    ]);
    expect(bomb).toBe(415);
    expect(webp).toBe(415);
    expect(cut).toBe(415);
  }, DECODER_TIMEOUT_MS);

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
  }, DECODER_TIMEOUT_MS);
});
