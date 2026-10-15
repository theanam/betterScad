/**
 * Plain 2D booleans on polygons, for the drawing board.
 *
 * The board draws boxes, circles and curves, and keeps them that way; but
 * "the part where these two overlap" is none of those, and neither is "this
 * shape with that region taken out". Those are booleans, and the kernel
 * already does them exactly. Everything in and out is plain polygons.
 */

import type { CrossSection, Vec2 } from 'manifold-3d';

import type { ManifoldAPI } from './wasm.js';

export type Polygon = [number, number][];

export interface ClipRequest {
  /**
   * `region`: the cell of the arrangement, ∩(inside) − ∪(outside), which is
   * what lies under a click. `material`: what a group is made of,
   * ∪(inside) − ∪(outside), with each inside entry one island.
   */
  op: 'region' | 'material';
  /** Islands: each a list of contours filled even-odd, so holes come along. */
  inside: Polygon[][];
  /** Islands taken away from the result, holes and all. */
  outside: Polygon[][];
}

/** The result as polygons: outers counter-clockwise, holes clockwise. */
export function clipPolygons(api: ManifoldAPI, request: ClipRequest): Polygon[] {
  const made: CrossSection[] = [];
  const section = (contours: Polygon[]): CrossSection => {
    const usable = contours.filter((c) => c.length >= 3);
    // The constructor throws on `[]`; one empty contour is the empty region.
    const cs = new api.CrossSection(usable.length > 0 ? (usable as Vec2[][]) : [[]], 'EvenOdd');
    made.push(cs);
    return cs;
  };
  try {
    const islands = request.inside.map(section);
    let result: CrossSection;
    if (islands.length === 0) result = section([]);
    else if (islands.length === 1) result = islands[0];
    else {
      result = request.op === 'region' ? api.CrossSection.intersection(islands) : api.CrossSection.union(islands);
      made.push(result);
    }
    const cutters = request.outside.map(section);
    if (cutters.length > 0) {
      const cut = api.CrossSection.union(cutters);
      made.push(cut);
      result = api.CrossSection.difference([result, cut]);
      made.push(result);
    }
    return result.toPolygons().map((polygon) => polygon.map(([x, y]) => [x, y] as [number, number]));
  } finally {
    for (const cs of made) cs.delete();
  }
}
