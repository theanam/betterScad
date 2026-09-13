/**
 * Scene graph -> geometry.
 *
 * The CSG combiner (`combine`) never mentions `%`, `#`, `!` or `*`. It asks
 * `resolveContribution()` what each child's roles mean and routes accordingly
 * (spec feature 3a), which is why `negative()` needed no change here at all.
 */

import type { CrossSection, Manifold, Mat3, Mat4 as ManifoldMat4, Vec2, Vec3 } from 'manifold-3d';

import { DEFAULT_COLOR, parseColor } from '../colors.js';
import { DiagnosticBag, SourceSpan } from '../diagnostics.js';
import { FontRegistry } from '../fonts.js';
import { TriMesh, weldVertices } from '../geom/mesh.js';
import { gridFromGrayscale, parseSurfaceDat, surfaceToMesh } from '../geom/surface.js';
import { importDXF } from '../io/import/dxf.js';
import { importMesh } from '../io/import/mesh.js';
import { importSVG } from '../io/import/svg.js';
import { Contribution, Display, resolveContribution, resolveDisplay } from '../roles.js';
import { Mat4, Resolution, SceneNode, determinant3, fragments, walk } from '../scene.js';
import { Value } from '../values.js';
import { Arena, Assembly, Piece, RGBA, assembly, emptyAssembly } from './geometry.js';
import {
  makeCircle,
  makeCube,
  makeCylinder,
  makePolygon,
  makePolyhedron,
  makeSphere,
  makeSquare,
  meshToManifold,
} from './primitives.js';
import { ManifoldAPI } from './wasm.js';

/** Supplies bytes for `import()`, `surface()` and `include`d assets. */
export interface AssetProvider {
  read(path: string): Promise<Uint8Array | undefined>;
  /**
   * Decodes an image to 8-bit grayscale for `surface()`.
   *
   * Optional: without it, image heightmaps report a diagnostic instead of
   * pulling an image codec into the engine.
   */
  decodeImage?(
    data: Uint8Array,
    path: string,
  ): Promise<{ gray: Uint8Array; width: number; height: number } | undefined>;
}

export interface BuildOptions {
  api: ManifoldAPI;
  diagnostics: DiagnosticBag;
  fonts?: FontRegistry;
  assets?: AssetProvider;
}

export interface BuildResult {
  /** Exportable geometry, one entry per colour group. */
  parts: { mesh: TriMesh; color: RGBA; display: Display }[];
  /** 2D result, when the scene is two-dimensional. */
  contours2d: { contours: [number, number][][]; color: RGBA }[];
  /** Preview-only `%`-role geometry. */
  annotations: { mesh: TriMesh; color: RGBA }[];
  dimension: 2 | 3 | 0;
  stats: { nodes: number; triangles: number; vertices: number; volume: number; area: number };
}

