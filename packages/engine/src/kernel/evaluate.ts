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
import { Mat4, Resolution, SceneNode, determinant3, fragments, isScopeGroup, walk } from '../scene.js';
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
  /**
   * Really union the result before handing it back.
   *
   * Off while previewing, where overlapping solids cost nothing: the viewport
   * draws them happily and skipping the boolean is most of what makes a preview
   * quick. On for a final render and for export, where they are not free at all
   * — overlapping shells in a mesh file are interior walls, and a slicer reads
   * those as cavities.
   */
  merge?: boolean;
}

export interface BuildResult {
  /** Exportable geometry, one entry per colour group. */
  parts: { mesh: TriMesh; color: RGBA; display: Display }[];
  /** 2D result, when the scene is two-dimensional. */
  contours2d: { contours: [number, number][][]; color: RGBA }[];
  /** Preview-only `%`-role geometry. */
  annotations: { mesh: TriMesh; color: RGBA; display: Display }[];
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
    return extract(result, ctx, options.merge === true);
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

/**
 * Nodes a `negative()` may not escape.
 *
 * A brace scope (`{ … }`, a module body, the top level) bounds it by
 * definition. Dimension-changing nodes bound it too, for a different reason:
 * a 2D negative carried up past a `linear_extrude` would be meaningless in the
 * 3D scope above, so it is reported rather than silently mismatched.
 */
function isScopeBarrier(node: SceneNode): boolean {
  if (isScopeGroup(node)) return true;
  return (
    node.op === 'linear_extrude' ||
    node.op === 'rotate_extrude' ||
    node.op === 'projection' ||
    node.op === 'offset'
  );
}

/**
 * True once a `!` below this node has claimed the render.
 *
 * The root modifier does not mean "show only this" — it means *use this subtree
 * as the design root*. Everything outside the marked subtree is therefore
 * discarded, and that includes the operations wrapping it: transforms, colour,
 * resize, the extrudes, projection, offset. Everything inside it still applies.
 * The manual states the asymmetry directly: in `translate(…) !rotate(…) cube();`
 * the rotate runs and the translate has no effect.
 *
 * Every operation that wraps a child assembly has to ask this before touching
 * it, and hand the assembly back untouched when it is true — which also keeps
 * the flag travelling up to the top level.
 */
function claimedByRoot(inner: Assembly): boolean {
  return inner.isolated;
}

function combine(node: SceneNode, ctx: Ctx, op: CombineOp): Assembly {
  const operands: Assembly[] = [];
  const annotations: Piece[] = [];
  // Negatives written here, plus any that bubbled up from a child wrapper.
  const negatives: Piece[] = [];

  for (const child of node.children) {
    const contribution: Contribution = resolveContribution(child.roles);
    if (contribution === 'ignored') continue;

    const evaluated = evaluateNode(child, ctx);

    // A `root` node anywhere below claims the whole render; drop the siblings
    // and keep propagating upwards.
    if (evaluated.isolated) return { ...evaluated, isolated: true };
    if (contribution === 'isolate') {
      return {
        pieces: evaluated.pieces,
        annotations: evaluated.annotations,
        negatives: [],
        isolated: true,
      };
    }

    annotations.push(...evaluated.annotations);
    // A child that could not place its own negatives hands them to this scope.
    negatives.push(...evaluated.negatives);

    // A child's own display role (`#`) applies to the geometry it produced,
    // whether that child is a leaf primitive or a whole subtree.
    const childDisplay = resolveDisplay(child.roles);

    // `#` is an overlay, not a colour.
    //
    // OpenSCAD draws the marked subtree as a transparent volume *and* lets it
    // go on doing whatever it was doing — which is the only reason the modifier
    // is useful on a cutter: the hole is still cut, and you can see where. A
    // copy therefore rides along in `annotations`, which no boolean can reach,
    // so it survives being consumed by the very difference it is marking.
    // Recolouring the pieces instead, as this used to, showed nothing at all in
    // that case: the pieces were subtracted away and took the highlight with
    // them.
    if (childDisplay === 'highlight') {
      // Pieces *and* negatives. A `#` written outside a `negative()` — as in
      // `#translatez(4) negative() thread(…)` — sees an assembly whose geometry
      // is entirely in `negatives`, because a negative rides up through
      // wrappers like that one and never becomes a piece at this level. Copying
      // only the pieces highlighted nothing at all, which is the same hole the
      // difference() case had, one layer further in.
      annotations.push(
        ...[...evaluated.pieces, ...evaluated.negatives].map((p) => ({
          ...p,
          display: 'highlight' as Display,
        })),
      );
    }

    const displayed =
      childDisplay === 'normal' || childDisplay === 'highlight'
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
        negatives.push(...displayed.pieces);
        break;
      default:
        // Annotations already went into this scope's own list, a few lines up.
        // Left on the operand they would be collected a second time by
        // `applyOperation`, which flat-maps them out of every operand it is
        // given — and since the result of that is itself an operand one level
        // up, a `%` ghost doubled per level of nesting. Two unions deep, four
        // copies of the same preview geometry.
        operands.push(displayed.annotations.length > 0 ? { ...displayed, annotations: [] } : displayed);
    }
  }

