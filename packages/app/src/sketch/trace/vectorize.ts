/**
 * From a mask to outlines you can edit.
 *
 * A mask is pixels; a drawing is lines and curves. The way from one to the
 * other is: follow the boundary of every region as a loop of pixel corners,
 * thin the staircase to the points that matter, find the real corners, and
 * fit each run between corners with as few cubic curves as the points allow.
 * A run that a straight line fits becomes a line. The result is a pen path,
 * or a line run when nothing curved, which is what the tools here would have
 * drawn by hand — so it can be edited the same way afterwards.
 *
 * All of it is written from the published descriptions: boundary following
 * on a binary image, Douglas–Peucker simplification, and Schneider's curve
 * fitting from Graphics Gems.
 */

import type { Anchor, PathNode, Point, PolyNode, SketchNode } from '../doc.js';
import { ringOf } from '../flatten.js';

export interface Mask {
  /** One byte per pixel, row-major; 128 and up is inside. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface VectorizeOptions {
  /** Where a pixel lands on the board, in millimetres. */
  toBoard(px: number, py: number): Point;
  /** How far, in pixels, a simplified outline may stray from the boundary. */
  simplify?: number;
  /** Turns sharper than this, in degrees, are corners rather than curves. */
  cornerAngle?: number;
  /** Regions smaller than this many pixels are noise. */
  minArea?: number;
  /** At most this many outlines, largest first. */
  maxShapes?: number;
}

