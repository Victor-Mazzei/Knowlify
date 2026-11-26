import { useEffect, useState } from "react";

/**
 * Minimal encoder surface used here. `qrcode-generator` is imported on demand
 * by the share card, so the library stays out of the initial bundle.
 */
export type QrEncoder = (
  typeNumber: 0 | 1,
  level: "M",
) => {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};

const QUIET_ZONE = 4;

/** Turns the encoder's module grid into a square boolean matrix. */
export function encodeMatrix(value: string, encode: QrEncoder): boolean[][] {
  const code = encode(0, "M");
  code.addData(value);
  code.make();
  const count = code.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < count; row += 1) {
    const cells: boolean[] = [];
    for (let col = 0; col < count; col += 1) cells.push(code.isDark(row, col));
    matrix.push(cells);
  }
  return matrix;
}

/** Loads the encoder asynchronously and returns the matrix. */
export async function generateQrMatrix(value: string): Promise<boolean[][]> {
  const module = await import("qrcode-generator");
  return encodeMatrix(value, module.default);
}

function modulePath(matrix: boolean[][]): string {
  let path = "";
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix[row].length; col += 1) {
      if (matrix[row][col]) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return path;
}

/**
 * SVG drawn by React, never by `innerHTML`, so the desktop CSP stays intact.
 * The white quiet zone is fixed: a themed QR would stop scanning in dark mode.
 */
export function QrCode({ value, label, size = 168 }: { value: string; label: string; size?: number }) {
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setMatrix(null);
    setFailed(false);
    void generateQrMatrix(value)
      .then((next) => {
        if (active) setMatrix(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="share-qr-failed" role="status">
        The QR code could not be created. Use the address and password instead.
      </p>
    );
  }

  if (!matrix) {
    return (
      <div className="share-qr share-qr-wait" style={{ width: size, height: size }} role="status">
        <span className="visually-hidden">Creating QR code…</span>
      </div>
    );
  }

  const count = matrix.length;
  const total = count + QUIET_ZONE * 2;
  return (
    <svg
      className="share-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={modulePath(matrix)} fill="#000" />
    </svg>
  );
}