  const combined = applyOperation(operands, op, ctx, node.span);

  let pieces = combined.pieces;
  let pending: Piece[] = [];

  if (negatives.length > 0) {
    if (pieces.length > 0) {
      // There is something to cut here, so this is the negative's scope.
      pieces = subtractPieces(pieces, negatives, ctx, node.span);
    } else if (isScopeBarrier(node)) {
      // The scope ends here and nothing was cut. Silently dropping geometry is
      // the worst outcome, so say so.
      ctx.diagnostics.warn(
        'negative() has nothing to subtract from in this scope; it produces no geometry.',
        node.span,
        'kernel.negative-unused',
      );
    } else {
      // Not a scope: ride up to the enclosing one, transforms and all.
      pending = negatives;
    }
  }

  // `highlight` is deliberately not applied here: the parent's loop above has
  // already carried a copy into `annotations`, and recolouring the pieces too
  // would draw the subtree twice, once solid and once as the overlay.
  const display = resolveDisplay(node.roles);
  if (display !== 'normal' && display !== 'highlight') {
    pieces = pieces.map((p) => ({ ...p, display }));
  }

  return {
    pieces,
    annotations: [...annotations, ...combined.annotations],
    negatives: pending,
    isolated: false,
  };
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
 * Subtracts negative geometry from a scope's assembled pieces.
 *
 * This is the whole implementation of the `negative()` extension: the combiner
 * routed the geometry here purely on its declared contribution, and every piece
 * keeps its own colour through the cut.
 */
function subtractPieces(
  base: Piece[],
  cutters: Piece[],
  ctx: Ctx,
  span: SourceSpan | undefined,
): Piece[] {
  const cutters3 = cutters.filter((p) => p.dim === 3).map((p) => p.solid as Manifold);
  const cutters2 = cutters.filter((p) => p.dim === 2).map((p) => p.solid as CrossSection);
  const out: Piece[] = [];

  for (const piece of base) {
    const relevant = piece.dim === 3 ? cutters3 : cutters2;
    if (relevant.length === 0) {
      out.push(piece);
      continue;
    }
    const result = guardGeom(ctx, span, 'negative', () =>
      piece.dim === 3
        ? ctx.arena.track(
            ctx.api.Manifold.difference([piece.solid as Manifold, ...(cutters3 as Manifold[])]),
          )
        : ctx.arena.track(
            ctx.api.CrossSection.difference([
              piece.solid as CrossSection,
              ...(cutters2 as CrossSection[]),
            ]),
          ),
    );
    if (result) out.push({ ...piece, solid: result });
  }
  return out;
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
  if (claimedByRoot(input)) return input;
  if (input.pieces.length === 0 && input.annotations.length === 0 && input.negatives.length === 0) {
    return input;
  }

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
    // Negatives on their way up must carry this transform with them, or they
    // would cut at the position they were written rather than where they sit.
    negatives: input.negatives.map(map),
    isolated: input.isolated,
  };
}

