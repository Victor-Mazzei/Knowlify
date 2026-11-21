/**
 * Header-only image sniffing for cover validation (ADR-2/ADR-5). Dimensions are read
 * before any decode so a decompression bomb is rejected without allocating the pixels.
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readUInt24LE = (data: Buffer, offset: number): number =>
  data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);

function png(data: Buffer): ImageHeader | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // The first chunk of a valid PNG is IHDR with a fixed 13-byte payload.
  if (data.toString("ascii", 12, 16) !== "IHDR" || data.readUInt32BE(8) !== 13) return null;
  return { format: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpeg(data: Buffer): ImageHeader | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) return null;
    let marker = data[offset + 1]!;
    // Fill bytes (0xFF) before a marker are legal.
    while (marker === 0xff && offset + 2 < data.length) {
      offset += 1;
      marker = data[offset + 1]!;
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 1 >= data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (isStartOfFrame(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (length < 7) return null;
      return {
        format: "jpeg",
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function webp(data: Buffer): ImageHeader | null {
  if (data.length < 30) return null;
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = data.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // key frame start code 9D 01 2A, then 14-bit width and height.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return {
      format: "webp",
      width: data.readUInt16LE(26) & 0x3fff,
      height: data.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (data.length < 30) return null;
    return {
      format: "webp",
      width: readUInt24LE(data, 24) + 1,
      height: readUInt24LE(data, 27) + 1,
    };
  }
  return null;
}

/** Returns the declared format and dimensions, or null when the bytes are not a known image. */
export function sniffImage(data: Buffer): ImageHeader | null {
  const header = data.subarray(0, 4).toString("hex");
  if (header === "89504e47") return png(data);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return jpeg(data);
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF") return webp(data);
  return null;
}
