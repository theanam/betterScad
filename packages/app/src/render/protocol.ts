/**
 * Message protocol between the app and the render worker.
 *
 * Geometry crosses this boundary as transferable typed arrays, so a large
 * model costs one pointer handoff rather than a structured clone.
 */

import type {
  CustomizerModel,
  Diagnostic,
  ExportFormat,
  ExtensionUse,
  Value,
} from '@betterscad/engine';

/** A loaded font face. The style is what makes a `font=` spec unambiguous. */
export interface FontFaceInfo {
  family: string;
  style: string;
}

export interface RenderRequest {
  type: 'render';
  id: number;
  source: string;
  /** Other open documents, so `include <...>` can resolve against them. */
  files: Record<string, string>;
  parameters: Record<string, Value>;
  time: number;
  /** F5 preview vs F6 full render (spec feature 14). */
  preview: boolean;
}

export interface ExportRequest {
  type: 'export';
  id: number;
  format: ExportFormat;
  /** Re-renders at full quality before exporting, so F5 preview never ships. */
  source: string;
  files: Record<string, string>;
  parameters: Record<string, Value>;
  time: number;
}

/**
 * Replaces the worker's copy of the project directory.
 *
 * Sent when the directory changes rather than with every render. The files are
 * the same on every keystroke and a directory holding a couple of STLs is
 * megabytes; shipping it with each auto-render would structured-clone all of it
 * several times a second to say nothing new.
 */
export interface SetFilesRequest {
  type: 'set-files';
  /** The whole directory, by path. Replaces whatever the worker held. */
  files: Record<string, Uint8Array>;
}

export interface LoadFontRequest {
  type: 'load-font';
  id: number;
  data: Uint8Array;
  /** Marks this family as the one bare `text()` should use. */
  makeDefault?: boolean;
}

/**
 * Rewriting to stock `.scad`, which happens in the worker rather than on the
 * main thread for one reason: `text(radius = …)` is rewritten from measured
 * glyph widths, and the fonts live here.
 */
export interface TranspileRequest {
  type: 'transpile';
  id: number;
  source: string;
  /** Logical name, for diagnostics. */
  file: string;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type WorkerRequest =
  | RenderRequest
  | ExportRequest
  | SetFilesRequest
  | LoadFontRequest
  | TranspileRequest
  | CancelRequest;

/** One file a render resolved, and which of the two directories supplied it. */
export interface Dependency {
  path: string;
  source: 'tab' | 'project';
}

/** One colour group of the rendered model. */
export interface MeshPayload {
  positions: Float32Array;
  /** Smoothed-by-angle vertex normals, computed in the worker. */
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
  display: 'normal' | 'transparent' | 'highlight';
}

export interface RenderStats {
  nodes: number;
  triangles: number;
  vertices: number;
  volume: number;
  area: number;
  parseMs: number;
  evaluateMs: number;
  geometryMs: number;
  totalMs: number;
}

export interface RenderResponse {
  type: 'render-result';
  id: number;
  ok: true;
  meshes: MeshPayload[];
  annotations: MeshPayload[];
  /** Flattened 2D contours, for the 2D preview. */
  contours: { points: Float32Array; color: [number, number, number, number] }[];
  dimension: 2 | 3 | 0;
  /** Echoes the request's mode, so the UI can show which one you are looking at. */
  preview: boolean;
  diagnostics: Diagnostic[];
  /**
   * Fonts the model asked for, whether or not they were available.
   *
   * The app fetches the ones it can and re-renders, so naming a font in the
   * source is all it takes to get it — there is nothing to load by hand.
   */
  fontsUsed: string[];
  /**
   * Every file the render actually pulled in.
   *
   * Recorded by the resolvers as they serve, not guessed from the source: an
   * `include` inside an `if` that never runs is still in the text, and a
   * library three levels down the include graph is not. This is what Save as
   * zip packages, so "what does this model depend on" has to be the engine's
   * answer rather than a regular expression's.
   */
  dependencies: Dependency[];
  customizer: CustomizerModel;
  stats: RenderStats;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  fonts: string[];
  fontFaces: FontFaceInfo[];
}

export interface ExportResponse {
  type: 'export-result';
  id: number;
  ok: true;
  data: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface FontResponse {
  type: 'font-result';
  id: number;
  ok: true;
  family?: string;
  style?: string;
  families: string[];
  faces: FontFaceInfo[];
}

export interface TranspileResponse {
  type: 'transpile-result';
  id: number;
  source: string;
  extensions: ExtensionUse[];
  rewrites: string[];
  verbatim: boolean;
  errors: Diagnostic[];
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  ok: false;
  message: string;
}

export interface ReadyResponse {
  type: 'ready';
  ok: true;
}

export type WorkerResponse =
  | RenderResponse
  | ExportResponse
  | FontResponse
  | TranspileResponse
  | ErrorResponse
  | ReadyResponse;