interface Ctx {
  api: ManifoldAPI;
  arena: Arena;
  diagnostics: DiagnosticBag;
  fonts?: FontRegistry;
  /** Asset bytes preloaded before evaluation, so recursion stays synchronous. */
  files: Map<string, Uint8Array>;
  images: Map<string, { gray: Uint8Array; width: number; height: number }>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildGeometry(root: SceneNode, options: BuildOptions): Promise<BuildResult> {
  const arena = new Arena();
  const ctx: Ctx = {
    api: options.api,
    arena,
    diagnostics: options.diagnostics,
    fonts: options.fonts,
    files: new Map(),
    images: new Map(),
  };

  await preloadAssets(root, options, ctx);

  try {
    const result = evaluateNode(root, ctx);
    return extract(result, ctx);
  } finally {
    // Everything the caller needs has been copied into plain typed arrays by
    // `extract`, so the whole WASM-side working set can go at once.
    arena.disposeAll();
  }
}

/**
 * Fetches every `import()`/`surface()` file up front.
 *
 * Doing this as a pre-pass keeps the recursive evaluator synchronous, which
 * matters: an `await` per node turns a 50k-node scene into 50k microtasks.
 */
async function preloadAssets(root: SceneNode, options: BuildOptions, ctx: Ctx): Promise<void> {
  if (!options.assets) return;
  const wanted = new Set<string>();
  const images = new Set<string>();

  for (const node of walk(root)) {
    if (node.op === 'import' || node.op === 'surface') {
      const file = String(node.params.file ?? '');
      if (!file) continue;
      wanted.add(file);
      if (node.op === 'surface' && !/\.dat$/i.test(file)) images.add(file);
    }
  }

  await Promise.all(
    [...wanted].map(async (path) => {
      try {
        const data = await options.assets!.read(path);
        if (!data) {
          ctx.diagnostics.error(`Cannot read "${path}".`, undefined, 'kernel.asset-missing');
          return;
        }
        ctx.files.set(path, data);
        if (images.has(path) && options.assets!.decodeImage) {
          const decoded = await options.assets!.decodeImage(data, path);
          if (decoded) ctx.images.set(path, decoded);
        }
      } catch (err) {
        ctx.diagnostics.error(
          `Failed to read "${path}": ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          'kernel.asset-error',
        );
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Node evaluation
// ---------------------------------------------------------------------------

function evaluateNode(node: SceneNode, ctx: Ctx): Assembly {
  switch (node.op) {
    // --- 3D primitives ---
    case 'cube':
      return solidPiece(ctx, makeCube(ctx.api, node.params.size as number[], node.params.center as boolean));
    case 'sphere':
      return solidPiece(
        ctx,
        makeSphere(ctx.api, node.params.r as number, node.params.resolution as Resolution),
      );
    case 'cylinder':
      return solidPiece(
        ctx,
        makeCylinder(
          ctx.api,
          node.params.h as number,
          node.params.r1 as number,
          node.params.r2 as number,
          node.params.center as boolean,
          node.params.resolution as Resolution,
        ),
      );
    case 'polyhedron':
      return guard(ctx, node.span, 'polyhedron', () =>
        solidPiece(
          ctx,
          makePolyhedron(
            ctx.api,
            node.params.points as [number, number, number][],
            node.params.faces as number[][],
          ),
        ),
      );

    // --- 2D primitives ---
    case 'square':
      return flatPiece(
        ctx,
        makeSquare(ctx.api, node.params.size as number[], node.params.center as boolean),
      );
    case 'circle':
      return flatPiece(
        ctx,
        makeCircle(ctx.api, node.params.r as number, node.params.resolution as Resolution),
      );
    case 'polygon':
      return guard(ctx, node.span, 'polygon', () =>
        flatPiece(
          ctx,
          makePolygon(
            ctx.api,
            node.params.points as [number, number][],
            node.params.paths as number[][] | undefined,
          ),
        ),
      );
    case 'text':
      return buildText(node, ctx);

    // --- imports ---
    case 'import':
      return buildImport(node, ctx);
    case 'surface':
      return buildSurface(node, ctx);

    // --- grouping and booleans ---
    case 'group':
    case 'render':
    case 'union':
      return combine(node, ctx, 'union');
    case 'difference':
      return combine(node, ctx, 'difference');
    case 'intersection':
      return combine(node, ctx, 'intersection');
    case 'hull':
      return combine(node, ctx, 'hull');
    case 'minkowski':
      return combine(node, ctx, 'minkowski');

    // --- transforms ---
    case 'transform':
      return applyTransform(combine(node, ctx, 'union'), node.params.matrix as Mat4, ctx, node.span);
    case 'color':
      return applyColor(node, ctx);
    case 'resize':
      return applyResize(node, ctx);

    // --- dimension changes ---
    case 'linear_extrude':
      return buildLinearExtrude(node, ctx);
    case 'rotate_extrude':
      return buildRotateExtrude(node, ctx);
    case 'projection':
      return buildProjection(node, ctx);
    case 'offset':
      return buildOffset(node, ctx);

    default:
      return emptyAssembly();
  }
}

/** Runs a geometry builder, turning a kernel throw into a diagnostic. */
function guard(ctx: Ctx, span: SourceSpan | undefined, what: string, build: () => Assembly): Assembly {
  try {
    return build();
  } catch (err) {
    ctx.diagnostics.error(
      `${what}: ${err instanceof Error ? err.message : String(err)}`,
      span,
      'kernel.build-failed',
    );
    return emptyAssembly();
  }
}

function solidPiece(ctx: Ctx, solid: Manifold): Assembly {
  ctx.arena.track(solid);
  return assembly([{ dim: 3, solid, display: 'normal' }]);
}

function flatPiece(ctx: Ctx, section: CrossSection): Assembly {
  ctx.arena.track(section);
  return assembly([{ dim: 2, solid: section, display: 'normal' }]);
}

// ---------------------------------------------------------------------------
// The role-dispatching combiner
// ---------------------------------------------------------------------------

type CombineOp = 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski';

function combine(node: SceneNode, ctx: Ctx, op: CombineOp): Assembly {
  const operands: Assembly[] = [];
  const subtractive: Assembly[] = [];
  const annotations: Piece[] = [];

  for (const child of node.children) {
    const contribution: Contribution = resolveContribution(child.roles);
    if (contribution === 'ignored') continue;

    const evaluated = evaluateNode(child, ctx);

    // A `root` node anywhere below claims the whole render; drop the siblings
    // and keep propagating upwards.
    if (evaluated.isolated) return { ...evaluated, isolated: true };
    if (contribution === 'isolate') {
      return { pieces: evaluated.pieces, annotations: evaluated.annotations, isolated: true };
    }

    annotations.push(...evaluated.annotations);

    // A child's own display role (`#`) applies to the geometry it produced,
    // whether that child is a leaf primitive or a whole subtree.
    const childDisplay = resolveDisplay(child.roles);
    const displayed =
      childDisplay === 'normal'
        ? evaluated
        : { ...evaluated, pieces: evaluated.pieces.map((p) => ({ ...p, display: childDisplay })) };

    switch (contribution) {
      case 'annotation':
        // Demoted out of the boolean entirely: preview-only from here up.
        annotations.push(
          ...displayed.pieces.map((p) => ({ ...p, display: 'transparent' as Display })),
        );
        break;
      case 'subtractive':
        subtractive.push(displayed);
        break;
      default:
        operands.push(displayed);
    }
  }

  const combined = applyOperation(operands, op, ctx, node.span);
  const withNegatives =
    subtractive.length > 0 ? subtractNegatives(combined, subtractive, ctx, node.span) : combined;

  const display = resolveDisplay(node.roles);
  const pieces =
    display === 'normal'
      ? withNegatives.pieces
      : withNegatives.pieces.map((p) => ({ ...p, display }));

  return { pieces, annotations: [...annotations, ...withNegatives.annotations], isolated: false };
}

function applyOperation(
  operands: Assembly[],
  op: CombineOp,
  ctx: Ctx,
  span: SourceSpan | undefined,
): Assembly {
  if (operands.length === 0) return emptyAssembly();

  switch (op) {
    case 'union':
      // Pieces are kept separate so each keeps its own colour; they are only
      // merged at export time.
      return assembly(operands.flatMap((a) => a.pieces), operands.flatMap((a) => a.annotations));

    case 'difference':
      return differenceOf(operands, ctx, span);

    case 'intersection':
      return intersectionOf(operands, ctx, span);

    case 'hull':
      return hullOf(operands, ctx, span);

    case 'minkowski':
      return minkowskiOf(operands, ctx, span);
  }
}

/** First operand minus the union of the rest, per colour-carrying piece. */
function differenceOf(operands: Assembly[], ctx: Ctx, span: SourceSpan | undefined): Assembly {
  const [first, ...rest] = operands;
  if (rest.length === 0) return first;

  const cutters3 = collect(rest, 3);
  const cutters2 = collect(rest, 2);
  const pieces: Piece[] = [];

  for (const piece of first.pieces) {
    if (piece.dim === 3) {
      if (cutters3.length === 0) {
        pieces.push(piece);
        continue;
      }
      const result = guardGeom(ctx, span, 'difference', () =>
        ctx.arena.track(
          ctx.api.Manifold.difference([piece.solid as Manifold, ...(cutters3 as Manifold[])]),
        ),
      );
      if (result) pieces.push({ ...piece, solid: result });
    } else {
      if (cutters2.length === 0) {
        pieces.push(piece);
        continue;
      }
      const result = guardGeom(ctx, span, 'difference', () =>
        ctx.arena.track(
          ctx.api.CrossSection.difference([
            piece.solid as CrossSection,
            ...(cutters2 as CrossSection[]),
          ]),
        ),
      );
      if (result) pieces.push({ ...piece, solid: result });
    }
  }

  return assembly(pieces, operands.flatMap((a) => a.annotations));
}

function intersectionOf(operands: Assembly[], ctx: Ctx, span: SourceSpan | undefined): Assembly {
  if (operands.length === 1) return operands[0];

  // Each operand is first unioned within itself: `intersection() { a; b; }`
  // intersects the *union* of each child's geometry, not piece by piece.
  const solids3 = operands.map((a) => unionWithin(a, 3, ctx, span)).filter((s): s is Manifold => !!s);
  const solids2 = operands
    .map((a) => unionWithin(a, 2, ctx, span))
    .filter((s): s is CrossSection => !!s);

  const pieces: Piece[] = [];
  const color = operands[0].pieces[0]?.color;
  const display = operands[0].pieces[0]?.display ?? 'normal';

  if (solids3.length === operands.length && solids3.length > 0) {
    const result = guardGeom(ctx, span, 'intersection', () =>
      ctx.arena.track(ctx.api.Manifold.intersection(solids3)),
    );
    if (result) pieces.push({ dim: 3, solid: result, color, display });
  } else if (solids2.length === operands.length && solids2.length > 0) {
    const result = guardGeom(ctx, span, 'intersection', () =>
      ctx.arena.track(ctx.api.CrossSection.intersection(solids2)),
    );
    if (result) pieces.push({ dim: 2, solid: result, color, display });
  } else if (solids3.length > 0 || solids2.length > 0) {
    ctx.diagnostics.warn(
      'intersection() mixes 2D and 3D children; only the matching dimension is used.',
      span,
      'kernel.mixed-dimension',
    );
    if (solids3.length > 1) {
      const result = guardGeom(ctx, span, 'intersection', () =>
        ctx.arena.track(ctx.api.Manifold.intersection(solids3)),
      );
      if (result) pieces.push({ dim: 3, solid: result, color, display });
    }
  }

  return assembly(pieces, operands.flatMap((a) => a.annotations));
}

function hullOf(operands: Assembly[], ctx: Ctx, span: SourceSpan | undefined): Assembly {
  const all3 = collect(operands, 3) as Manifold[];
  const all2 = collect(operands, 2) as CrossSection[];
  const color = operands[0]?.pieces[0]?.color;
  const display = operands[0]?.pieces[0]?.display ?? 'normal';

  if (all3.length > 0) {
    if (all2.length > 0) {
      ctx.diagnostics.warn(
        'hull() mixes 2D and 3D children; the 2D ones are ignored.',
        span,
        'kernel.mixed-dimension',
      );
    }
    const result = guardGeom(ctx, span, 'hull', () => ctx.arena.track(ctx.api.Manifold.hull(all3)));
    return result ? assembly([{ dim: 3, solid: result, color, display }]) : emptyAssembly();
  }
  if (all2.length > 0) {
    const result = guardGeom(ctx, span, 'hull', () =>
      ctx.arena.track(ctx.api.CrossSection.hull(all2)),
    );
    return result ? assembly([{ dim: 2, solid: result, color, display }]) : emptyAssembly();
  }
  return emptyAssembly();
}

function minkowskiOf(operands: Assembly[], ctx: Ctx, span: SourceSpan | undefined): Assembly {
  if (operands.length === 1) return operands[0];
  const color = operands[0]?.pieces[0]?.color;
  const display = operands[0]?.pieces[0]?.display ?? 'normal';

  const solids3 = operands.map((a) => unionWithin(a, 3, ctx, span));
  if (solids3.every((s): s is Manifold => !!s) && solids3.length > 1) {
    const result = guardGeom(ctx, span, 'minkowski', () => {
      let acc = solids3[0];
      for (let i = 1; i < solids3.length; i++) acc = ctx.arena.track(acc.minkowskiSum(solids3[i]));
      return acc;
    });
    return result ? assembly([{ dim: 3, solid: result, color, display }]) : emptyAssembly();
  }

  // 2D Minkowski is an offset by the second shape; Clipper2 exposes it only for
  // circular and square kernels, so this approximates with a round offset of
  // the second operand's circumradius.
  const solids2 = operands.map((a) => unionWithin(a, 2, ctx, span));
  if (solids2.every((s): s is CrossSection => !!s) && solids2.length > 1) {
    const result = guardGeom(ctx, span, 'minkowski', () => {
      let acc = solids2[0];
      for (let i = 1; i < solids2.length; i++) {
        const rect = solids2[i].bounds();
        const radius = Math.max(
          Math.abs(rect.max[0] - rect.min[0]),
          Math.abs(rect.max[1] - rect.min[1]),
        ) / 2;
        acc = ctx.arena.track(acc.offset(radius, 'Round', 2, 32));
      }
      return acc;
    });
    if (result) {
      ctx.diagnostics.warn(
        '2D minkowski() is approximated by a rounded offset of the second shape.',
        span,
        'kernel.minkowski-2d-approx',
      );
      return assembly([{ dim: 2, solid: result, color, display }]);
    }
  }

  ctx.diagnostics.warn('minkowski() needs children of a single dimension.', span, 'kernel.mixed-dimension');
  return emptyAssembly();
}

/**
 * Subtracts every `negative`-role subtree from the assembled scope.
 *
 * This is the whole implementation of the `negative()` extension: the
 * combiner routed the children here purely on their declared contribution.
 */
function subtractNegatives(
  base: Assembly,
  negatives: Assembly[],
  ctx: Ctx,
  span: SourceSpan | undefined,
): Assembly {
  return differenceOf([base, ...negatives], ctx, span);
}

function collect(assemblies: Assembly[], dim: 2 | 3): (Manifold | CrossSection)[] {
  const out: (Manifold | CrossSection)[] = [];
  for (const a of assemblies) for (const p of a.pieces) if (p.dim === dim) out.push(p.solid);
  return out;
}

/** Unions one assembly's same-dimension pieces into a single handle. */
function unionWithin(
  a: Assembly,
  dim: 2 | 3,
  ctx: Ctx,
  span: SourceSpan | undefined,
): Manifold | CrossSection | undefined {
  const solids = a.pieces.filter((p) => p.dim === dim).map((p) => p.solid);
  if (solids.length === 0) return undefined;
  if (solids.length === 1) return solids[0];
  return guardGeom(ctx, span, 'union', () =>
    dim === 3
      ? ctx.arena.track(ctx.api.Manifold.union(solids as Manifold[]))
      : ctx.arena.track(ctx.api.CrossSection.union(solids as CrossSection[])),
  );
}

function guardGeom<T>(
  ctx: Ctx,
  span: SourceSpan | undefined,
  what: string,
  build: () => T,
): T | undefined {
  try {
    return build();
  } catch (err) {
    ctx.diagnostics.error(
      `${what}(): ${err instanceof Error ? err.message : String(err)}`,
      span,
      'kernel.operation-failed',
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

function applyTransform(
  input: Assembly,
  matrix: Mat4,
  ctx: Ctx,
  span: SourceSpan | undefined,
): Assembly {
  if (input.pieces.length === 0 && input.annotations.length === 0) return input;

  // A negative determinant mirrors the solid, which inverts every face winding.
  // Manifold handles that internally, but the warning is worth surfacing for
  // degenerate (zero-determinant) transforms, which destroy the solid.
  if (Math.abs(determinant3(matrix)) < 1e-12) {
    ctx.diagnostics.warn(
      'Transform is singular (zero scale on an axis); the geometry collapses.',
      span,
      'kernel.singular-transform',
    );
  }

  const map = (piece: Piece): Piece => {
    if (piece.dim === 3) {
      const solid = (piece.solid as Manifold).transform(matrix as unknown as ManifoldMat4);
      return { ...piece, solid: ctx.arena.track(solid) };
    }
    // 2D geometry stays in the XY plane, so only the in-plane part applies.
    const hasZCoupling =
      Math.abs(matrix[2]) > 1e-9 ||
      Math.abs(matrix[6]) > 1e-9 ||
      Math.abs(matrix[8]) > 1e-9 ||
      Math.abs(matrix[9]) > 1e-9;
    if (hasZCoupling) {
      ctx.diagnostics.warn(
        'A 3D rotation was applied to 2D geometry; only its XY component is used.',
        span,
        'kernel.2d-3d-transform',
      );
    }
    const mat3: Mat3 = [matrix[0], matrix[1], 0, matrix[4], matrix[5], 0, matrix[12], matrix[13], 1];
    return { ...piece, solid: ctx.arena.track((piece.solid as CrossSection).transform(mat3)) };
  };

  return {
    pieces: input.pieces.map(map),
    annotations: input.annotations.map(map),
    isolated: input.isolated,
  };
}

function applyColor(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  const color = parseColor(node.params.color as Value, node.params.alpha as number | undefined);

  if (!color) {
    if (node.params.color !== undefined) {
      ctx.diagnostics.warn(
        `color(): unrecognised colour ${JSON.stringify(node.params.color)}.`,
        node.span,
        'kernel.bad-color',
      );
    }
    return inner;
  }

  // The innermost `color()` wins, so only pieces without one are painted.
  const paint = (p: Piece): Piece => (p.color ? p : { ...p, color });
  return {
    pieces: inner.pieces.map(paint),
    annotations: inner.annotations.map(paint),
    isolated: inner.isolated,
  };
}

/**
 * `resize(newsize, auto)`.
 *
 * Axes with a zero `newsize` keep their size, unless `auto` is set for that
 * axis, in which case they take the scale factor of the first explicitly
 * resized axis — preserving proportions.
 */
function applyResize(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  if (inner.pieces.length === 0) return inner;

  const newsize = node.params.newsize as number[];
  const auto = node.params.auto as boolean[];

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const piece of inner.pieces) {
    if (piece.dim === 3) {
      const box = (piece.solid as Manifold).boundingBox();
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], box.min[i]);
        max[i] = Math.max(max[i], box.max[i]);
      }
    } else {
      const rect = (piece.solid as CrossSection).bounds();
      for (let i = 0; i < 2; i++) {
        min[i] = Math.min(min[i], rect.min[i]);
        max[i] = Math.max(max[i], rect.max[i]);
      }
      min[2] = Math.min(min[2], 0);
      max[2] = Math.max(max[2], 0);
    }
  }

  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const factors: [number, number, number] = [1, 1, 1];
  let explicit: number | undefined;
  for (let axis = 0; axis < 3; axis++) {
    if (newsize[axis] > 0 && extent[axis] > 1e-12) {
      factors[axis] = newsize[axis] / extent[axis];
      if (explicit === undefined) explicit = factors[axis];
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (newsize[axis] <= 0 && auto[axis] && explicit !== undefined) factors[axis] = explicit;
  }

  if (factors.every((f) => Math.abs(f - 1) < 1e-12)) return inner;

  const matrix: Mat4 = [
    factors[0], 0, 0, 0,
    0, factors[1], 0, 0,
    0, 0, factors[2], 0,
    0, 0, 0, 1,
  ];
  return applyTransform(inner, matrix, ctx, node.span);
}

// ---------------------------------------------------------------------------
// Dimension changes
// ---------------------------------------------------------------------------

function buildLinearExtrude(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  const height = node.params.height as number;
  const center = node.params.center as boolean;
  const twist = node.params.twist as number;
  const slices = node.params.slices as number;
  const scaleTop = node.params.scaleTop as number[];
  const direction = node.params.v as number[] | undefined;

  if (height === 0) {
    ctx.diagnostics.warn('linear_extrude(): height is zero.', node.span, 'kernel.zero-extrude');
    return emptyAssembly();
  }

  const pieces: Piece[] = [];
  for (const piece of inner.pieces) {
    if (piece.dim !== 2) {
      ctx.diagnostics.warn(
        'linear_extrude() ignores 3D children.',
        node.span,
        'kernel.extrude-3d-child',
      );
      continue;
    }
    const result = guardGeom(ctx, node.span, 'linear_extrude', () => {
      // Manifold cannot extrude downwards, so a negative height is extruded
      // upwards and then mirrored back through the XY plane.
      const magnitude = Math.abs(height);
      let solid = ctx.arena.track(
        ctx.api.Manifold.extrude(
          piece.solid as CrossSection,
          magnitude,
          Math.max(0, slices - 1),
          // OpenSCAD twists clockwise looking down +Z; Manifold's sign is opposite.
          -twist,
          [scaleTop[0], scaleTop[1]] as Vec2,
          center,
        ),
      );
      if (height < 0) {
        solid = ctx.arena.track(solid.mirror([0, 0, 1] as Vec3));
      }
      if (direction && Math.abs(direction[2]) > 1e-12) {
        // `v=` extrudes along an arbitrary vector: shear X and Y with Z.
        const shear: ManifoldMat4 = [
          1, 0, 0, 0,
          0, 1, 0, 0,
          direction[0] / direction[2], direction[1] / direction[2], 1, 0,
          0, 0, 0, 1,
        ];
        solid = ctx.arena.track(solid.transform(shear));
      }
      return solid;
    });
    if (result) pieces.push({ dim: 3, solid: result, color: piece.color, display: piece.display });
  }

  return assembly(pieces, inner.annotations);
}

function buildRotateExtrude(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  const angle = node.params.angle as number;
  const start = node.params.start as number;
  const res = node.params.resolution as Resolution;

  const pieces: Piece[] = [];
  for (const piece of inner.pieces) {
    if (piece.dim !== 2) {
      ctx.diagnostics.warn(
        'rotate_extrude() ignores 3D children.',
        node.span,
        'kernel.extrude-3d-child',
      );
      continue;
    }
    const result = guardGeom(ctx, node.span, 'rotate_extrude', () => {
      const section = piece.solid as CrossSection;
      const rect = section.bounds();
      if (rect.min[0] < -1e-9) {
        ctx.diagnostics.warn(
          'rotate_extrude(): the profile crosses X = 0; only the positive-X part is revolved.',
          node.span,
          'kernel.revolve-crosses-axis',
        );
      }
      const segments = fragments(Math.max(Math.abs(rect.max[0]), Math.abs(rect.min[0])), res);
      let solid = ctx.arena.track(ctx.api.Manifold.revolve(section, segments, angle));
      if (start !== 0) solid = ctx.arena.track(solid.rotate([0, 0, start] as Vec3));
      return solid;
    });
    if (result) pieces.push({ dim: 3, solid: result, color: piece.color, display: piece.display });
  }

  return assembly(pieces, inner.annotations);
}

function buildProjection(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  const cut = node.params.cut as boolean;

  const pieces: Piece[] = [];
  for (const piece of inner.pieces) {
    if (piece.dim !== 3) {
      // Projecting 2D geometry is a no-op rather than an error.
      pieces.push(piece);
      continue;
    }
    const result = guardGeom(ctx, node.span, 'projection', () =>
      // `cut = true` takes the slice through Z = 0; otherwise it is the shadow.
      ctx.arena.track(cut ? (piece.solid as Manifold).slice(0) : (piece.solid as Manifold).project()),
    );
    if (result) pieces.push({ dim: 2, solid: result, color: piece.color, display: piece.display });
  }

  return assembly(pieces, inner.annotations);
}

function buildOffset(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  const amount = node.params.amount as number;
  const round = node.params.round as boolean;
  const chamfer = node.params.chamfer as boolean;
  const res = node.params.resolution as Resolution;

  const pieces: Piece[] = [];
  for (const piece of inner.pieces) {
    if (piece.dim !== 2) {
      ctx.diagnostics.warn('offset() only applies to 2D geometry.', node.span, 'kernel.offset-3d');
      continue;
    }
    const result = guardGeom(ctx, node.span, 'offset', () => {
      // `r=` rounds corners, `delta=` keeps them sharp (miter), and
      // `delta=` with `chamfer=true` cuts them flat (square).
      const joinType = round ? 'Round' : chamfer ? 'Square' : 'Miter';
      const segments = round ? fragments(Math.abs(amount), res) : 0;
      return ctx.arena.track(
        (piece.solid as CrossSection).offset(amount, joinType, 2, segments),
      );
    });
    if (result) pieces.push({ dim: 2, solid: result, color: piece.color, display: piece.display });
  }

  return assembly(pieces, inner.annotations);
}

// ---------------------------------------------------------------------------
// text(), import(), surface()
// ---------------------------------------------------------------------------

function buildText(node: SceneNode, ctx: Ctx): Assembly {
  const text = String(node.params.text ?? '');
  if (text.length === 0) return emptyAssembly();

  if (!ctx.fonts || ctx.fonts.isEmpty) {
    ctx.diagnostics.error(
      'text() needs a font, but none are loaded. Load a font before rendering.',
      node.span,
      'kernel.no-fonts',
    );
    return emptyAssembly();
  }

  const res = node.params.resolution as Resolution;
  const laid = ctx.fonts.layout({
    text,
    size: node.params.size as number,
    font: String(node.params.font ?? ''),
    halign: String(node.params.halign ?? 'left'),
    valign: String(node.params.valign ?? 'baseline'),
    spacing: node.params.spacing as number,
    direction: String(node.params.direction ?? 'ltr'),
    // Curve subdivision: `$fn` if set, otherwise a sensible fixed quality.
    segments: res.fn > 0 ? Math.max(2, Math.round(res.fn / 4)) : 8,
  });

  if (!laid || laid.contours.length === 0) return emptyAssembly();

  return guard(ctx, node.span, 'text', () =>
    // Even-odd fill turns counters (the hole in an 'o') into holes.
    flatPiece(ctx, new ctx.api.CrossSection(laid.contours as Vec2[][], 'EvenOdd')),
  );
}

function buildImport(node: SceneNode, ctx: Ctx): Assembly {
  const file = String(node.params.file ?? '');
  const data = ctx.files.get(file);
  if (!data) {
    // `preloadAssets` already reported why.
    return emptyAssembly();
  }

  const ext = file.toLowerCase().split('.').pop() ?? '';
  const scale = (node.params.scale as number) || 1;
  const origin = node.params.origin as number[];
  const res = node.params.resolution as Resolution;

  if (ext === 'dxf' || ext === 'svg') {
    const segments = res.fn > 0 ? Math.max(4, Math.round(res.fn)) : 32;
    const contours =
      ext === 'dxf'
        ? importDXF(new TextDecoder().decode(data), {
            layer: node.params.layer as string | undefined,
            segments,
          })
        : importSVG(new TextDecoder().decode(data), { segments, dpi: node.params.dpi as number });
    for (const issue of contours.issues) {
      ctx.diagnostics.warn(`${file}: ${issue.message}`, node.span, 'kernel.import-issue');
    }
    if (contours.contours.length === 0) {
      ctx.diagnostics.warn(`${file}: no closed 2D contours found.`, node.span, 'kernel.import-empty');
      return emptyAssembly();
    }
    const transformed = contours.contours.map((contour) =>
      contour.map(([x, y]) => [(x - origin[0]) * scale, (y - origin[1]) * scale] as [number, number]),
    );
    return guard(ctx, node.span, 'import', () =>
      flatPiece(ctx, new ctx.api.CrossSection(transformed as Vec2[][], 'EvenOdd')),
    );
  }

  const imported = importMesh(data, file);
  for (const issue of imported.issues) {
    ctx.diagnostics.warn(`${file}: ${issue.message}`, node.span, 'kernel.import-issue');
  }
  if (imported.mesh.triangles.length === 0) {
    ctx.diagnostics.warn(`${file}: no triangles found.`, node.span, 'kernel.import-empty');
    return emptyAssembly();
  }

  // STL in particular stores each triangle's vertices separately; without
  // welding, the kernel sees a cloud of disconnected triangles, not a solid.
  const welded = weldVertices(imported.mesh);
  if (scale !== 1) {
    for (let i = 0; i < welded.positions.length; i++) welded.positions[i] *= scale;
  }

  return guard(ctx, node.span, 'import', () => solidPiece(ctx, meshToManifold(ctx.api, welded)));
}

function buildSurface(node: SceneNode, ctx: Ctx): Assembly {
  const file = String(node.params.file ?? '');
  const data = ctx.files.get(file);
  if (!data) return emptyAssembly();

  const isDat = /\.dat$/i.test(file);
  let grid;
  if (isDat) {
    grid = parseSurfaceDat(new TextDecoder().decode(data));
  } else {
    const image = ctx.images.get(file);
    if (!image) {
      ctx.diagnostics.error(
        `surface("${file}"): image heightmaps need an image decoder; this host does not provide one.`,
        node.span,
        'kernel.no-image-decoder',
      );
      return emptyAssembly();
    }
    grid = gridFromGrayscale(image.gray, image.width, image.height);
  }

  if (grid.width < 2 || grid.height < 2) {
    ctx.diagnostics.error(
      `surface("${file}"): the heightmap needs at least 2x2 samples.`,
      node.span,
      'kernel.bad-surface',
    );
    return emptyAssembly();
  }

  const mesh = surfaceToMesh(grid, {
    center: node.params.center as boolean,
    invert: node.params.invert as boolean,
  });
  return guard(ctx, node.span, 'surface', () => solidPiece(ctx, meshToManifold(ctx.api, mesh)));
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

function extract(result: Assembly, ctx: Ctx): BuildResult {
  const parts: BuildResult['parts'] = [];
  const contours2d: BuildResult['contours2d'] = [];
  const annotations: BuildResult['annotations'] = [];
  let triangles = 0;
  let vertices = 0;
  let volume = 0;
  let area = 0;
  let has2 = false;
  let has3 = false;

  for (const piece of result.pieces) {
    if (piece.dim === 3) {
      has3 = true;
      const solid = piece.solid as Manifold;
      if (solid.isEmpty()) continue;
      const mesh = manifoldMesh(solid);
      triangles += mesh.triangles.length / 3;
      vertices += mesh.positions.length / 3;
      volume += solid.volume();
      area += solid.surfaceArea();
      parts.push({ mesh, color: piece.color ?? DEFAULT_COLOR, display: piece.display });
    } else {
      has2 = true;
      const section = piece.solid as CrossSection;
      if (section.isEmpty()) continue;
      area += section.area();
      contours2d.push({
        contours: section.toPolygons().map((p) => p.map(([x, y]) => [x, y] as [number, number])),
        color: piece.color ?? DEFAULT_COLOR,
      });
    }
  }

  for (const piece of result.annotations) {
    if (piece.dim !== 3) continue;
    const solid = piece.solid as Manifold;
    if (solid.isEmpty()) continue;
    annotations.push({ mesh: manifoldMesh(solid), color: piece.color ?? [0.6, 0.6, 0.6, 0.25] });
  }

  if (has2 && has3) {
    ctx.diagnostics.warn(
      'The scene mixes 2D and 3D top-level geometry; only the 3D part can be exported as a mesh.',
      undefined,
      'kernel.mixed-top-level',
    );
  }

  return {
    parts,
    contours2d,
    annotations,
    dimension: has3 ? 3 : has2 ? 2 : 0,
    stats: { nodes: ctx.arena.size, triangles, vertices, volume, area },
  };
}

function manifoldMesh(solid: Manifold): TriMesh {
  const mesh = solid.getMesh();
  const numProp = mesh.numProp;
  const count = mesh.vertProperties.length / numProp;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    positions[v * 3] = mesh.vertProperties[v * numProp];
    positions[v * 3 + 1] = mesh.vertProperties[v * numProp + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * numProp + 2];
  }
  return { positions, triangles: new Uint32Array(mesh.triVerts) };
}
