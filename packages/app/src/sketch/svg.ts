/**
 * A drawing as an SVG file, and back.
 *
 * The file is two things at once. Its paths are the drawing in plain SVG, in
 * millimetres, which `import()` reads and OpenSCAD reads just the same — that
 * is what makes the Files panel the right home for a drawing, and why one
 * needs no format of its own. Its `<metadata>` carries the editable document,
 * which nothing but the drawing tool looks at, so reopening the file gives
 * back boxes, circles and curves rather than the points they became.
 *
 * Grouping follows how an SVG is read: every subpath of one `<path>` cuts or
 * fills under that path's fill rule, and separate `<path>`s are unioned. So
 * each piece of material becomes one path with its holes as subpaths, and two
 * overlapping outlines become two paths that merge.
 */

import { groupKey, normalizeSketch, round, type Anchor, type Point, type SketchDocument, type SketchNode } from './doc.js';
import { cutIslands, flattenSketch, type Bounds, type Island } from './flatten.js';

const NAMESPACE = 'https://betterscad.org/sketch';
const TAG = 'bscad:sketch';

export interface SketchSvg {
  text: string;
  /** Size of the drawing in millimetres, as the file declares it. */
  width: number;
  height: number;
  /** How many closed outlines made it into the file. */
  shapes: number;
}

/**
 * A 2D boolean, done elsewhere (the kernel, in the render worker). `inside`
 * and `outside` are islands: a list of contours each, filled even-odd.
 */
export type Clip = (op: 'region' | 'material', inside: Point[][][], outside: Point[][][]) => Promise<Point[][]>;

/** Final polygons for the groups that have erased regions, by group key. */
export type Resolved = Record<string, Point[][]>;

/**
 * Works out what each group with erased regions is actually made of. A
 * group without cuts needs nothing: its islands are written as they are.
 */
export async function resolveCuts(doc: SketchDocument, clip: Clip): Promise<Resolved> {
  const { rings, islands } = flattenSketch(doc);
  const out: Resolved = {};
  const groups = new Set(rings.filter((r) => r.status === 'cut').map((r) => r.group));
  for (const group of groups) {
    const inside = islands.filter((i) => i.outer.group === group).map((i) => [i.outer.points, ...i.holes.map((h) => h.points)]);
    const outside = cutIslands(rings.filter((r) => r.group === group && r.status === 'cut')).map((i) => [i.outer.points, ...i.holes.map((h) => h.points)]);
    out[group] = inside.length === 0 ? [] : await clip('material', inside, outside);
  }
  return out;
}

export function toSvg(doc: SketchDocument, resolved: Resolved = {}): SketchSvg {
  const { islands } = flattenSketch(doc);
  const used = new Set<number>();
  for (const island of islands) {
    used.add(island.outer.node);
    for (const hole of island.holes) used.add(hole.node);
  }
  const bounds = exactBounds(doc.nodes.filter((_, i) => used.has(i))) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const width = round(bounds.maxX - bounds.minX);
  const height = round(bounds.maxY - bounds.minY);

  // SVG's y runs down the page; the drawing's runs up. Flipping about the top
  // of the box puts the drawing's bottom edge on the file's bottom edge, which
  // is where an importer puts the origin.
  const to = ([x, y]: Point): Point => [round(x - bounds.minX), round(bounds.maxY - y)];

  // A group with erased regions is written as the polygons the kernel made
  // of it; every other island is written exactly, as curves.
  const paths: string[] = [];
  for (const polygons of Object.values(resolved)) {
    if (polygons.length === 0) continue;
    const d = polygons.map((poly) => `${poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${to(p).join(',')}`).join(' ')} Z`);
    paths.push(`  <path fill-rule="nonzero" d="${d.join(' ')}"/>`);
  }
  for (const island of islands) {
    if (groupKey(doc.nodes[island.outer.node]) in resolved) continue;
    const d = [pathData(doc.nodes[island.outer.node], to)];
    for (const hole of island.holes) d.push(pathData(doc.nodes[hole.node], to));
    paths.push(`  <path fill-rule="evenodd" d="${d.join(' ')}"/>`);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Drawn in BetterSCAD. The metadata holds the editable drawing; the paths are what import() reads. -->',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:bscad="${NAMESPACE}" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">`,
    '  <metadata>',
    `    <${TAG} version="1">${escapeXml(JSON.stringify(doc))}</${TAG}>`,
    '  </metadata>',
    ...paths,
    '</svg>',
    '',
  ];
  return { text: lines.join('\n'), width, height, shapes: used.size };
}

/**
 * The drawing an SVG carries, if it was drawn here.
 *
 * Any other SVG has paths but no document, and returns nothing: its outlines
 * can still be brought into the tool, but as points, by whoever imports it.
 */
export function fromSvg(text: string): SketchDocument | undefined {
  const match = new RegExp(`<${TAG}[^>]*>([\\s\\S]*?)</${TAG}>`).exec(text);
  if (!match) return undefined;
  try {
    return normalizeSketch(JSON.parse(unescapeXml(match[1])));
  } catch {
    return undefined;
  }
}

