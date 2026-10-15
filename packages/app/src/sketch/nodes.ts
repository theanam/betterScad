/**
 * The outlines as things you can point at: making them from gestures,
 * hit-testing, grips, and the measurements written beside them.
 *
 * There is no constraint solver. A typed measurement is an edit applied once,
 * and what it moves is decided per kind and written down here: a box's width
 * moves its right edge, a circle's diameter grows about its centre, a
 * segment's length moves its far end along its own direction.
 */

import { round, type Anchor, type CircleNode, type PathNode, type Point, type PolyNode, type RectNode, type SketchNode } from './doc.js';
import { pointInRing, type Ring } from './flatten.js';

/** Shapes smaller than this, in mm, are a click that did not mean to drag. */
const MIN_SIZE = 0.05;
/** Past this many anchors a path moves as a whole rather than offering grips. */
export const MAX_GRIPS = 24;

// ---------------------------------------------------------------------------
// From gestures
// ---------------------------------------------------------------------------

export function rectFrom(a: Point, b: Point): RectNode | undefined {
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  if (w < MIN_SIZE || h < MIN_SIZE) return undefined;
  return { kind: 'rect', x: round(Math.min(a[0], b[0])), y: round(Math.min(a[1], b[1])), w: round(w), h: round(h), r: 0 };
}

export function circleFrom(centre: Point, edge: Point): CircleNode | undefined {
  const r = Math.hypot(edge[0] - centre[0], edge[1] - centre[1]);
  if (r < MIN_SIZE) return undefined;
  return { kind: 'circle', cx: round(centre[0]), cy: round(centre[1]), r: round(r) };
}

/** A line run: closed when it has enough points to enclose anything. */
export function polyFrom(points: Point[]): PolyNode | undefined {
  if (points.length < 2) return undefined;
  return { kind: 'poly', points: points.map(([x, y]) => [round(x), round(y)]), closed: points.length >= 3 };
}

export function pathFrom(anchors: Anchor[], closed: boolean): PathNode | undefined {
  if (anchors.length < 2) return undefined;
  return { kind: 'path', anchors: anchors.map(roundAnchor), closed };
}

/**
 * Whether the pen can close here. Straight lines need three points to
 * enclose anything; two curved ones make a leaf, the simplest curved shape.
 */
export function canClosePath(anchors: Anchor[]): boolean {
  if (anchors.length >= 3) return true;
  return anchors.length === 2 && anchors.some((a) => a.in || a.out);
}

/** A smooth anchor from the pen: the handle pulled out is both sides at once. */
export function smoothAnchor(at: Point, handle: Point | undefined): Anchor {
  const anchor: Anchor = { x: at[0], y: at[1] };
  if (handle && Math.hypot(handle[0], handle[1]) >= MIN_SIZE) {
    anchor.out = [handle[0], handle[1]];
    anchor.in = [-handle[0], -handle[1]];
  }
  return roundAnchor(anchor);
}

function roundAnchor(a: Anchor): Anchor {
  const out: Anchor = { x: round(a.x), y: round(a.y) };
  if (a.in) out.in = [round(a.in[0]), round(a.in[1])];
  if (a.out) out.out = [round(a.out[0]), round(a.out[1])];
  return out;
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

/**
 * The topmost outline under a point: inside a closed ring, or within
 * `tolerance` millimetres of any segment.
 */
export function ringAt(rings: readonly Ring[], p: Point, tolerance: number): Ring | undefined {
  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    const closed = ring.status !== 'open';
    if (closed && ring.points.length >= 3 && pointInRing(p, ring.points)) return ring;
    if (distanceToRing(p, ring.points, closed) <= tolerance) return ring;
  }
  return undefined;
}

export function distanceToRing(p: Point, points: readonly Point[], closed: boolean): number {
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    best = Math.min(best, distanceToSegment(p, points[i], points[(i + 1) % points.length]));
  }
  if (points.length === 1) best = Math.hypot(p[0] - points[0][0], p[1] - points[0][1]);
  return best;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ---------------------------------------------------------------------------
// Grips
// ---------------------------------------------------------------------------

export interface Grip {
  id: string;
  at: Point;
}

