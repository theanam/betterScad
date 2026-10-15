/**
 * A drawing: outlines in millimetres, as the plate is seen from above.
 *
 * Y points up, the way the model's own XY plane does, so a shape drawn here
 * lands in the same place `square()` would put it. The document is kept as
 * primitives and curves rather than points: a rounded box is a box with a
 * radius, not forty-eight vertices, which is what keeps it editable, keeps it
 * small enough to travel inside the SVG it becomes, and lets a measurement be
 * typed into it.
 */

export type Point = [number, number];

/** What every outline carries besides its shape. */
export interface NodeBase {
  /**
   * The group this outline belongs to, if any. A group moves, selects and
   * is cut as one thing; what is inside what is judged within it, and groups
   * union with each other.
   */
  group?: string;
  /**
   * An eraser region: material taken out of its group rather than added to
   * it. Always a plain polygon, because it was computed, not drawn.
   */
  cut?: boolean;
}

export interface RectNode extends NodeBase {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius, 0 for sharp corners. */
  r: number;
}

export interface CircleNode extends NodeBase {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export interface PolyNode extends NodeBase {
  kind: 'poly';
  points: Point[];
  closed: boolean;
}

/**
 * One point of a pen path, with its curve handles as offsets from the point.
 *
 * `out` is the handle the curve leaves along, `in` the one it arrives along.
 * A side with no handle is a corner on that side: two corners in a row make a
 * straight segment. The pen draws smooth points, where `in` is `-out`; a
 * traced outline may need the two to differ, which is why both are kept.
 */
export interface Anchor {
  x: number;
  y: number;
  in?: Point;
  out?: Point;
}

export interface PathNode extends NodeBase {
  kind: 'path';
  anchors: Anchor[];
  closed: boolean;
}

export type SketchNode = RectNode | CircleNode | PolyNode | PathNode;

export interface SketchDocument {
  version: 1;
  nodes: SketchNode[];
}

/** Coordinates are kept to a thousandth of a millimetre. */
export function round(value: number): number {
  // `|| 0` turns the -0 a negative rounding can leave into a plain 0.
  return Math.round(value * 1000) / 1000 || 0;
}

export const MAX_NODES = 2000;
export const MAX_POINTS = 20000;

export function emptySketch(): SketchDocument {
  return { version: 1, nodes: [] };
}

/**
 * Validates and copies a document, rounding every number.
 *
 * Throws on anything that is not a drawing. This is the one gate everything
 * arriving from outside passes through — a file, the clipboard, a trace — so
 * the editor never has to doubt what it holds.
 */
export function normalizeSketch(raw: unknown): SketchDocument {
  if (!raw || typeof raw !== 'object') throw new Error('Not a drawing.');
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) throw new Error('A drawing needs a list of outlines.');
  if (nodes.length > MAX_NODES) throw new Error(`A drawing holds at most ${MAX_NODES} outlines.`);
  let points = 0;
  const out: SketchNode[] = [];
  for (const node of nodes) {
    const normalized = normalizeNode(node);
    points += pointCount(normalized);
    if (points > MAX_POINTS) throw new Error(`A drawing holds at most ${MAX_POINTS} points.`);
    out.push(normalized);
  }
  return { version: 1, nodes: out };
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} is not a number.`);
  return round(value);
}

function point(value: unknown, what: string): Point {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${what} is not a point.`);
  return [num(value[0], what), num(value[1], what)];
}

function normalizeNode(raw: unknown): SketchNode {
  if (!raw || typeof raw !== 'object') throw new Error('An outline is missing.');
  const node = raw as Record<string, unknown>;
  const shaped = normalizeShape(node);
  if (typeof node.group === 'string' && node.group) shaped.group = node.group;
  if (node.cut === true) {
    if (shaped.kind !== 'poly' || !shaped.closed) throw new Error('An erased region must be a closed polygon.');
    shaped.cut = true;
  }
  return shaped;
}

