/**
 * Smart guides: snapping to what is already drawn.
 *
 * The grid is one kind of alignment; the other is the drawing itself. A
 * point being placed, or a shape being dragged, pulls to the corners,
 * centres and edges of its neighbours when it comes within a few pixels of
 * lining up with one — and a guide line shows what it lined up with, which
 * is the part that makes snapping feel like help rather than interference.
 */

import type { Point, SketchNode } from './doc.js';

/** A key point of an outline that other things can align to. */
export interface Target {
  at: Point;
  node: number;
}

export interface Guide {
  axis: 'x' | 'y';
  /** The coordinate everything on this guide shares. */
  at: number;
  /** The target it came from, so it can be marked. */
  target: Point;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  /** Set when both axes landed on one target: a point-to-point snap. */
  point?: Point;
}

/** Past this many vertices an outline offers only its box and centre. */
const MANY = 48;

/** The points of a node worth aligning to. */
export function targetsOf(node: SketchNode, index: number): Target[] {
  const out: Target[] = [];
  const add = (x: number, y: number): void => {
    out.push({ at: [x, y], node: index });
  };
  switch (node.kind) {
    case 'rect': {
      const { x, y, w, h } = node;
      add(x, y);
      add(x + w, y);
      add(x + w, y + h);
      add(x, y + h);
      add(x + w / 2, y);
      add(x + w, y + h / 2);
      add(x + w / 2, y + h);
      add(x, y + h / 2);
      add(x + w / 2, y + h / 2);
      break;
    }
    case 'circle': {
      const { cx, cy, r } = node;
      add(cx, cy);
      add(cx + r, cy);
      add(cx - r, cy);
      add(cx, cy + r);
      add(cx, cy - r);
      break;
    }
    case 'poly':
      addPoints(node.points, add);
      break;
    case 'path':
      addPoints(
        node.anchors.map((a) => [a.x, a.y] as Point),
        add,
      );
      break;
  }
  return out;
}

function addPoints(points: readonly Point[], add: (x: number, y: number) => void): void {
  if (points.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (points.length <= MANY) for (const [x, y] of points) add(x, y);
  else {
    add(minX, minY);
    add(maxX, minY);
    add(maxX, maxY);
    add(minX, maxY);
  }
  add((minX + maxX) / 2, (minY + maxY) / 2);
}

/** Every target in the drawing except those of one node, plus the origin. */
export function collectTargets(nodes: readonly SketchNode[], exclude?: number | ReadonlySet<number>): Target[] {
  const out: Target[] = [{ at: [0, 0], node: -1 }];
  const skip = typeof exclude === 'number' ? new Set([exclude]) : exclude;
  nodes.forEach((node, index) => {
    if (!skip?.has(index) && !node.cut) out.push(...targetsOf(node, index));
  });
  return out;
}

/**
 * The shift that lines `moving` up with the targets.
 *
 * A target within `pointTolerance` of one of the moving points as a point —
 * both axes at once — wins outright: that is a corner landing on a corner. Failing
 * that, each axis is taken on its own, nearest alignment first, so a corner
 * can share an x with one neighbour and a y with another — which is what
 * lining a box up between two others means.
 */
export function snapToTargets(
  moving: readonly Point[],
  targets: readonly Target[],
  tolerance: number,
  pointTolerance = tolerance,
): SnapResult {
  let point: { d: number; target: Point; moving: Point } | undefined;
  let bestX: { d: number; target: Point } | undefined;
  let bestY: { d: number; target: Point } | undefined;
  for (const p of moving) {
    for (const t of targets) {
      const dx = t.at[0] - p[0];
      const dy = t.at[1] - p[1];
      const d = Math.hypot(dx, dy);
      if (d <= pointTolerance && (!point || d < point.d)) point = { d, target: t.at, moving: p };
      if (Math.abs(dx) <= tolerance && (!bestX || Math.abs(dx) < Math.abs(bestX.d))) bestX = { d: dx, target: t.at };
      if (Math.abs(dy) <= tolerance && (!bestY || Math.abs(dy) < Math.abs(bestY.d))) bestY = { d: dy, target: t.at };
    }
  }
  if (point) {
    return {
      dx: point.target[0] - point.moving[0],
      dy: point.target[1] - point.moving[1],
      guides: [
        { axis: 'x', at: point.target[0], target: point.target },
        { axis: 'y', at: point.target[1], target: point.target },
      ],
      point: point.target,
    };
  }
  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: 'x', at: bestX.target[0], target: bestX.target });
  if (bestY) guides.push({ axis: 'y', at: bestY.target[1], target: bestY.target });
  return { dx: bestX?.d ?? 0, dy: bestY?.d ?? 0, guides };
}
