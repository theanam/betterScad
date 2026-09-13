/**
 * `surface()` — heightmap to solid (spec features 2 and 11).
 *
 * The engine parses OpenSCAD's `.dat` text grids itself. Images are decoded by
 * the host (a canvas in the browser, a decoder library in Node) and handed back
 * as a grayscale grid, so the engine keeps no image-codec dependency.
 */

import { TriMesh } from './mesh.js';

/** Row-major grid of heights; `rows[0]` is the **top** row, as in a `.dat` file. */
export interface HeightGrid {
  rows: number[][];
  width: number;
  height: number;
}

export function parseSurfaceDat(text: string): HeightGrid {
  const rows: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // `#` starts a comment; blank lines separate nothing and are skipped.
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const values = trimmed.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (values.length > 0) rows.push(values);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  // Ragged rows are padded with zero so the grid stays rectangular.
  for (const row of rows) while (row.length < width) row.push(0);
  return { rows, width, height: rows.length };
}

/** Converts 8-bit grayscale samples (row-major, top row first) to a height grid. */
export function gridFromGrayscale(
  samples: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  scale = 1,
): HeightGrid {
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push((samples[y * width + x] / 255) * 100 * scale);
    rows.push(row);
  }
  return { rows, width, height };
}

/**
 * Builds a closed solid from a height grid.
 *
 * The top follows the heightmap, the bottom is a flat plane one unit below the
 * lowest sample (so the solid always has volume), and the four sides are
 * stitched between them. Grid cell (0,0) sits at model origin unless centred.
 */
export function surfaceToMesh(
  grid: HeightGrid,
  options: { center?: boolean; invert?: boolean } = {},
): TriMesh {
  const { width, height } = grid;
  if (width < 2 || height < 2) {
    return { positions: new Float32Array(0), triangles: new Uint32Array(0) };
  }

  const invert = options.invert ?? false;
  const at = (x: number, y: number): number => {
    const value = grid.rows[y]?.[x] ?? 0;
    return invert ? -value : value;
  };

  let minHeight = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) minHeight = Math.min(minHeight, at(x, y));
  }
  const floor = minHeight - 1;

  const offsetX = options.center ? -(width - 1) / 2 : 0;
  const offsetY = options.center ? -(height - 1) / 2 : 0;

  const positions: number[] = [];
  const triangles: number[] = [];

  // `.dat` rows run from the top of the grid downwards, so row index is
  // mirrored into +Y to keep the model the same way up as the source data.
  const topIndex = (x: number, y: number): number => y * width + x;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      positions.push(x + offsetX, height - 1 - y + offsetY, at(x, y));
    }
  }
  const bottomBase = positions.length / 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      positions.push(x + offsetX, height - 1 - y + offsetY, floor);
    }
  }
  const bottomIndex = (x: number, y: number): number => bottomBase + y * width + x;

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = topIndex(x, y);
      const b = topIndex(x + 1, y);
      const c = topIndex(x + 1, y + 1);
      const d = topIndex(x, y + 1);
      // Wound CCW seen from +Z, i.e. from outside the top surface.
      triangles.push(a, d, c, a, c, b);

      const ab = bottomIndex(x, y);
      const bb = bottomIndex(x + 1, y);
      const cb = bottomIndex(x + 1, y + 1);
      const db = bottomIndex(x, y + 1);
      triangles.push(ab, bb, cb, ab, cb, db);
    }
  }

  // Side walls, each wound so its normal points away from the solid.
  for (let x = 0; x < width - 1; x++) {
    const yTop = 0;
    triangles.push(topIndex(x, yTop), topIndex(x + 1, yTop), bottomIndex(x + 1, yTop));
    triangles.push(topIndex(x, yTop), bottomIndex(x + 1, yTop), bottomIndex(x, yTop));

    const yBottom = height - 1;
    triangles.push(topIndex(x + 1, yBottom), topIndex(x, yBottom), bottomIndex(x, yBottom));
    triangles.push(topIndex(x + 1, yBottom), bottomIndex(x, yBottom), bottomIndex(x + 1, yBottom));
  }
  for (let y = 0; y < height - 1; y++) {
    const xLeft = 0;
    triangles.push(topIndex(xLeft, y + 1), topIndex(xLeft, y), bottomIndex(xLeft, y));
    triangles.push(topIndex(xLeft, y + 1), bottomIndex(xLeft, y), bottomIndex(xLeft, y + 1));

    const xRight = width - 1;
    triangles.push(topIndex(xRight, y), topIndex(xRight, y + 1), bottomIndex(xRight, y + 1));
    triangles.push(topIndex(xRight, y), bottomIndex(xRight, y + 1), bottomIndex(xRight, y));
  }

  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}
