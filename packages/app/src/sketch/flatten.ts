/**
 * From outlines to rings: the sampled polygons a drawing is made of.
 *
 * Everything that looks at the drawing as geometry — the filled preview, the
 * hole test, the SVG's grouping, the size in the footer — reads these rings,
 * so what is on screen is what gets built. An outline that cannot enclose
 * anything (open, crossing itself, or too small to matter) is kept and marked
 * rather than dropped, because the person drawing needs to see which one.
 */

import { groupKey, type Anchor, type Point, type SketchDocument, type SketchNode } from './doc.js';

export type RingStatus = 'solid' | 'hole' | 'open' | 'crossing' | 'tiny' | 'cut';

export interface Ring {
  points: Point[];
  /** Index of the node this ring came from. */
  node: number;
  /** The group it belongs to; `''` for a loose outline. */
  group: string;
  status: RingStatus;
  /** How many enclosing rings there are: even is material, odd is a hole. */
  depth: number;
  /** Signed; positive is counter-clockwise. */
  area: number;
}

export interface Island {
  outer: Ring;
  holes: Ring[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Points per full turn of a circle or arc when sampling for the screen. */
export const DEFAULT_STEPS = 64;
/** Rings this small, in mm², enclose nothing anybody meant. */
const TINY_AREA = 1e-3;
/** The self-crossing test is quadratic; past this it is skipped. */
const CROSSING_LIMIT = 600;

export function ringOf(node: SketchNode, index: number, steps = DEFAULT_STEPS): Ring {
  const points = samplePoints(node, steps);
  const closed = node.kind === 'rect' || node.kind === 'circle' || node.closed;
  const area = closed ? signedArea(points) : 0;
  let status: RingStatus = 'solid';
  if (!closed || points.length < 3) status = 'open';
  else if (selfCrossing(points)) status = 'crossing';
  else if (Math.abs(area) < TINY_AREA) status = 'tiny';
  else if (node.cut) status = 'cut';
  return { points, node: index, group: groupKey(node), status, depth: 0, area };
}

/**
 * Samples every outline, then decides which rings are holes.
 *
 * A ring inside one other ring is a hole; inside two it is material again
 * (an island in a hole). Overlapping rings at the same depth are both
 * material — the union is left to whatever consumes the SVG, which is how
 * OpenSCAD reads separate elements.
 */
export function flattenSketch(doc: SketchDocument, steps = DEFAULT_STEPS): { rings: Ring[]; islands: Island[] } {
  const rings = doc.nodes.map((node, index) => ringOf(node, index, steps));
  const islands: Island[] = [];
  // Nesting is judged within a group: a circle inside a box is a hole when
  // they are in the same group, and another object on top of it otherwise.
  const groups = new Set(rings.map((r) => r.group));
  for (const group of groups) islands.push(...nestGroup(rings.filter((r) => r.group === group && r.status === 'solid')));
  return { rings, islands };
}

/** Erased regions nested among themselves: a cut inside a cut is material again. */
export function cutIslands(cuts: Ring[]): Island[] {
  return nestGroup(cuts, false);
}

/**
 * The islands among a set of closed rings. With `mark`, each ring's depth
 * and hole status are written back, which is what the drawing's rings want;
 * cuts are nested the same way without being relabelled.
 */
function nestGroup(closed: Ring[], mark = true): Island[] {

  // The enclosing ring must be the larger, so two identical rings do not each
  // count as the other's hole.
  const boxes = new Map(closed.map((ring) => [ring, boundsOfRings([ring])!]));
  const parents = new Map<Ring, Ring[]>();
  const depthOf = new Map<Ring, number>();
  for (const ring of closed) {
    const inside = closed.filter(
      (other) =>
        other !== ring && Math.abs(other.area) > Math.abs(ring.area) && ringInside(ring, other, boxes),
    );
    parents.set(ring, inside);
    depthOf.set(ring, inside.length);
    if (mark) {
      ring.depth = inside.length;
      ring.status = inside.length % 2 === 1 ? 'hole' : 'solid';
    }
  }
  const isHole = (ring: Ring): boolean => depthOf.get(ring)! % 2 === 1;

  const islands: Island[] = [];
  for (const ring of closed) {
    if (isHole(ring)) continue;
    const holes = closed.filter((other) => {
      if (!isHole(other)) return false;
      // Its immediate parent is the smallest ring around it.
      const around = parents.get(other) ?? [];
      const parent = around.reduce<Ring | undefined>(
        (best, candidate) => (!best || Math.abs(candidate.area) < Math.abs(best.area) ? candidate : best),
        undefined,
      );
      return parent === ring;
    });
    islands.push({ outer: ring, holes });
  }
  return islands;
}

export function boundsOfRings(rings: readonly Ring[]): Bounds | undefined {
  let bounds: Bounds | undefined;
  for (const ring of rings) {
    for (const [x, y] of ring.points) {
      if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
  }
  return bounds;
}

/** Bounds of what would be material: rings that are solid or holes. */
export function boundsOfSketch(doc: SketchDocument): Bounds | undefined {
  const { rings } = flattenSketch(doc);
  return boundsOfRings(rings.filter((r) => r.status === 'solid' || r.status === 'hole'));
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function samplePoints(node: SketchNode, steps: number): Point[] {
  switch (node.kind) {
    case 'rect':
      return sampleRect(node.x, node.y, node.w, node.h, node.r, steps);
    case 'circle':
      return sampleArc(node.cx, node.cy, node.r, 0, Math.PI * 2, steps, false);
    case 'poly':
      return dedupe(node.points.map(([x, y]) => [x, y]));
    case 'path':
      return dedupe(samplePath(node.anchors, node.closed));
  }
}

function sampleRect(x: number, y: number, w: number, h: number, r: number, steps: number): Point[] {
  if (r <= 0 || w <= 0 || h <= 0) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  }
  const radius = Math.min(r, w / 2, h / 2);
  const out: Point[] = [];
  const corners: [number, number, number][] = [
    [x + w - radius, y + radius, -Math.PI / 2],
    [x + w - radius, y + h - radius, 0],
    [x + radius, y + h - radius, Math.PI / 2],
    [x + radius, y + radius, Math.PI],
  ];
  for (const [cx, cy, start] of corners) {
    out.push(...sampleArc(cx, cy, radius, start, start + Math.PI / 2, steps, true));
  }
  return dedupe(out);
}

/** Points along an arc; `inclusive` keeps the end point, a full circle does not. */
function sampleArc(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  stepsPerTurn: number,
  inclusive: boolean,
): Point[] {
  const sweep = end - start;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * stepsPerTurn));
  const out: Point[] = [];
  const last = inclusive ? n : n - 1;
  for (let i = 0; i <= last; i++) {
    const a = start + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function samplePath(anchors: Anchor[], closed: boolean): Point[] {
  if (anchors.length === 0) return [];
  const out: Point[] = [[anchors[0].x, anchors[0].y]];
  const count = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < count; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    out.push(...sampleSegment(a, b));
  }
  return out;
}

/** The points of the segment from `a` to `b`, excluding `a`. */
export function sampleSegment(a: Anchor, b: Anchor): Point[] {
  if (!a.out && !b.in) return [[b.x, b.y]];
  const c1: Point = [a.x + (a.out?.[0] ?? 0), a.y + (a.out?.[1] ?? 0)];
  const c2: Point = [b.x + (b.in?.[0] ?? 0), b.y + (b.in?.[1] ?? 0)];
  const length =
    Math.hypot(c1[0] - a.x, c1[1] - a.y) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(b.x - c2[0], b.y - c2[1]);
  // About a point every half millimetre along the control polygon, within
  // reason: a hairline curve still gets a few, a long one does not get hundreds.
  const n = Math.max(4, Math.min(64, Math.ceil(length * 2)));
  const out: Point[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * a.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.y,
    ]);
  }
  return out;
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(last[0] - first[0]) < 1e-9 && Math.abs(last[1] - first[1]) < 1e-9) out.pop();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function signedArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function pointInRing(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether `ring` lies within `other`.
 *
 * One vertex is not enough to ask: a box drawn flush against another has its
 * corner on the other's edge, and the edge rule decides the answer. So the
 * boxes are compared first, and then a spread of the ring's vertices has to
 * be inside — a spread rather than all of them, because a traced outline can
 * have hundreds of rings with hundreds of points each.
 */
function ringInside(ring: Ring, other: Ring, boxes: Map<Ring, Bounds>): boolean {
  const a = boxes.get(ring)!;
  const b = boxes.get(other)!;
  const eps = 1e-9;
  if (a.minX < b.minX - eps || a.maxX > b.maxX + eps || a.minY < b.minY - eps || a.maxY > b.maxY + eps) return false;
  const n = ring.points.length;
  const samples = Math.min(n, 24);
  for (let i = 0; i < samples; i++) {
    if (!pointInRing(ring.points[Math.floor((i * n) / samples)], other.points)) return false;
  }
  return true;
}

function selfCrossing(points: readonly Point[]): boolean {
  const n = points.length;
  if (n < 4 || n > CROSSING_LIMIT) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // Neighbouring segments share a vertex and never count.
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a1, a2, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}
