/**
 * Dark marks on a light ground.
 *
 * Otsu's threshold on the luminance: the split that best separates the
 * picture into two tones, which is what a scanned sketch or a printed logo
 * is. No model, no download, and the right answer for a line drawing, where
 * a subject detector would see a sheet of paper.
 */

import type { Mask } from './vectorize.js';

export interface Pixels {
  /** RGBA, as `ImageData` lays it out. */
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function inkMask(image: Pixels): Mask {
  const { width, height, data } = image;
  const luma = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) {
    const v = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
    luma[i] = v;
    histogram[v]++;
  }
  const threshold = otsu(histogram, luma.length);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < luma.length; i++) mask[i] = luma[i] <= threshold ? 255 : 0;
  return { data: mask, width, height };
}

/** The level `t` such that pixels at or below it are one class and the rest the other. */
export function otsu(histogram: Uint32Array, total: number): number {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}