export function vectorizeMask(mask: Mask, options: VectorizeOptions): SketchNode[] {
  const simplify = options.simplify ?? 1.2;
  const cornerAngle = options.cornerAngle ?? 55;
  const minArea = options.minArea ?? 12;
  const maxShapes = options.maxShapes ?? 400;

  const loops = traceLoops(mask)
    .filter((loop) => Math.abs(polygonArea(loop)) >= minArea)
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))
    .slice(0, maxShapes);

  const nodes: SketchNode[] = [];
  for (const loop of loops) {
    const node = fitLoop(loop, simplify, cornerAngle, options.toBoard);
    if (!node) continue;
    // A curve fit can overshoot at a narrow notch and cross itself, and a
    // crossing outline encloses nothing. The simplified polygon never does.
    if (node.kind === 'path' && ringOf(node, 0).status === 'crossing') {
      const points = simplifyLoop(loop, simplify).map(([x, y]) => options.toBoard(x, y));
      if (points.length >= 3) nodes.push({ kind: 'poly', points, closed: true });
      continue;
    }
    nodes.push(node);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Boundary following
// ---------------------------------------------------------------------------

/**
 * Every boundary between inside and outside, as closed loops of pixel
 * corners. Each loop runs clockwise on the page around what is inside it, so
 * a hole's loop runs the other way round its hole — which is how the
 * drawing's own nesting rule will read it, without being told.
 *
 * Regions that touch only at a corner stay separate: at such a vertex the
 * walk turns right, hugging the region it is already on.
 */
export function traceLoops(mask: Mask): Point[][] {
  const { width, height, data } = mask;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] >= 128;

  // Outgoing edges by their start corner. A corner is (x, y) with x in
  // 0..width and y in 0..height; the key packs both.
  const stride = width + 1;
  const key = (x: number, y: number): number => y * stride + x;
  const out = new Map<number, Point[]>();
  const add = (x1: number, y1: number, x2: number, y2: number): void => {
    const k = key(x1, y1);
    const list = out.get(k);
    if (list) list.push([x2, y2]);
    else out.set(k, [[x2, y2]]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const loops: Point[][] = [];
  for (const [startKey, starts] of out) {
    while (starts.length > 0) {
      const start: Point = [startKey % stride, Math.floor(startKey / stride)];
      let current = start;
      let next = starts.pop()!;
      let dir: Point = [next[0] - current[0], next[1] - current[1]];
      const loop: Point[] = [current];
      let guard = 0;
      while (guard++ < 4 * width * height + 8) {
        current = next;
        if (current[0] === start[0] && current[1] === start[1]) break;
        const candidates = out.get(key(current[0], current[1]));
        if (!candidates || candidates.length === 0) break;
        let pick = 0;
        if (candidates.length > 1) {
          // Right turn on the page: (dx, dy) becomes (-dy, dx).
          const right: Point = [-dir[1], dir[0]];
          const index = candidates.findIndex((c) => c[0] - current[0] === right[0] && c[1] - current[1] === right[1]);
          pick = index >= 0 ? index : 0;
        }
        next = candidates.splice(pick, 1)[0];
        if (candidates.length === 0) out.delete(key(current[0], current[1]));
        const ndir: Point = [next[0] - current[0], next[1] - current[1]];
        // Only turns are kept; a straight run of pixel edges is one segment.
        if (ndir[0] !== dir[0] || ndir[1] !== dir[1]) loop.push(current);
        dir = ndir;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/** Douglas–Peucker on an open run of points: keeps both ends. */
export function simplifyRun(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstIndex = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointToSegment(points[i], points[a], points[b]);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > tolerance && worstIndex > 0) {
      keep[worstIndex] = 1;
      stack.push([a, worstIndex], [worstIndex, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A closed loop simplified; it is cut at its two most distant points first. */
export function simplifyLoop(points: readonly Point[], tolerance: number): Point[] {
  return simplifyLoopIndices(points, tolerance).map((i) => points[i]);
}

/** As `simplifyLoop`, but the indices of the kept points, in loop order. */
export function simplifyLoopIndices(points: readonly Point[], tolerance: number): number[] {
  if (points.length < 4) return points.map((_, i) => i);
  let a = 0;
  let b = 0;
  let far = -1;
  const step = Math.max(1, Math.floor(points.length / 64));
  for (let i = 0; i < points.length; i += step) {
    for (let j = i + 1; j < points.length; j += step) {
      const d = (points[i][0] - points[j][0]) ** 2 + (points[i][1] - points[j][1]) ** 2;
      if (d > far) {
        far = d;
        a = i;
        b = j;
      }
    }
  }
  const first = simplifyRunIndices(points, a, b, tolerance);
  const second = simplifyRunIndices(points, b, a, tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Indices kept by Douglas–Peucker over the run from `a` to `b`, wrapping. */
function simplifyRunIndices(points: readonly Point[], a: number, b: number, tolerance: number): number[] {
  const n = points.length;
  const indices: number[] = [];
  let i = a;
  for (;;) {
    indices.push(i);
    if (i === b) break;
    i = (i + 1) % n;
  }
  const run = indices.map((k) => points[k]);
  const kept = simplifyRun(run, tolerance);
  // `simplifyRun` keeps a subset in order, so walk both lists together.
  const out: number[] = [];
  let k = 0;
  for (let j = 0; j < run.length && k < kept.length; j++) {
    if (run[j] === kept[k]) {
      out.push(indices[j]);
      k++;
    }
  }
  return out;
}

/** Points from index `a` to `b` inclusive, wrapping. */
function slice(points: readonly Point[], a: number, b: number): Point[] {
  const out: Point[] = [];
  let i = a;
  for (;;) {
    out.push(points[i]);
    if (i === b) break;
    i = (i + 1) % points.length;
  }
  return out;
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface Piece {
  /** Control points; two for a line, four for a cubic. */
  points: Point[];
}

/**
 * One loop into a node. Corners split the loop into runs; each run becomes
 * a line when a line fits, else one or more cubics joined smoothly.
 *
 * The simplified polygon decides where the corners are and what the curves
 * fit; the raw boundary decides which segments are straight, because a
 * simplified chord across an arc is within tolerance by construction and
 * says nothing about straightness.
 */
function fitLoop(loop: Point[], tolerance: number, cornerAngle: number, toBoard: (x: number, y: number) => Point): SketchNode | undefined {
  const kept = simplifyLoopIndices(loop, tolerance);
  if (kept.length < 3) return undefined;
  const simplified = kept.map((i) => loop[i]);

  // A segment is a true straight edge when the raw boundary between its ends
  // hugs the chord far more tightly than the simplification allowed: a pixel
  // staircase of a straight line is within half a pixel, an arc's chord is not.
  // A pixel staircase a few pixels long is "straight" by that test too, but
  // treating it as an edge puts a corner at each end and litters a curve with
  // anchors; a straight edge has to be long enough to be one.
  const straight = kept.map((from, k) => {
    const to = kept[(k + 1) % kept.length];
    const raw = slice(loop, from, to);
    const chord = Math.hypot(raw[raw.length - 1][0] - raw[0][0], raw[raw.length - 1][1] - raw[0][1]);
    if (chord < tolerance * 10) return false;
    return raw.every((p) => pointToSegment(p, raw[0], raw[raw.length - 1]) <= Math.max(0.5, tolerance / 3));
  });

  const corners = new Set<number>(findCorners(simplified, cornerAngle));
  for (let k = 0; k < kept.length; k++) {
    if (straight[k]) {
      corners.add(k);
      corners.add((k + 1) % kept.length);
    }
  }
  const splits = corners.size >= 2 ? [...corners].sort((a, b) => a - b) : smoothSplits(simplified);

  const pieces: Piece[] = [];
  for (let i = 0; i < splits.length; i++) {
    const from = splits[i];
    const to = splits[(i + 1) % splits.length];
    if (from === to) continue;
    // One simplified segment that is straight is a line, however many raw
    // points sit along it.
    if ((from + 1) % kept.length === to && straight[from]) {
      pieces.push({ points: [simplified[from], simplified[to]] });
      continue;
    }
    // Curves are fitted to the simplified points: the staircase underneath
    // is noise at the pixel scale, and fitting it costs a cubic per wobble.
    const run = slice(simplified, from, to);
    if (run.length < 3) {
      pieces.push({ points: [run[0], run[run.length - 1]] });
      continue;
    }
    const smoothStart = corners.size < 2 || !corners.has(from);
    const smoothEnd = corners.size < 2 || !corners.has(to);
    const t0 = smoothStart ? loopTangent(simplified, from) : tangentAt(run, 0, 1);
    const t1 = smoothEnd ? negate(loopTangent(simplified, to)) : tangentAt(run, run.length - 1, -1);
    pieces.push(...fitCubics(run, t0, t1, tolerance * 1.5));
  }
  if (pieces.length === 0) return undefined;

  const allLines = pieces.every((p) => p.points.length === 2);
  if (allLines) {
    const node: PolyNode = { kind: 'poly', points: pieces.map((p) => toBoard(p.points[0][0], p.points[0][1])), closed: true };
    return node.points.length >= 3 ? node : undefined;
  }

  const anchors: Anchor[] = pieces.map((piece, i) => {
    const previous = pieces[(i + pieces.length - 1) % pieces.length];
    const p = piece.points[0];
    const anchor: Anchor = { x: 0, y: 0 };
    [anchor.x, anchor.y] = toBoard(p[0], p[1]);
    if (previous.points.length === 4) anchor.in = offset(toBoard, p, previous.points[2]);
    if (piece.points.length === 4) anchor.out = offset(toBoard, p, piece.points[1]);
    return anchor;
  });
  const node: PathNode = { kind: 'path', anchors, closed: true };
  return node;
}

/** A handle as a board offset: the mapping is affine, so it is a difference. */
function offset(toBoard: (x: number, y: number) => Point, from: Point, to: Point): Point {
  const a = toBoard(from[0], from[1]);
  const b = toBoard(to[0], to[1]);
  return [b[0] - a[0], b[1] - a[1]];
}

/** Indices of the vertices where the outline turns sharply. */
function findCorners(points: readonly Point[], cornerAngle: number): number[] {
  const n = points.length;
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const a = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]);
    const b = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
    let turn = Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    turn = (turn * 180) / Math.PI;
    if (turn >= cornerAngle) corners.push(i);
  }
  return corners;
}

/** For a loop with no corners, two cut points opposite each other. */
function smoothSplits(points: readonly Point[]): number[] {
  return [0, Math.floor(points.length / 2)];
}

function loopTangent(points: readonly Point[], i: number): Point {
  const n = points.length;
  const prev = points[(i + n - 1) % n];
  const next = points[(i + 1) % n];
  return normalize([next[0] - prev[0], next[1] - prev[1]]);
}

function tangentAt(run: readonly Point[], i: number, dir: 1 | -1): Point {
  const j = Math.max(0, Math.min(run.length - 1, i + dir));
  return normalize([run[j][0] - run[i][0], run[j][1] - run[i][1]]);
}

function normalize([x, y]: Point): Point {
  const len = Math.hypot(x, y) || 1;
  return [x / len, y / len];
}

function negate([x, y]: Point): Point {
  return [-x, -y];
}

/**
 * Schneider's fit: one cubic through the run with the given end tangents,
 * reparameterised a few times, and split at the worst point when it will
 * not do.
 */
function fitCubics(run: readonly Point[], t0: Point, t1: Point, tolerance: number): Piece[] {
  if (run.length === 2) return [{ points: [run[0], run[1]] }];
  let u = chordLengths(run);
  let cubic = generateBezier(run, u, t0, t1);
  let [error, split] = maxError(run, cubic, u);
  if (error <= tolerance) return [{ points: cubic }];
  for (let i = 0; i < 4 && error > tolerance; i++) {
    u = reparameterize(run, cubic, u);
    cubic = generateBezier(run, u, t0, t1);
    [error, split] = maxError(run, cubic, u);
  }
  if (error <= tolerance) return [{ points: cubic }];
  if (split <= 0 || split >= run.length - 1) split = Math.floor(run.length / 2);
  const centre = normalize([run[split + 1][0] - run[split - 1][0], run[split + 1][1] - run[split - 1][1]]);
  return [
    ...fitCubics(run.slice(0, split + 1), t0, negate(centre), tolerance),
    ...fitCubics(run.slice(split), centre, t1, tolerance),
  ];
}

function chordLengths(run: readonly Point[]): number[] {
  const u = [0];
  for (let i = 1; i < run.length; i++) u.push(u[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(run: readonly Point[], u: number[], t0: Point, t1: Point): Point[] {
  const first = run[0];
  const last = run[run.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < run.length; i++) {
    const t = u[i];
    const b1 = 3 * t * (1 - t) * (1 - t);
    const b2 = 3 * t * t * (1 - t);
    const a1: Point = [t0[0] * b1, t0[1] * b1];
    const a2: Point = [t1[0] * b2, t1[1] * b2];
    c00 += a1[0] * a1[0] + a1[1] * a1[1];
    c01 += a1[0] * a2[0] + a1[1] * a2[1];
    c11 += a2[0] * a2[0] + a2[1] * a2[1];
    const b0 = (1 - t) ** 3;
    const b3 = t ** 3;
    const tmp: Point = [
      run[i][0] - (first[0] * (b0 + b1) + last[0] * (b2 + b3)),
      run[i][1] - (first[1] * (b0 + b1) + last[1] * (b2 + b3)),
    ];
    x0 += a1[0] * tmp[0] + a1[1] * tmp[1];
    x1 += a2[0] * tmp[0] + a2[1] * tmp[1];
  }
  const det = c00 * c11 - c01 * c01;
  let alpha0 = det !== 0 ? (x0 * c11 - c01 * x1) / det : 0;
  let alpha1 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (alpha0 < 1e-6 || alpha1 < 1e-6 || !Number.isFinite(alpha0) || !Number.isFinite(alpha1)) {
    alpha0 = alpha1 = chord / 3;
  }
  // Handles longer than the chord itself are a loop the points never drew.
  alpha0 = Math.min(alpha0, chord);
  alpha1 = Math.min(alpha1, chord);
  return [first, [first[0] + t0[0] * alpha0, first[1] + t0[1] * alpha0], [last[0] + t1[0] * alpha1, last[1] + t1[1] * alpha1], last];
}

function bezierPoint(c: Point[], t: number): Point {
  const u = 1 - t;
  return [
    u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
    u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1],
  ];
}

function maxError(run: readonly Point[], cubic: Point[], u: number[]): [number, number] {
  let worst = 0;
  let index = Math.floor(run.length / 2);
  for (let i = 1; i < run.length - 1; i++) {
    const p = bezierPoint(cubic, u[i]);
    const d = (p[0] - run[i][0]) ** 2 + (p[1] - run[i][1]) ** 2;
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  return [Math.sqrt(worst), index];
}

/** One Newton step per point toward the parameter nearest it. */
function reparameterize(run: readonly Point[], cubic: Point[], u: number[]): number[] {
  return u.map((t, i) => {
    const p = run[i];
    const q = bezierPoint(cubic, t);
    const d1 = derivative(cubic, t);
    const d2 = secondDerivative(cubic, t);
    const numerator = (q[0] - p[0]) * d1[0] + (q[1] - p[1]) * d1[1];
    const denominator = d1[0] * d1[0] + d1[1] * d1[1] + (q[0] - p[0]) * d2[0] + (q[1] - p[1]) * d2[1];
    if (Math.abs(denominator) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - numerator / denominator));
  });
}

function derivative(c: Point[], t: number): Point {
  const u = 1 - t;
  return [
    3 * u * u * (c[1][0] - c[0][0]) + 6 * u * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]),
    3 * u * u * (c[1][1] - c[0][1]) + 6 * u * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1]),
  ];
}

function secondDerivative(c: Point[], t: number): Point {
  const u = 1 - t;
  return [
    6 * u * (c[2][0] - 2 * c[1][0] + c[0][0]) + 6 * t * (c[3][0] - 2 * c[2][0] + c[1][0]),
    6 * u * (c[2][1] - 2 * c[1][1] + c[0][1]) + 6 * t * (c[3][1] - 2 * c[2][1] + c[1][1]),
  ];
}