function normalizeShape(node: Record<string, unknown>): SketchNode {
  switch (node.kind) {
    case 'rect': {
      const w = Math.abs(num(node.w, 'Width'));
      const h = Math.abs(num(node.h, 'Height'));
      const r = Math.max(0, Math.min(num(node.r ?? 0, 'Radius'), round(Math.min(w, h) / 2)));
      return { kind: 'rect', x: num(node.x, 'x'), y: num(node.y, 'y'), w, h, r };
    }
    case 'circle':
      return { kind: 'circle', cx: num(node.cx, 'cx'), cy: num(node.cy, 'cy'), r: Math.abs(num(node.r, 'Radius')) };
    case 'poly': {
      if (!Array.isArray(node.points)) throw new Error('A line needs points.');
      return { kind: 'poly', points: node.points.map((p) => point(p, 'A point')), closed: node.closed === true };
    }
    case 'path': {
      if (!Array.isArray(node.anchors)) throw new Error('A curve needs points.');
      const anchors: Anchor[] = node.anchors.map((raw) => {
        const a = raw as Record<string, unknown>;
        const anchor: Anchor = { x: num(a.x, 'x'), y: num(a.y, 'y') };
        if (a.in != null) anchor.in = point(a.in, 'A handle');
        if (a.out != null) anchor.out = point(a.out, 'A handle');
        return anchor;
      });
      return { kind: 'path', anchors, closed: node.closed === true };
    }
    default:
      throw new Error(`Unknown outline kind "${String(node.kind)}".`);
  }
}

function pointCount(node: SketchNode): number {
  switch (node.kind) {
    case 'poly':
      return node.points.length;
    case 'path':
      return node.anchors.length;
    default:
      return 4;
  }
}

/** The key a node's group is filed under; loose outlines share one. */
export function groupKey(node: SketchNode): string {
  return node.group ?? '';
}

let nextGroup = Date.now() % 100000;

/** A group id no drawing has used: short, and distinct from every other. */
export function newGroupId(doc: SketchDocument): string {
  const taken = new Set(doc.nodes.map((n) => n.group).filter(Boolean));
  let id: string;
  do id = `g${(nextGroup++).toString(36)}`;
  while (taken.has(id));
  return id;
}

/** FNV-1a over the JSON; equal drawings digest equal. */
export function digestSketch(doc: SketchDocument): string {
  const text = JSON.stringify(doc.nodes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function cloneNode<T extends SketchNode>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}

/** The node moved by (dx, dy); handles are offsets, so they stay. */
export function translateNode<T extends SketchNode>(node: T, dx: number, dy: number): T {
  return mapPoints(node, (x, y) => [x + dx, y + dy]);
}

/** The node scaled by `factor` about a point. Handles scale with it. */
export function scaleNode<T extends SketchNode>(node: T, factor: number, about: Point): T {
  const scaled = mapPoints(node, (x, y) => [about[0] + (x - about[0]) * factor, about[1] + (y - about[1]) * factor]);
  switch (scaled.kind) {
    case 'rect':
      return { ...scaled, w: round(scaled.w * factor), h: round(scaled.h * factor), r: round(scaled.r * factor) } as T;
    case 'circle':
      return { ...scaled, r: round(scaled.r * factor) } as T;
    case 'path':
      return {
        ...scaled,
        anchors: scaled.anchors.map((a) => ({
          ...a,
          ...(a.in ? { in: [round(a.in[0] * factor), round(a.in[1] * factor)] as Point } : {}),
          ...(a.out ? { out: [round(a.out[0] * factor), round(a.out[1] * factor)] as Point } : {}),
        })),
      } as T;
    default:
      return scaled;
  }
}

/** Every absolute position in the node passed through `f`; handles untouched. */
export function mapPoints<T extends SketchNode>(node: T, f: (x: number, y: number) => Point): T {
  const p = (x: number, y: number): Point => {
    const [nx, ny] = f(x, y);
    return [round(nx), round(ny)];
  };
  switch (node.kind) {
    case 'rect': {
      const [x, y] = p(node.x, node.y);
      return { ...node, x, y };
    }
    case 'circle': {
      const [cx, cy] = p(node.cx, node.cy);
      return { ...node, cx, cy };
    }
    case 'poly':
      return { ...node, points: node.points.map(([x, y]) => p(x, y)) };
    case 'path':
      return {
        ...node,
        anchors: node.anchors.map((a) => {
          const [x, y] = p(a.x, a.y);
          return { ...a, x, y };
        }),
      };
  }
}
