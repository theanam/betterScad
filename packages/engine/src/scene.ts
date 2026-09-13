/**
 * The scene graph the interpreter produces and the geometry kernel consumes.
 *
 * Keeping this between the two stages is what makes the engine embeddable
 * (spec feature 3): a host can parse + evaluate to a `SceneNode` tree, inspect
 * or transform it, and only then pay for meshing.
 */

import { SourceSpan } from './diagnostics.js';

/** Column-major 4x4, matching the convention used by Manifold and WebGL. */
export type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Resolution controls, threaded through evaluation as OpenSCAD's `$fn/$fa/$fs`. */
export interface Resolution {
  fn: number;
  fa: number;
  fs: number;
}

export const DEFAULT_RESOLUTION: Resolution = { fn: 0, fa: 12, fs: 2 };

/**
 * Number of segments for a circle of the given radius.
 *
 * `$fn` wins outright when set; otherwise the count is the tighter of the
 * angular ($fa) and edge-length ($fs) constraints, floored at 5 — the same
 * rule stock OpenSCAD documents, reimplemented here.
 */
export function fragments(radius: number, res: Resolution): number {
  if (radius <= 0 || !Number.isFinite(radius)) return 3;
  if (res.fn > 0) return Math.max(3, Math.floor(res.fn));
  const byAngle = 360 / Math.max(res.fa, 0.01);
  const byLength = (radius * 2 * Math.PI) / Math.max(res.fs, 0.01);
  return Math.max(5, Math.ceil(Math.min(byAngle, byLength)));
}

export type NodeOp =
  // 3D primitives
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'polyhedron'
  // 2D primitives
  | 'square'
  | 'circle'
  | 'polygon'
  | 'text'
  // grouping and transforms
  | 'group'
  | 'transform'
  | 'color'
  | 'resize'
  // booleans
  | 'union'
  | 'difference'
  | 'intersection'
  // hulls and sums
  | 'hull'
  | 'minkowski'
  // 2D <-> 3D
  | 'linear_extrude'
  | 'rotate_extrude'
  | 'projection'
  | 'offset'
  // imports
  | 'import'
  | 'surface'
  // evaluation control
  | 'render';

export interface SceneNode {
  op: NodeOp;
  /** Operation-specific parameters, already coerced to plain numbers/strings. */
  params: Record<string, unknown>;
  children: SceneNode[];
  /** Modifier role names; see `roles.ts`. */
  roles: string[];
  span?: SourceSpan;
}

export function node(
  op: NodeOp,
  params: Record<string, unknown> = {},
  children: SceneNode[] = [],
  roles: string[] = [],
  span?: SourceSpan,
): SceneNode {
  return { op, params, children, roles, span };
}

export function group(children: SceneNode[], roles: string[] = [], span?: SourceSpan): SceneNode {
  return node('group', {}, children, roles, span);
}

/**
 * A group that delimits a brace scope: `{ … }`, a module body, or the top
 * level.
 *
 * The distinction exists for `negative()`, which subtracts from its siblings
 * within a scope and must not leak past one. Ordinary wrappers — transforms,
 * `if`, `for`, `let` — produce plain groups and are transparent to it.
 */
export function scopeGroup(
  children: SceneNode[],
  roles: string[] = [],
  span?: SourceSpan,
): SceneNode {
  return node('group', { braced: true }, children, roles, span);
}

/** Whether a node delimits a brace scope (see `scopeGroup`). */
export function isScopeGroup(n: SceneNode): boolean {
  return n.params.braced === true;
}

/** Walks the tree depth-first, parents before children. */
export function* walk(root: SceneNode): Generator<SceneNode> {
  yield root;
  for (const child of root.children) yield* walk(child);
}

export function countNodes(root: SceneNode): number {
  let n = 0;
  for (const _ of walk(root)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

export function matMultiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0) as Mat4;
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scaling(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** Rotation about an arbitrary axis, angle in degrees (Rodrigues' formula). */
export function rotationAxis(axis: [number, number, number], degrees: number): Mat4 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len === 0) return [...IDENTITY] as Mat4;
  const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** OpenSCAD's `rotate([x, y, z])`: intrinsic Z, then Y, then X applied in XYZ order. */
export function rotationXYZ(x: number, y: number, z: number): Mat4 {
  const rx = rotationAxis([1, 0, 0], x);
  const ry = rotationAxis([0, 1, 0], y);
  const rz = rotationAxis([0, 0, 1], z);
  return matMultiply(rz, matMultiply(ry, rx));
}

/** Mirror across the plane through the origin with the given normal. */
export function mirrorMatrix(nx: number, ny: number, nz: number): Mat4 {
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return [...IDENTITY] as Mat4;
  const [x, y, z] = [nx / len, ny / len, nz / len];
  return [
    1 - 2 * x * x, -2 * x * y, -2 * x * z, 0,
    -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0,
    -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0,
    0, 0, 0, 1,
  ];
}

/** Determinant of the upper-left 3x3, used to detect orientation flips. */
export function determinant3(m: Mat4): number {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

export function transformPoint(m: Mat4, p: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