function applyColor(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  if (claimedByRoot(inner)) return inner;
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
    // Colour is a display property; it must not stop a negative bubbling.
    negatives: inner.negatives,
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
  if (claimedByRoot(inner)) return inner;
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
  if (claimedByRoot(inner)) return inner;
  const height = node.params.height as number;
  const center = node.params.center as boolean;
  const twist = node.params.twist as number;
  const slices = node.params.slices as number;
  const scaleTop = node.params.scaleTop as number[];
  const ease = (node.params.ease as number[] | undefined) ?? [0, 0];
  const eased = ease[0] !== 0 || ease[1] !== 0;
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
      let solid = eased
        ? easedExtrude(piece.solid as CrossSection, {
            height: magnitude,
            slices,
            twist,
            scaleTop,
            ease,
            center,
          }, ctx)
        : ctx.arena.track(
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

/**
 * The easing curve, as a cubic Hermite from 0 to 1.
 *
 * The end tangents are the whole parameter: `ease` of 0 at an end leaves the
 * slope at 1 there, and 1 flattens it to 0. Written out, the cubic collapses to
 * two correction terms hung off the straight line —
 *
 *     f(t) = t − bottom·t(t−1)² − top·t²(t−1)
 *
 * — which is worth preferring over the Hermite basis it came from, because it
 * puts the important property where you can see it: at `ease = 0` both
 * corrections vanish and `f(t) = t` exactly. The straight taper is not
 * approximated by the eased one, it *is* the eased one. At `ease = 1` both ends
 * flatten and the result is the smoothstep `3t² − 2t³`; anything between is a
 * genuine blend, which is what makes this something you dial rather than pick.
 *
 * Monotonic for every input it accepts: a cubic Hermite rising from 0 to 1 is
 * monotonic while both tangents sit in [0, 3], and these are clamped to [0, 1].
 * That matters more than it looks — a profile that folded back on itself would
 * put the extrusion inside out, and no warning could make that a useful result.
 */
function easeAt(t: number, bottom: number, top: number): number {
  return t - bottom * t * (t - 1) * (t - 1) - top * t * t * (t - 1);
}

interface EasedExtrude {
  height: number;
  slices: number;
  twist: number;
  scaleTop: number[];
  ease: number[];
  center: boolean;
}

/**
 * A tapered extrusion whose scale follows a curve rather than a straight line.
 *
 * `Manifold.extrude` interpolates its scale linearly and offers no hook, so the
 * curve is built as a stack of short extrusions, each straight, each starting
 * where the last one stopped. This is the same construction the `.scad`
 * downgrade emits, which is the point: the two agree because they are the same
 * shape, not because two implementations were kept in step by hand.
 *
 * Twist stays linear through the stack. `ease` names what the *taper* does, and
 * a parameter that quietly bent the twist as well would be impossible to use
 * for either one on its own.
 */
function easedExtrude(section: CrossSection, spec: EasedExtrude, ctx: Ctx): Manifold {
  const { height, slices, twist, scaleTop, ease, center } = spec;
  const segments: Manifold[] = [];

  for (let i = 0; i < slices; i++) {
    const t0 = i / slices;
    const t1 = (i + 1) / slices;
    const f0 = easeAt(t0, ease[0], ease[1]);
    const f1 = easeAt(t1, ease[0], ease[1]);

    const at = (f: number): Vec2 => [
      1 + (scaleTop[0] - 1) * f,
      1 + (scaleTop[1] - 1) * f,
    ];
    const from = at(f0);
    const to = at(f1);

    // `scale = 0` is a legal cone, and with the profile starting at 1 only the
    // top can reach it — so the ratio below divides by zero only if a caller
    // asks for a segment that starts nowhere, which this loop cannot produce.
    if (from[0] === 0 || from[1] === 0) continue;

    const base = ctx.arena.track(section.scale(from));
    const segment = ctx.arena.track(
      ctx.api.Manifold.extrude(
        base,
        height / slices,
        0,
        -twist * (t1 - t0),
        [to[0] / from[0], to[1] / from[1]] as Vec2,
        false,
      ),
    );
    // Each segment twists from zero at its own base, so it is turned to meet
    // the twist the stack has already accumulated underneath it.
    //
    // `center` is folded into the same translation rather than applied to the
    // union afterwards. Both put the solid in the same place, but the union
    // merges the coplanar faces where segments meet, and merging is decided on
    // the coordinates it is given — so translating afterwards produced a mesh
    // that differed from the `.scad` downgrade's by a few triangles on exactly
    // the same solid. Doing it in the same order as the downgrade makes the two
    // meshes identical, which is a far easier property to test than "close".
    segments.push(
      ctx.arena.track(
        ctx.arena
          .track(segment.rotate([0, 0, -twist * t0] as Vec3))
          .translate([0, 0, height * t0 - (center ? height / 2 : 0)] as Vec3),
      ),
    );
  }

  return ctx.arena.track(ctx.api.Manifold.union(segments));
}

function buildRotateExtrude(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  if (claimedByRoot(inner)) return inner;
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

      // Swept by the magnitude and then turned back, rather than handing the
      // negative angle straight to `revolve`.
      //
      // Given a negative angle Manifold sweeps the other way round and reverses
      // the winding with it, so the result is inside-out: `rotate_extrude(angle
      // = -90)` came out with the volume of the +90 sweep and the sign flipped.
      // Nothing local catches that — the mesh is closed, it is edge-manifold,
      // and the viewport shades both faces, so it looks right. It only surfaces
      // later, as a boolean that produces nonsense or an STL whose normals all
      // point inward, which a slicer reads as a hole where the solid should be.
      const sweep = Math.abs(angle);
      let solid = ctx.arena.track(ctx.api.Manifold.revolve(section, segments, sweep));
      if (angle < 0) solid = ctx.arena.track(solid.rotate([0, 0, angle] as Vec3));
      if (start !== 0) solid = ctx.arena.track(solid.rotate([0, 0, start] as Vec3));
      return solid;
    });
    if (result) pieces.push({ dim: 3, solid: result, color: piece.color, display: piece.display });
  }

  return assembly(pieces, inner.annotations);
}

