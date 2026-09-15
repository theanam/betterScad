/**
 * BetterSCAD engine — public API.
 *
 * The engine is standalone and UI-agnostic (spec feature 3): it takes source
 * text and returns geometry, diagnostics and a Customizer model. Nothing here
 * assumes a DOM, a bundler, or the BetterSCAD app.
 *
 * Typical use:
 *
 * ```ts
 * const engine = await Engine.create({ wasmUrl });
 * const result = await engine.render(source, { parameters });
 * const stl = engine.export(result, 'stl');
 * ```
 */

import { ScadFile } from './ast.js';
import { CustomizerModel, buildCustomizerModel } from './customizer.js';
import { Diagnostic, DiagnosticBag } from './diagnostics.js';
import { FontRegistry } from './fonts.js';
import { ExportFormat, ExportedFile, exportResult } from './io/export/index.js';
import { AssetProvider, BuildResult, buildGeometry } from './kernel/evaluate.js';
import { ManifoldAPI, WasmOptions, loadKernel } from './kernel/wasm.js';
import { ParseResult, parse } from './parser.js';
import { EvaluateOptions, evaluate } from './interpreter.js';
import { SceneNode, countNodes } from './scene.js';
import { Value } from './values.js';

export interface CompileOptions extends Omit<EvaluateOptions, 'includes'> {
  /** Logical name for the root file; appears in diagnostics. */
  file?: string;
  /**
   * Resolver for `include <...>` / `use <...>`.
   *
   * Returns the file's text, or `undefined` if it cannot be found. Called for
   * transitive includes too, so a resolver only needs to handle one hop.
   */
  resolveInclude?(path: string, fromFile: string): Promise<string | undefined>;
  /** Guard against pathological include graphs. */
  maxIncludeDepth?: number;
}

export interface CompileResult {
  parsed: ParseResult;
  scene: SceneNode;
  diagnostics: Diagnostic[];
  customizer: CustomizerModel;
  /** Top-level variable values after evaluation. */
  variables: Map<string, Value>;
  /** Files pulled in via `include`/`use`, keyed by the path as written. */
  includes: Map<string, ScadFile>;
  timings: { parseMs: number; evaluateMs: number };
}

export interface RenderOptions extends CompileOptions {
  assets?: AssetProvider;
  /** Skip geometry when the source failed to compile. Defaults to true. */
  skipGeometryOnError?: boolean;
  /**
   * Really union the result rather than leaving overlapping pieces separate.
   *
   * Defaults to the opposite of `preview`, which is what the F5/F6 split
   * already means: a preview may draw overlapping solids because nothing
   * downstream cares, while a final render is the geometry Export writes and
   * has to be one solid per colour. Overlapping shells in a mesh file are
   * interior walls, and a slicer reads those as cavities.
   */
  merge?: boolean;
}

export interface RenderResult extends CompileResult {
  geometry: BuildResult;
  timings: { parseMs: number; evaluateMs: number; geometryMs: number };
}

const DEFAULT_MAX_INCLUDE_DEPTH = 32;

/**
 * Compiles source to a scene graph without meshing it.
 *
 * Useful on its own: the Customizer, the outline view and error reporting all
 * need this and none of them need geometry.
 */
export async function compile(source: string, options: CompileOptions = {}): Promise<CompileResult> {
  const file = options.file ?? 'main.scad';

  const parseStart = now();
  const parsed = parse(source, file);
  const includes = await resolveIncludes(parsed, options, file);
  const parseMs = now() - parseStart;

  const evaluateStart = now();
  const evaluated = evaluate(parsed.file, { ...options, includes: includes.files });
  const evaluateMs = now() - evaluateStart;

  const diagnostics = [...parsed.diagnostics, ...includes.diagnostics, ...evaluated.diagnostics.items];

  return {
    parsed,
    scene: evaluated.root,
    diagnostics,
    customizer: buildCustomizerModel(parsed),
    variables: evaluated.topLevelVars,
    includes: includes.files,
    timings: { parseMs, evaluateMs },
  };
}

/**
 * Walks the `include`/`use` graph breadth-first, parsing each file once.
 *
 * Breadth-first (rather than recursive descent) keeps the depth guard
 * meaningful and makes a cycle show up as an already-seen path instead of a
 * stack overflow.
 */
