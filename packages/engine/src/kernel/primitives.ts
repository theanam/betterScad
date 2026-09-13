/**
 * Primitive construction.
 *
 * Spheres, cylinders and circles are tessellated with OpenSCAD's own vertex
 * placement rather than Manifold's built-in generators. That matters for
 * compatibility: `sphere($fn=6)` and `cylinder($fn=3)` are used deliberately to
 * get a specific low-poly solid, and a different-but-equivalent tessellation
 * would silently change those models (spec feature 2).
 */

import type { CrossSection, Manifold, Vec2, Vec3 } from 'manifold-3d';
import type { ManifoldAPI } from './wasm.js';
import { Resolution, fragments } from '../scene.js';
import { TriMesh } from '../geom/mesh.js';

export type Polygon2 = [number, number][];

/** Ring of `count` points on a circle of radius `r`, first vertex at angle 0. */
export function circlePoints(r: number, count: number): Polygon2 {
  const points: Polygon2 = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    points.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }
  return points;
}

export function makeCircle(api: ManifoldAPI, r: number, res: Resolution): CrossSection {
  if (r <= 0) return new api.CrossSection([]);
  return new api.CrossSection([circlePoints(r, fragments(r, res)) as Vec2[]], 'Positive');
}

export function makeSquare(api: ManifoldAPI, size: number[], center: boolean): CrossSection {
  const [w, h] = [size[0], size[1]];
  if (w <= 0 || h <= 0) return new api.CrossSection([]);
  const [x0, y0] = center ? [-w / 2, -h / 2] : [0, 0];
  return new api.CrossSection(
    [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]] as Vec2[]],
    'Positive',
  );
}

/**
 * Builds a 2D region from `polygon(points, paths)`.
 *
 * With no `paths`, the point list is a single contour. With `paths`, each entry
 * is a contour and the even-odd fill rule turns inner contours into holes,
 * which is what OpenSCAD's polygon does.
 */
export function makePolygon(
  api: ManifoldAPI,
  points: [number, number][],
  paths: number[][] | undefined,
): CrossSection {
  if (points.length < 3) return new api.CrossSection([]);
  if (!paths || paths.length === 0) {
    return new api.CrossSection([points as Vec2[]], 'EvenOdd');
  }
  const contours: Vec2[][] = [];
  for (const path of paths) {
    const contour = path.map((i) => points[i]).filter((p): p is [number, number] => Array.isArray(p));
    if (contour.length >= 3) contours.push(contour as Vec2[]);
  }
  if (contours.length === 0) return new api.CrossSection([]);
  return new api.CrossSection(contours, 'EvenOdd');
}

export function makeCube(api: ManifoldAPI, size: number[], center: boolean): Manifold {
  if (size.some((s) => s <= 0)) return api.Manifold.cube([0, 0, 0] as Vec3);
  return api.Manifold.cube(size as Vec3, center);
}

/**
 * Sphere tessellated as OpenSCAD does: `rings = floor((fragments + 1) / 2)`
 * latitude bands, each sampled at `fragments` longitudes, with the polar bands
 * capped by a flat polygon rather than converging to a point.
 */
export function makeSphere(api: ManifoldAPI, r: number, res: Resolution): Manifold {
  if (r <= 0) return api.Manifold.cube([0, 0, 0] as Vec3);
  const segments = fragments(r, res);
  const rings = Math.max(1, Math.floor((segments + 1) / 2));

  const positions: number[] = [];
  const triangles: number[] = [];

  for (let i = 0; i < rings; i++) {
    const phi = (Math.PI * (i + 0.5)) / rings;
    const ringRadius = r * Math.sin(phi);
    const z = r * Math.cos(phi);
    for (let j = 0; j < segments; j++) {
      const theta = (2 * Math.PI * j) / segments;
      positions.push(ringRadius * Math.cos(theta), ringRadius * Math.sin(theta), z);
    }
  }

  const index = (ring: number, j: number): number => ring * segments + ((j % segments) + segments) % segments;

  // Rings run from +Z down to -Z, so each quad is wound to face outwards.
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let j = 0; j < segments; j++) {
      const a = index(ring, j);
      const b = index(ring, j + 1);
      const c = index(ring + 1, j + 1);
      const d = index(ring + 1, j);
      triangles.push(a, d, c, a, c, b);
    }
  }

  // Flat caps: fan the top ring (facing +Z) and the bottom ring (facing -Z).
  for (let j = 1; j < segments - 1; j++) {
    triangles.push(index(0, 0), index(0, j), index(0, j + 1));
  }
  const last = rings - 1;
  for (let j = 1; j < segments - 1; j++) {
    triangles.push(index(last, 0), index(last, j + 1), index(last, j));
  }

  return meshToManifold(api, {
    positions: new Float32Array(positions),
    triangles: new Uint32Array(triangles),
  });
}