/** A document made of plain polygons, for an SVG that was drawn elsewhere. */
export function fromContours(contours: readonly (readonly Point[])[]): SketchDocument {
  return normalizeSketch({
    nodes: contours
      .filter((contour) => contour.length >= 3)
      .map((contour) => ({ kind: 'poly', points: contour.map(([x, y]) => [x, y]), closed: true })),
  });
}

// ---------------------------------------------------------------------------
// Path data, exact rather than sampled
// ---------------------------------------------------------------------------

function pathData(node: SketchNode, to: (p: Point) => Point): string {
  switch (node.kind) {
    case 'rect':
      return rectData(node.x, node.y, node.w, node.h, node.r, to);
    case 'circle': {
      const [x1, y1] = to([node.cx + node.r, node.cy]);
      const [x2, y2] = to([node.cx - node.r, node.cy]);
      const r = round(node.r);
      return `M${x1},${y1} A${r},${r} 0 1 0 ${x2},${y2} A${r},${r} 0 1 0 ${x1},${y1} Z`;
    }
    case 'poly':
      return `${node.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${to(p).join(',')}`).join(' ')} Z`;
    case 'path':
      return anchorsData(node.anchors, node.closed, to);
  }
}

function rectData(x: number, y: number, w: number, h: number, r: number, to: (p: Point) => Point): string {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius <= 0) {
    return `M${to([x, y]).join(',')} L${to([x + w, y]).join(',')} L${to([x + w, y + h]).join(',')} L${to([x, y + h]).join(',')} Z`;
  }
  // The corners are walked counter-clockwise, and the y flip keeps them that
  // way on the page: right then up is a left turn either way round. SVG's
  // positive sweep is clockwise on a page, so these are sweep 0.
  const rr = round(radius);
  const arc = (p: Point): string => `A${rr},${rr} 0 0 0 ${to(p).join(',')}`;
  return [
    `M${to([x + radius, y]).join(',')}`,
    `L${to([x + w - radius, y]).join(',')}`,
    arc([x + w, y + radius]),
    `L${to([x + w, y + h - radius]).join(',')}`,
    arc([x + w - radius, y + h]),
    `L${to([x + radius, y + h]).join(',')}`,
    arc([x, y + h - radius]),
    `L${to([x, y + radius]).join(',')}`,
    arc([x + radius, y]),
    'Z',
  ].join(' ');
}

function anchorsData(anchors: Anchor[], closed: boolean, to: (p: Point) => Point): string {
  if (anchors.length === 0) return '';
  const parts = [`M${to([anchors[0].x, anchors[0].y]).join(',')}`];
  const count = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < count; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % anchors.length];
    if (!a.out && !b.in) {
      parts.push(`L${to([b.x, b.y]).join(',')}`);
    } else {
      const c1 = to([a.x + (a.out?.[0] ?? 0), a.y + (a.out?.[1] ?? 0)]);
      const c2 = to([b.x + (b.in?.[0] ?? 0), b.y + (b.in?.[1] ?? 0)]);
      parts.push(`C${c1.join(',')} ${c2.join(',')} ${to([b.x, b.y]).join(',')}`);
    }
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Bounds that sampling cannot give
// ---------------------------------------------------------------------------

/**
 * The true extent of the outlines, not of their samples.
 *
 * A circle sampled at 64 points is a thousandth of its radius short of its
 * edge, and the viewBox cut to the samples would clip the real curve. These
 * are exact: a curve's extremes come from its derivative's roots.
 */
export function exactBounds(nodes: readonly SketchNode[]): Bounds | undefined {
  let b: Bounds | undefined;
  const add = (x: number, y: number): void => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    }
  };
  for (const node of nodes) {
    switch (node.kind) {
      case 'rect':
        add(node.x, node.y);
        add(node.x + node.w, node.y + node.h);
        break;
      case 'circle':
        add(node.cx - node.r, node.cy - node.r);
        add(node.cx + node.r, node.cy + node.r);
        break;
      case 'poly':
        for (const [x, y] of node.points) add(x, y);
        break;
      case 'path': {
        const count = node.closed ? node.anchors.length : node.anchors.length - 1;
        for (const a of node.anchors) add(a.x, a.y);
        for (let i = 0; i < count; i++) {
          const a = node.anchors[i];
          const c = node.anchors[(i + 1) % node.anchors.length];
          if (!a.out && !c.in) continue;
          const p0: Point = [a.x, a.y];
          const p1: Point = [a.x + (a.out?.[0] ?? 0), a.y + (a.out?.[1] ?? 0)];
          const p2: Point = [c.x + (c.in?.[0] ?? 0), c.y + (c.in?.[1] ?? 0)];
          const p3: Point = [c.x, c.y];
          for (const t of cubicExtrema(p0, p1, p2, p3)) {
            const u = 1 - t;
            add(
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            );
          }
        }
        break;
      }
    }
  }
  return b;
}

/** Parameters in (0, 1) where a cubic's x or y turns around. */
function cubicExtrema(p0: Point, p1: Point, p2: Point, p3: Point): number[] {
  const out: number[] = [];
  for (const axis of [0, 1] as const) {
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
    const c = -p0[axis] + p1[axis];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) out.push(-c / b);
      continue;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const s = Math.sqrt(disc);
    out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
  }
  return out.filter((t) => t > 0 && t < 1);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export type { Island };