export function gripsOf(node: SketchNode): Grip[] {
  // An erased region was computed, not drawn; it is moved or restored, never reshaped.
  if (node.cut) return [];
  switch (node.kind) {
    case 'rect':
      return [
        { id: 'c0', at: [node.x, node.y] },
        { id: 'c1', at: [node.x + node.w, node.y] },
        { id: 'c2', at: [node.x + node.w, node.y + node.h] },
        { id: 'c3', at: [node.x, node.y + node.h] },
      ];
    case 'circle':
      // Four, like a box's corners: one on the rim is easy to miss, and any
      // of them is a radius to drag.
      return [
        { id: 'r0', at: [node.cx + node.r, node.cy] },
        { id: 'r1', at: [node.cx, node.cy + node.r] },
        { id: 'r2', at: [node.cx - node.r, node.cy] },
        { id: 'r3', at: [node.cx, node.cy - node.r] },
      ];
    case 'poly':
      return node.points.length > MAX_GRIPS ? [] : node.points.map((p, i) => ({ id: `v${i}`, at: p }));
    case 'path':
      return node.anchors.length > MAX_GRIPS ? [] : node.anchors.map((a, i) => ({ id: `a${i}`, at: [a.x, a.y] }));
  }
}

/** The node with one grip moved to `to`. */
export function moveGrip(node: SketchNode, id: string, to: Point): SketchNode {
  const [x, y] = [round(to[0]), round(to[1])];
  switch (node.kind) {
    case 'rect': {
      // The opposite corner stays where it is.
      const corner = Number(id.slice(1));
      const fixed: Point = [corner === 1 || corner === 2 ? node.x : node.x + node.w, corner >= 2 ? node.y : node.y + node.h];
      const w = Math.abs(x - fixed[0]);
      const h = Math.abs(y - fixed[1]);
      if (w < MIN_SIZE || h < MIN_SIZE) return node;
      const r = Math.min(node.r, round(Math.min(w, h) / 2));
      return { ...node, x: round(Math.min(x, fixed[0])), y: round(Math.min(y, fixed[1])), w: round(w), h: round(h), r };
    }
    case 'circle': {
      const r = round(Math.hypot(x - node.cx, y - node.cy));
      return r < MIN_SIZE ? node : { ...node, r };
    }
    case 'poly': {
      const index = Number(id.slice(1));
      return { ...node, points: node.points.map((p, i) => (i === index ? [x, y] : p)) };
    }
    case 'path': {
      const index = Number(id.slice(1));
      return { ...node, anchors: node.anchors.map((a, i) => (i === index ? { ...a, x, y } : a)) };
    }
  }
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface Dimension {
  id: string;
  /** Where the label sits, in millimetres. */
  at: Point;
  value: number;
  /** A short word before the number, for a measurement that is not a length. */
  label?: string;
  /** Direction away from the shape, so the label can be nudged clear of it. */
  away: Point;
}

export function dimensionsOf(node: SketchNode): Dimension[] {
  if (node.cut) return [];
  switch (node.kind) {
    case 'rect':
      return [
        { id: 'w', at: [node.x + node.w / 2, node.y], value: node.w, away: [0, -1] },
        { id: 'h', at: [node.x + node.w, node.y + node.h / 2], value: node.h, away: [1, 0] },
        { id: 'r', at: [node.x + node.w, node.y + node.h], value: node.r, label: 'R', away: [0.7, 0.7] },
      ];
    case 'circle':
      return [{ id: 'd', at: [node.cx, node.cy + node.r], value: round(node.r * 2), label: 'Ø', away: [0, 1] }];
    case 'poly': {
      // A traced outline with dozens of sides is a swarm of numbers, none of
      // which anybody would type; it gets a size instead, like a curve.
      if (node.points.length > MAX_LABELLED_SIDES) return [acrossOf(node.points)];
      const count = node.closed ? node.points.length : node.points.length - 1;
      const out: Dimension[] = [];
      const centre = centroid(node.points);
      for (let i = 0; i < count; i++) {
        const a = node.points[i];
        const b = node.points[(i + 1) % node.points.length];
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        out.push({ id: `s${i}`, at: mid, value: round(Math.hypot(b[0] - a[0], b[1] - a[1])), away: awayFrom(mid, centre, a, b) });
      }
      return out;
    }
    case 'path':
      // Somebody else's curves have no segment lengths worth typing, but they
      // have a size, and typing that scales the whole thing.
      return [acrossOf(node.anchors.map((a) => [a.x, a.y]))];
  }
}

/** Past this many sides a polygon is measured as a whole. */
const MAX_LABELLED_SIDES = 12;

function acrossOf(points: readonly Point[]): Dimension {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  return { id: 'across', at: [(minX + maxX) / 2, minY], value: round(maxX - minX), label: 'Across', away: [0, -1] };
}

/** The node with one measurement set to `value`; unchanged if it cannot be. */
export function applyDimension(node: SketchNode, id: string, value: number): SketchNode {
  if (!Number.isFinite(value)) return node;
  switch (node.kind) {
    case 'rect': {
      if (id === 'w' && value >= MIN_SIZE) return { ...node, w: round(value), r: Math.min(node.r, round(Math.min(value, node.h) / 2)) };
      if (id === 'h' && value >= MIN_SIZE) return { ...node, h: round(value), r: Math.min(node.r, round(Math.min(node.w, value) / 2)) };
      if (id === 'r') return { ...node, r: round(Math.max(0, Math.min(value, Math.min(node.w, node.h) / 2))) };
      return node;
    }
    case 'circle':
      return id === 'd' && value >= MIN_SIZE ? { ...node, r: round(value / 2) } : node;
    case 'poly': {
      if (id === 'across') {
        const scaled = scaleAcross(node.points.map((p) => ({ x: p[0], y: p[1] })), value);
        return scaled ? { ...node, points: scaled.map((a) => [a.x, a.y] as Point) } : node;
      }
      const i = Number(id.slice(1));
      const a = node.points[i];
      const b = node.points[(i + 1) % node.points.length];
      if (!a || !b || value < MIN_SIZE) return node;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) return node;
      const moved: Point = [round(a[0] + ((b[0] - a[0]) * value) / len), round(a[1] + ((b[1] - a[1]) * value) / len)];
      const j = (i + 1) % node.points.length;
      return { ...node, points: node.points.map((p, k) => (k === j ? moved : p)) };
    }
    case 'path': {
      if (id !== 'across') return node;
      const scaled = scaleAcross(node.anchors, value);
      return scaled ? { ...node, anchors: scaled } : node;
    }
  }
}