/**
 * Cylinder / cone / truncated cone, tessellated with OpenSCAD's segment count.
 * A zero radius at either end collapses to a single apex vertex.
 */
export function makeCylinder(
  api: ManifoldAPI,
  h: number,
  r1: number,
  r2: number,
  center: boolean,
  res: Resolution,
): Manifold {
  if (h <= 0 || (r1 <= 0 && r2 <= 0)) return api.Manifold.cube([0, 0, 0] as Vec3);
  const segments = fragments(Math.max(r1, r2), res);
  const zBottom = center ? -h / 2 : 0;
  const zTop = zBottom + h;

  const positions: number[] = [];
  const triangles: number[] = [];

  const bottomApex = r1 <= 0;
  const topApex = r2 <= 0;

  if (bottomApex) {
    positions.push(0, 0, zBottom);
  } else {
    for (const [x, y] of circlePoints(r1, segments)) positions.push(x, y, zBottom);
  }
  const topBase = positions.length / 3;
  if (topApex) {
    positions.push(0, 0, zTop);
  } else {
    for (const [x, y] of circlePoints(r2, segments)) positions.push(x, y, zTop);
  }

  const bottomAt = (j: number): number => (bottomApex ? 0 : ((j % segments) + segments) % segments);
  const topAt = (j: number): number =>
    topApex ? topBase : topBase + (((j % segments) + segments) % segments);

  for (let j = 0; j < segments; j++) {
    const b0 = bottomAt(j);
    const b1 = bottomAt(j + 1);
    const t0 = topAt(j);
    const t1 = topAt(j + 1);
    if (bottomApex) {
      triangles.push(b0, t1, t0);
    } else if (topApex) {
      triangles.push(b0, b1, t0);
    } else {
      triangles.push(b0, b1, t1, b0, t1, t0);
    }
  }

  if (!bottomApex) {
    for (let j = 1; j < segments - 1; j++) triangles.push(0, j + 1, j); // faces -Z
  }
  if (!topApex) {
    for (let j = 1; j < segments - 1; j++) {
      triangles.push(topBase, topBase + j, topBase + j + 1); // faces +Z
    }
  }

  return meshToManifold(api, {
    positions: new Float32Array(positions),
    triangles: new Uint32Array(triangles),
  });
}

/**
 * `polyhedron(points, faces)`.
 *
 * OpenSCAD faces are wound clockwise seen from outside; Manifold wants
 * counter-clockwise, so each face is reversed. Faces with more than three
 * vertices are fan-triangulated.
 */
export function makePolyhedron(
  api: ManifoldAPI,
  points: [number, number, number][],
  faces: number[][],
): Manifold {
  const positions = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  });

  const triangles: number[] = [];
  for (const face of faces) {
    const valid = face.filter((i) => i >= 0 && i < points.length);
    if (valid.length < 3) continue;
    const reversed = [...valid].reverse();
    for (let i = 2; i < reversed.length; i++) {
      triangles.push(reversed[0], reversed[i - 1], reversed[i]);
    }
  }

  return meshToManifold(api, { positions, triangles: new Uint32Array(triangles) });
}

/** Wraps a `TriMesh` as a Manifold, letting the kernel report non-manifold input. */
export function meshToManifold(api: ManifoldAPI, mesh: TriMesh): Manifold {
  const gl = new api.Mesh({
    numProp: 3,
    vertProperties: mesh.positions,
    triVerts: mesh.triangles,
  });
  // Merge coincident vertices so meshes that only *look* closed (STL, and
  // hand-written polyhedra with duplicated points) still become solids.
  gl.merge();
  return api.Manifold.ofMesh(gl);
}

/** Copies a Manifold's surface out of WASM memory into a plain `TriMesh`. */
export function manifoldToMesh(solid: Manifold): TriMesh {
  const mesh = solid.getMesh();
  const numProp = mesh.numProp;
  const vertexTotal = mesh.vertProperties.length / numProp;
  const positions = new Float32Array(vertexTotal * 3);
  for (let v = 0; v < vertexTotal; v++) {
    positions[v * 3] = mesh.vertProperties[v * numProp];
    positions[v * 3 + 1] = mesh.vertProperties[v * numProp + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * numProp + 2];
  }
  return { positions, triangles: new Uint32Array(mesh.triVerts) };
}
