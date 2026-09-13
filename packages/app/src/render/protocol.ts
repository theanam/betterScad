/**
 * Message protocol between the app and the render worker.
 *
 * Geometry crosses this boundary as transferable typed arrays, so a large
 * model costs one pointer handoff rather than a structured clone.
 */

import type { CustomizerModel, Diagnostic, ExportFormat, Value } from '@betterscad/engine';

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
  /** Binary assets for `import()` / `surface()`, keyed by the path in the script. */
  assets: Record<string, Uint8Array>;
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
  assets: Record<string, Uint8Array>;
  time: number;
}

export interface LoadFontRequest {
  type: 'load-font';
  id: number;
  data: Uint8Array;
  /** Marks this family as the one bare `text()` should use. */
  makeDefault?: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export type WorkerRequest = RenderRequest | ExportRequest | LoadFontRequest | CancelRequest;

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
  | ErrorResponse
  | ReadyResponse;