async function resolveIncludes(
  root: ParseResult,
  options: CompileOptions,
  rootFile: string,
): Promise<{ files: Map<string, ScadFile>; diagnostics: Diagnostic[] }> {
  const files = new Map<string, ScadFile>();
  const diagnostics: Diagnostic[] = [];
  if (!options.resolveInclude) return { files, diagnostics };

  const maxDepth = options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  let frontier: { path: string; from: string }[] = collectIncludePaths(root.file).map((path) => ({
    path,
    from: rootFile,
  }));
  const seen = new Set<string>();

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: { path: string; from: string }[] = [];

    await Promise.all(
      frontier.map(async ({ path, from }) => {
        if (seen.has(path)) return;
        seen.add(path);
        let text: string | undefined;
        try {
          text = await options.resolveInclude!(path, from);
        } catch (err) {
          diagnostics.push({
            severity: 'error',
            message: `Failed to load <${path}>: ${err instanceof Error ? err.message : String(err)}`,
            code: 'include.load-failed',
          });
          return;
        }
        if (text === undefined) {
          // The interpreter reports the unresolved include with a source span,
          // so staying quiet here avoids a duplicate message.
          return;
        }
        const parsed = parse(text, path);
        diagnostics.push(...parsed.diagnostics);
        files.set(path, parsed.file);
        for (const child of collectIncludePaths(parsed.file)) next.push({ path: child, from: path });
      }),
    );

    frontier = next;
  }

  if (frontier.length > 0) {
    diagnostics.push({
      severity: 'warning',
      message: `Include graph deeper than ${maxDepth} levels; the remainder was not loaded.`,
      code: 'include.too-deep',
    });
  }

  return { files, diagnostics };
}

function collectIncludePaths(file: ScadFile): string[] {
  const paths: string[] = [];
  for (const stmt of file.body) {
    if (stmt.kind === 'include' || stmt.kind === 'use') paths.push(stmt.path);
  }
  return paths;
}

/**
 * The engine handle: a loaded WASM kernel plus a font registry.
 *
 * Hold one of these for the life of the process. Creating it loads several
 * megabytes of WASM, and geometry from two different kernel instances cannot
 * be combined.
 */
export class Engine {
  private constructor(
    readonly api: ManifoldAPI,
    readonly fonts: FontRegistry,
  ) {}

  static async create(options: WasmOptions & { fonts?: FontRegistry } = {}): Promise<Engine> {
    const api = await loadKernel(options);
    return new Engine(api, options.fonts ?? new FontRegistry());
  }

  /** Compiles and meshes in one step. */
  async render(source: string, options: RenderOptions = {}): Promise<RenderResult> {
    const compiled = await compile(source, options);

    const skipOnError = options.skipGeometryOnError ?? true;
    const hasError = compiled.diagnostics.some((d) => d.severity === 'error');
    if (skipOnError && hasError) {
      return {
        ...compiled,
        geometry: {
          parts: [],
          contours2d: [],
          annotations: [],
          dimension: 0,
          stats: { nodes: countNodes(compiled.scene), triangles: 0, vertices: 0, volume: 0, area: 0 },
        },
        timings: { ...compiled.timings, geometryMs: 0 },
      };
    }

    const bag = new DiagnosticBag();
    const geometryStart = now();
    const geometry = await buildGeometry(compiled.scene, {
      api: this.api,
      diagnostics: bag,
      fonts: this.fonts,
      assets: options.assets,
      merge: options.merge ?? options.preview !== true,
    });
    const geometryMs = now() - geometryStart;

    return {
      ...compiled,
      diagnostics: [...compiled.diagnostics, ...bag.items],
      geometry: { ...geometry, stats: { ...geometry.stats, nodes: countNodes(compiled.scene) } },
      timings: { ...compiled.timings, geometryMs },
    };
  }

  /** Serialises a render result to one of the supported formats. */
  export(result: RenderResult | BuildResult, format: ExportFormat, options = {}): ExportedFile {
    const geometry = 'geometry' in result ? result.geometry : result;
    return exportResult(geometry, format, options);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// --- re-exports: the full public surface ------------------------------------

export * from './ast.js';
export * from './bscad.js';
export * from './colors.js';
export * from './customizer.js';
export * from './diagnostics.js';
export * from './fonts.js';
export * from './roles.js';
export * from './scene.js';
export * from './transpile.js';
export * from './values.js';
export { BUILTIN_FUNCTIONS } from './builtins.js';
export { BUILTIN_CONSTANTS, BUILTIN_MODULES, evaluate } from './interpreter.js';
export { MODIFIER_ROLES, parse } from './parser.js';
export type { ParseResult } from './parser.js';
export { lex } from './lexer.js';
export * from './geom/mesh.js';
export { parseSurfaceDat, surfaceToMesh, gridFromGrayscale } from './geom/surface.js';
export * from './io/export/index.js';
export { importMesh, importSTL, importOBJ, importOFF } from './io/import/mesh.js';
export { importDXF } from './io/import/dxf.js';
export { importSVG } from './io/import/svg.js';
export { buildGeometry } from './kernel/evaluate.js';
export type { AssetProvider, BuildOptions, BuildResult } from './kernel/evaluate.js';
export { loadKernel, kernelIfReady } from './kernel/wasm.js';
export type { ManifoldAPI, WasmOptions } from './kernel/wasm.js';
export { manifoldToMesh, meshToManifold } from './kernel/primitives.js';
export type { Assembly, Piece, RGBA } from './kernel/geometry.js';

/** Engine version, reported by `betterscad --version` and the about panel. */
export const ENGINE_VERSION = '0.4.1';
