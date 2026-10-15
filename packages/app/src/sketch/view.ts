/**
 * The board's camera: millimetres to pixels and back, zooming, snapping.
 *
 * The camera is a centre in millimetres and a scale in pixels per millimetre.
 * Screen y runs down and the drawing's y runs up, and this is the one place
 * that flip happens.
 */

import type { Point } from './doc.js';
import type { Bounds } from './flatten.js';

export interface Camera {
  cx: number;
  cy: number;
  /** Pixels per millimetre. */
  scale: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 160;

export function toScreen(camera: Camera, size: Size, [x, y]: Point): Point {
  return [size.w / 2 + (x - camera.cx) * camera.scale, size.h / 2 - (y - camera.cy) * camera.scale];
}

export function toWorld(camera: Camera, size: Size, [sx, sy]: Point): Point {
  return [camera.cx + (sx - size.w / 2) / camera.scale, camera.cy - (sy - size.h / 2) / camera.scale];
}

/** Zooms by `factor` keeping the millimetre under the cursor under the cursor. */
export function zoomAt(camera: Camera, size: Size, at: Point, factor: number): Camera {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, camera.scale * factor));
  if (scale === camera.scale) return camera;
  const before = toWorld(camera, size, at);
  const moved = { ...camera, scale };
  const after = toWorld(moved, size, at);
  return { cx: camera.cx + before[0] - after[0], cy: camera.cy + before[1] - after[1], scale };
}

export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, cx: camera.cx - dx / camera.scale, cy: camera.cy + dy / camera.scale };
}

/** A camera showing `bounds` with room around it; an empty drawing shows 100 mm. */
export function fitCamera(size: Size, bounds: Bounds | undefined, fill = 0.8): Camera {
  if (!bounds || bounds.maxX - bounds.minX < 1e-6 || bounds.maxY - bounds.minY < 1e-6) {
    const extent = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 20) : 100;
    const cx = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    const cy = bounds ? (bounds.minY + bounds.maxY) / 2 : 0;
    return { cx, cy, scale: clampScale((Math.min(size.w, size.h) * fill) / extent) };
  }
  const scale = Math.min((size.w * fill) / (bounds.maxX - bounds.minX), (size.h * fill) / (bounds.maxY - bounds.minY));
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, scale: clampScale(scale) };
}

function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

export function snapPoint([x, y]: Point, step: number): Point {
  if (step <= 0) return [x, y];
  return [Math.round(x / step) * step, Math.round(y / step) * step];
}

export interface GridLines {
  /** Millimetre positions of the fine lines, or none when they would be too dense. */
  fineX: number[];
  fineY: number[];
  coarseX: number[];
  coarseY: number[];
  /** The coarse spacing chosen, in millimetres. */
  coarse: number;
}

/** Hidden under this many pixels apart, where a grid is just grey. */
const MIN_FINE_PX = 7;
const MAX_LINES = 400;

/**
 * Grid lines across the view: fine ones at the snap step, coarse ones at a
 * round number of millimetres that keeps them a readable distance apart.
 */
export function gridLines(camera: Camera, size: Size, step: number): GridLines {
  const [minX, maxY] = toWorld(camera, size, [0, 0]);
  const [maxX, minY] = toWorld(camera, size, [size.w, size.h]);
  const coarse = coarseSpacing(camera.scale);
  const range = (spacing: number, lo: number, hi: number): number[] => {
    if (spacing <= 0) return [];
    const start = Math.ceil(lo / spacing) * spacing;
    const count = Math.floor((hi - start) / spacing) + 1;
    if (count > MAX_LINES || count < 0) return [];
    return Array.from({ length: count }, (_, i) => start + i * spacing);
  };
  const fineOk = step > 0 && step * camera.scale >= MIN_FINE_PX && step < coarse;
  return {
    fineX: fineOk ? range(step, minX, maxX) : [],
    fineY: fineOk ? range(step, minY, maxY) : [],
    coarseX: range(coarse, minX, maxX),
    coarseY: range(coarse, minY, maxY),
    coarse,
  };
}

/** 1, 2, 5, 10, 20, 50… millimetres: whichever is first to be 60 px apart. */
function coarseSpacing(scale: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return candidates.find((mm) => mm * scale >= 60) ?? 1000;
}