/** Points scaled about their middle so their width becomes `value`; handles too. */
function scaleAcross<T extends Anchor>(points: readonly T[], value: number): T[] | undefined {
  if (value < MIN_SIZE) return undefined;
  const xs = points.map((a) => a.x);
  const width = Math.max(...xs) - Math.min(...xs);
  if (width < 1e-9) return undefined;
  const factor = value / width;
  const ys = points.map((a) => a.y);
  const about: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const scale = (p: Point): Point => [round(p[0] * factor), round(p[1] * factor)];
  return points.map((a) => ({
    ...a,
    x: round(about[0] + (a.x - about[0]) * factor),
    y: round(about[1] + (a.y - about[1]) * factor),
    ...(a.in ? { in: scale(a.in) } : {}),
    ...(a.out ? { out: scale(a.out) } : {}),
  }));
}

function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  return points.length ? [x / points.length, y / points.length] : [0, 0];
}

/** The segment's normal pointing away from the shape's middle. */
function awayFrom(mid: Point, centre: Point, a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if ((mid[0] - centre[0]) * nx + (mid[1] - centre[1]) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

// ---------------------------------------------------------------------------
// While drawing
// ---------------------------------------------------------------------------

export interface Readout {
  /** Length of the segment being drawn. */
  length: number;
  /** The angle at the previous point, in degrees: 90 is a right angle, 180 straight on. */
  angle?: number;
  at: Point;
}

/**
 * What the line in progress is deciding: how long the new segment is, and
 * what corner it makes with the one before. The angle is *at* the previous
 * point, which is the number people ask for.
 */
export function readoutFor(points: readonly Point[], cursor: Point): Readout | undefined {
  if (points.length === 0) return undefined;
  const last = points[points.length - 1];
  const length = round(Math.hypot(cursor[0] - last[0], cursor[1] - last[1]));
  const readout: Readout = { length, at: [(last[0] + cursor[0]) / 2, (last[1] + cursor[1]) / 2] };
  if (points.length >= 2 && length > MIN_SIZE) {
    const prev = points[points.length - 2];
    const a = Math.atan2(prev[1] - last[1], prev[0] - last[0]);
    const b = Math.atan2(cursor[1] - last[1], cursor[0] - last[0]);
    let deg = (Math.abs(a - b) * 180) / Math.PI;
    if (deg > 180) deg = 360 - deg;
    readout.angle = Math.round(deg * 10) / 10;
  }
  return readout;
}
