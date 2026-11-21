import { createCanvas, loadImage } from "@napi-rs/canvas";
import { METADATA_LIMITS } from "../../domain/library/BookMetadata.js";

/**
 * Isolated cover decoder. Runs in a child process (see coverEncoder.ts) because the
 * native codec can abort the process on malformed input. Receives the original bytes on
 * stdin and writes a bounded JPEG on stdout; exits non-zero when the image is rejected.
 */
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const data = Buffer.concat(chunks);
  if (data.length === 0) process.exit(2);
  const image = await loadImage(data);
  if (!image.width || !image.height
    || image.width > METADATA_LIMITS.coverMaxSide
    || image.height > METADATA_LIMITS.coverMaxSide
    || image.width * image.height > METADATA_LIMITS.coverMaxPixels) {
    process.exit(3);
  }
  const width = Math.min(METADATA_LIMITS.coverTargetWidth, image.width);
  const height = Math.max(1, Math.round(image.height * (width / image.width)));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const jpeg = await canvas.encode("jpeg", METADATA_LIMITS.coverJpegQuality);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(jpeg, (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
}

main().catch(() => process.exit(2));
