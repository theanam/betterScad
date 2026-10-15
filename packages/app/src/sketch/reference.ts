/**
 * A picture to draw over.
 *
 * It is a backdrop and nothing else: it never reaches the document or the
 * SVG, and it lives only as long as the board is open. Its one real control
 * is its size, which is set by pointing at two things in the picture and
 * saying how far apart they really are — a photograph does not know how big
 * the thing in it is, and nothing can guess for it.
 */

import type { Point } from './doc.js';
import type { Camera, Size } from './view.js';
import { toWorld } from './view.js';

export interface Backdrop {
  image: HTMLImageElement;
  /** The object URL the image was loaded from, revoked when it is let go. */
  url: string;
  name: string;
  /** Bottom-left corner and size, in millimetres. The aspect is always kept. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export const IMAGE_TYPES = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

export async function loadBackdrop(data: Uint8Array, name: string): Promise<{ image: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`${name} could not be read as an image.`));
      image.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { image, url };
}

/** Lands the picture whole in the middle of the view, at four fifths of it. */
export function fitBackdrop(image: HTMLImageElement, camera: Camera, size: Size): Pick<Backdrop, 'x' | 'y' | 'w' | 'h'> {
  const viewW = size.w / camera.scale;
  const viewH = size.h / camera.scale;
  const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
  let w = viewW * 0.8;
  let h = w / aspect;
  if (h > viewH * 0.8) {
    h = viewH * 0.8;
    w = h * aspect;
  }
  return { x: camera.cx - w / 2, y: camera.cy - h / 2, w, h };
}

export function moveBackdrop(b: Backdrop, dx: number, dy: number): Backdrop {
  return { ...b, x: b.x + dx, y: b.y + dy };
}

/**
 * Scales the picture so two points in it are `distance` apart, keeping the
 * first one where it is. The points are in millimetres on the board.
 */
export function calibrateBackdrop(b: Backdrop, p1: Point, p2: Point, distance: number): Backdrop {
  const current = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (current < 1e-6 || !(distance > 0)) return b;
  const factor = distance / current;
  return {
    ...b,
    x: p1[0] + (b.x - p1[0]) * factor,
    y: p1[1] + (b.y - p1[1]) * factor,
    w: b.w * factor,
    h: b.h * factor,
  };
}

/** Where a pixel of the picture sits on the board. */
export function pixelToBoard(b: Backdrop, px: number, py: number): Point {
  return [b.x + (px / b.image.naturalWidth) * b.w, b.y + b.h - (py / b.image.naturalHeight) * b.h];
}

export function releaseBackdrop(b: Backdrop | undefined): void {
  if (b) URL.revokeObjectURL(b.url);
}

export { toWorld };
