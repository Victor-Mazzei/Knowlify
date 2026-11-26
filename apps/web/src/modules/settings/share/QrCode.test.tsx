import { render, screen } from "@testing-library/react";
import qrcode from "qrcode-generator";
import { describe, expect, it } from "vitest";
import { encodeMatrix, QrCode } from "./QrCode";

/** Fixed output of qrcode-generator 2.0.4 for version 1-M, "HELLO WORLD". */
const KNOWN_MATRIX = [
  "#######.#...#.#######",
  "#.....#.#...#.#.....#",
  "#.###.#.......#.###.#",
  "#.###.#.#.#.#.#.###.#",
  "#.###.#..###..#.###.#",
  "#.....#...###.#.....#",
  "#######.#.#.#.#######",
  "........#####........",
  "#.##.###.#.##.#..#.##",
  ".##....#.#######.##..",
  ".....#####.#.#.#...##",
  "#.#.##.##..#...#.#.#.",
  "#...#.##.##.##....#.#",
  "........#.##..##..#.#",
  "#######.#.#######....",
  "#.....#.###..#.#.####",
  "#.###.#..#..#.#..#...",
  "#.###.#.###...#..###.",
  "#.###.#.##..#..#..#..",
  "#.....#..###.####...#",
  "#######.##.#.#.#.....",
];

const matrixOf = (rows: string[]) => rows.map((row) => [...row].map((cell) => cell === "#"));

function expectFinder(matrix: boolean[][], top: number, left: number) {
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const border = row === 0 || row === 6 || col === 0 || col === 6;
      const ring = row === 1 || row === 5 || col === 1 || col === 5;
      expect(matrix[top + row][left + col], `${top + row},${left + col}`).toBe(border || !ring);
    }
  }
}

describe("encodeMatrix", () => {
  it("matches the known vector for version 1-M", () => {
    expect(encodeMatrix("HELLO WORLD", qrcode)).toEqual(matrixOf(KNOWN_MATRIX));
  });

  it("is deterministic and has three finder patterns plus the timing row", () => {
    const first = encodeMatrix("http://10.0.0.5:47870/#pair=ZGVza3RvcDphYmNk", qrcode);
    const second = encodeMatrix("http://10.0.0.5:47870/#pair=ZGVza3RvcDphYmNk", qrcode);
    expect(first).toEqual(second);

    const count = first.length;
    expect(first.every((row) => row.length === count)).toBe(true);
    expectFinder(first, 0, 0);
    expectFinder(first, 0, count - 7);
    expectFinder(first, count - 7, 0);

    // Horizontal timing pattern: alternating modules between the finders.
    for (let col = 8; col < count - 8; col += 1) {
      expect(first[6][col]).toBe(col % 2 === 0);
    }
  });
});

describe("QrCode", () => {
  it("renders one accessible SVG drawn by React", async () => {
    const { container } = render(
      <QrCode value="http://10.0.0.5:47870/#pair=ZGVza3RvcDphYmNk" label="QR code with the sign-in link" />,
    );

    const svg = await screen.findByRole("img", { name: "QR code with the sign-in link" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(svg.innerHTML).not.toContain("ZGVza3RvcDphYmNk");
  });
});