function buildProjection(node: SceneNode, ctx: Ctx): Assembly {
  const inner = combine(node, ctx, 'union');
  if (claimedByRoot(inner)) return inner;
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
  if (claimedByRoot(inner)) return inner;
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

  const radius = node.params.radius as number | undefined;
  if (radius !== undefined) {
    if (!(Math.abs(radius) > 0)) {
      ctx.diagnostics.error(
        'text(): radius must not be zero — there is no circle to lay the text on.',
        node.span,
        'kernel.text-radius',
      );
      return emptyAssembly();
    }
    const direction = String(node.params.direction ?? 'ltr');
    if (direction !== 'ltr') {
      // Stacking glyphs vertically and laying them on a circle are two
      // different answers to "which way does the run go". Refused rather than
      // guessed at.
      ctx.diagnostics.error(
        `text(): radius cannot be combined with direction = "${direction}".`,
        node.span,
        'kernel.text-radius-direction',
      );
      return emptyAssembly();
    }
    return buildArcText(node, ctx, radius);
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

/**
 * `text(radius = …)` — the run laid on a circle instead of a straight baseline.
 *
 * Each glyph is placed rigid: rotated onto the tangent and translated out to
 * the radius, not bent. Warping the outlines would read better on a tight
 * circle, but it could only ever be exported as raw polygons — and this way the
 * legacy export is per-glyph `text()` calls, which keep the reader's own font.
 *
 * A glyph sits at the midpoint of its own advance rather than at its left edge.
 * It costs nothing and it is the difference between a word that looks centred
 * on the arc and one that drifts.
 *
 * Spacing is proportional, which is why this lives here rather than in the
 * interpreter: advance widths need a font, and fonts arrive with the geometry.
 *
 * The legacy export agrees with this to about one part in a billion rather than
 * bit for bit. It reaches the same placement by a different route — its
 * per-glyph `text(halign = "center")` measures the advance itself, in a
 * different multiplication order — and floating-point multiplication is not
 * associative. The residue is nanometres on a part measured in millimetres, and
 * closing it would mean pinning the arithmetic of `text()` itself.
 */
function buildArcText(node: SceneNode, ctx: Ctx, radius: number): Assembly {
  const res = node.params.resolution as Resolution;
  const measured = ctx.fonts!.glyphs({
    text: String(node.params.text ?? ''),
    size: node.params.size as number,
    font: String(node.params.font ?? ''),
    halign: 'left',
    valign: 'baseline',
    spacing: node.params.spacing as number,
    direction: String(node.params.direction ?? 'ltr'),
    segments: res.fn > 0 ? Math.max(2, Math.round(res.fn / 4)) : 8,
  });
  if (!measured || measured.glyphs.length === 0) return emptyAssembly();

  const { glyphs, ascender, descender } = measured;
  const total = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);

  // `halign` keeps its meaning, measured around the start angle rather than
  // around x = 0.
  const halign = String(node.params.halign ?? 'left');
  const lead = halign === 'center' ? -total / 2 : halign === 'right' ? -total : 0;

  // And `valign` still shifts the baseline — which out here is radial.
  const valign = String(node.params.valign ?? 'baseline');
  const lift =
    valign === 'top' ? -ascender
    : valign === 'center' ? -(ascender + descender) / 2
    : valign === 'bottom' ? -descender
    : 0;

  const inward = String(node.params.facing ?? 'out') === 'in';
  const start = node.params.start as number;

  const contours: [number, number][][] = [];
  let arc = lead;

  for (const glyph of glyphs) {
    // The angle subtended by everything before this glyph, plus half of it.
    // Computed in degrees, the same way round as the generated module does it,
    // so the two agree to the last bit rather than to a tolerance.
    const sweep = ((arc + glyph.advance / 2) / radius) * (180 / Math.PI);
    // Reading runs clockwise seen from +Z, so that a run starting at the top
    // reads left to right. Facing inward reverses it, which is what keeps the
    // bottom of a dial readable the same way up.
    const degrees = inward ? start + sweep : start - sweep;
    const angle = degrees * (Math.PI / 180);
    // Upright means "up is away from the centre", so the glyph turns with the
    // tangent; facing inward turns it the other half-turn.
    const spin = (inward ? degrees + 90 : degrees - 90) * (Math.PI / 180);
    const cos = Math.cos(spin);
    const sin = Math.sin(spin);
    const cx = radius * Math.cos(angle);
    const cy = radius * Math.sin(angle);

    for (const contour of glyph.contours) {
      contours.push(
        contour.map(([gx, gy]) => {
          // Centre the glyph on its own advance, then lift it to the circle.
          const x = gx - glyph.advance / 2;
          const y = gy + lift;
          return [cx + x * cos - y * sin, cy + x * sin + y * cos] as [number, number];
        }),
      );
    }
    arc += glyph.advance;
  }

  if (contours.length === 0) return emptyAssembly();
  return guard(ctx, node.span, 'text', () =>
    flatPiece(ctx, new ctx.api.CrossSection(contours as Vec2[][], 'EvenOdd')),
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

/**
 * Unions the 3D pieces that share a colour and a display treatment.
 *
 * `union` is lazy everywhere else, and deliberately so — pieces stay separate
 * so each keeps its own colour, and not running the boolean is most of what
 * makes a preview quick. A mesh file cannot afford the same laziness: two
 * overlapping shells written to an STL are an interior wall, and a slicer reads
 * a wall it cannot get outside of as a cavity.
 *
 * Grouped by colour rather than merged wholesale, because a multi-colour export
 * carries one object per colour and unioning across them would throw that away.
 * Pieces of the same colour cannot be told apart in the file anyway.
 *
 * A boolean that fails leaves its group alone rather than dropping it: an
 * export that is merely unmerged beats one that is missing a part.
 */
function mergePieces(pieces: readonly Piece[], ctx: Ctx): Piece[] {
  const out: Piece[] = [];
  const groups: Piece[][] = [];
  const index = new Map<string, number>();

  for (const piece of pieces) {
    if (piece.dim !== 3) {
      out.push(piece);
      continue;
    }
    const key = `${piece.display}|${piece.color ? piece.color.join(',') : ''}`;
    let at = index.get(key);
    if (at === undefined) {
      at = groups.length;
      index.set(key, at);
      groups.push([]);
    }
    groups[at].push(piece);
  }

  for (const group of groups) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const merged = guardGeom(ctx, undefined, 'union', () =>
      ctx.arena.track(ctx.api.Manifold.union(group.map((p) => p.solid as Manifold))),
    );
    if (merged) out.push({ dim: 3, solid: merged, color: group[0].color, display: group[0].display });
    else out.push(...group);
  }

  return out;
}

function extract(result: Assembly, ctx: Ctx, merge: boolean): BuildResult {
  const pieces = merge ? mergePieces(result.pieces, ctx) : result.pieces;
  const parts: BuildResult['parts'] = [];
  const contours2d: BuildResult['contours2d'] = [];
  const annotations: BuildResult['annotations'] = [];
  let triangles = 0;
  let vertices = 0;
  let volume = 0;
  let area = 0;
  let has2 = false;
  let has3 = false;

  for (const piece of pieces) {
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
    annotations.push({
      mesh: manifoldMesh(solid),
      color: piece.color ?? [0.6, 0.6, 0.6, 0.25],
      display: piece.display,
    });
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
