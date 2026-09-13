/// <reference lib="webworker" />
/**
 * The render worker.
 *
 * The whole engine — parser, evaluator and the Manifold WASM kernel — lives
 * here. Nothing about geometry touches the main thread, so a slow boolean
 * never freezes typing (spec feature 14: fast preview alongside full render).
 */

import {
  Engine,
  FontRegistry,
  exportResult,
  type AssetProvider,
  type Value,
} from '@betterscad/engine';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

import type {
  ExportRequest,
  LoadFontRequest,
  MeshPayload,
  RenderRequest,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

const fonts = new FontRegistry();
let enginePromise: Promise<Engine> | undefined;

/** The id of the newest render request; older ones are abandoned mid-flight. */
let latestRenderId = 0;
const cancelled = new Set<number>();

function engine(): Promise<Engine> {
  if (!enginePromise) enginePromise = Engine.create({ wasmUrl, fonts });
  return enginePromise;
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'render':
        latestRenderId = request.id;
        await handleRender(request);
        return;
      case 'export':
        await handleExport(request);
        return;
      case 'load-font':
        handleFont(request);
        return;
      case 'cancel':
        cancelled.add(request.id);
        return;
    }
  } catch (err) {
    post({
      type: 'error',
      id: request.id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

// ---------------------------------------------------------------------------

function makeResolver(files: Record<string, string>) {
  return async (path: string): Promise<string | undefined> => {
    // Exact match first, then a basename match so `include <lib/util.scad>`
    // finds an open tab named `util.scad`.
    if (path in files) return files[path];
    const base = path.split('/').pop() ?? path;
    for (const [name, text] of Object.entries(files)) {
      if (name === base || name.split('/').pop() === base) return text;
    }
    return undefined;
  };
}

function makeAssets(assets: Record<string, Uint8Array>): AssetProvider {
  return {
    async read(path) {
      if (path in assets) return assets[path];
      const base = path.split('/').pop() ?? path;
      for (const [name, data] of Object.entries(assets)) {
        if (name === base || name.split('/').pop() === base) return data;
      }
      return undefined;
    },
    async decodeImage(data, path) {
      // OffscreenCanvas keeps image decoding in the worker; without it a
      // `surface("heightmap.png")` would have to round-trip to the main thread.
      try {
        const blob = new Blob([data as BlobPart]);
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const gray = new Uint8Array(bitmap.width * bitmap.height);
        for (let i = 0; i < gray.length; i++) {
          // Rec. 601 luma, the usual choice for heightmaps.
          gray[i] =
            (pixels[i * 4] * 299 + pixels[i * 4 + 1] * 587 + pixels[i * 4 + 2] * 114) / 1000;
        }
        bitmap.close();
        return { gray, width: bitmap.width, height: bitmap.height };
      } catch {
        void path;
        return undefined;
      }
    },
  };
}

async function handleRender(request: RenderRequest): Promise<void> {
  const started = performance.now();
  const api = await engine();
  if (cancelled.has(request.id) || request.id !== latestRenderId) {
    // Another render was requested while the kernel was loading; drop this one.
    cancelled.delete(request.id);
    return;
  }

  const result = await api.render(request.source, {
    file: 'main.scad',
    parameters: request.parameters as Record<string, Value>,
    time: request.time,
    preview: request.preview,
    resolveInclude: makeResolver(request.files),
    assets: makeAssets(request.assets),
  });

  if (cancelled.has(request.id) || request.id !== latestRenderId) {
    cancelled.delete(request.id);
    return;
  }

  const transfer: Transferable[] = [];
  const meshes = result.geometry.parts.map((part) =>
    toPayload(part.mesh, part.color, part.display, transfer),
  );
  const annotations = result.geometry.annotations.map((part) =>
    toPayload(part.mesh, part.color, 'transparent', transfer),
  );

  const contours = result.geometry.contours2d.flatMap((group) =>
    group.contours.map((contour) => {
      const points = new Float32Array(contour.length * 2);
      contour.forEach(([x, y], i) => {
        points[i * 2] = x;
        points[i * 2 + 1] = y;
      });
      transfer.push(points.buffer);
      return { points, color: group.color };
    }),
  );

  post(
    {
      type: 'render-result',
      id: request.id,
      ok: true,
      meshes,
      annotations,
      contours,
      dimension: result.geometry.dimension,
      diagnostics: result.diagnostics,
      customizer: result.customizer,
      stats: {
        ...result.geometry.stats,
        parseMs: result.timings.parseMs,
        evaluateMs: result.timings.evaluateMs,
        geometryMs: result.timings.geometryMs,
        totalMs: performance.now() - started,
      },
      bounds: boundsOf(meshes),
      fonts: fonts.families,
      fontFaces: fonts.list,
    },
    transfer,
  );
}

async function handleExport(request: ExportRequest): Promise<void> {
  const api = await engine();
  // Always re-render at full quality: exporting what the fast preview happened
  // to produce would silently ship lower-resolution geometry.
  const result = await api.render(request.source, {
    file: 'main.scad',
    parameters: request.parameters as Record<string, Value>,
    time: request.time,
    preview: false,
    resolveInclude: makeResolver(request.files),
    assets: makeAssets(request.assets),
  });

  const blocking = result.diagnostics.filter((d) => d.severity === 'error');
  if (blocking.length > 0) {
    post({
      type: 'error',
      id: request.id,
      ok: false,
      message: `Cannot export while the model has errors:\n${blocking[0].message}`,
    });
    return;
  }

  const file = exportResult(result.geometry, request.format, { generator: 'BetterSCAD' });
  post(
    {
      type: 'export-result',
      id: request.id,
      ok: true,
      data: file.data,
      mimeType: file.mimeType,
      extension: file.extension,
    },
    [file.data.buffer as ArrayBuffer],
  );
}

function handleFont(request: LoadFontRequest): void {
  const face = fonts.register(request.data);
  if (!face) {
    post({ type: 'error', id: request.id, ok: false, message: 'That file is not a readable font.' });
    return;
  }
  if (request.makeDefault) fonts.setDefaultFamily(face.family);
  post({
    type: 'font-result',
    id: request.id,
    ok: true,
    family: face.family,
    style: face.style,
    families: fonts.families,
    faces: fonts.list,
  });
}

// ---------------------------------------------------------------------------

/**
 * Converts a mesh to a GPU-ready payload with angle-weighted vertex normals.
 *
 * Normals are computed here rather than in the viewport because the worker
 * already owns the data, and because splitting hard edges on the main thread
 * would mean shipping the mesh twice.
 */
function toPayload(
  mesh: { positions: Float32Array; triangles: Uint32Array },
  color: [number, number, number, number],
  display: MeshPayload['display'],
  transfer: Transferable[],
): MeshPayload {
  const { positions, triangles } = mesh;
  const normals = new Float32Array(positions.length);

  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t] * 3;
    const ib = triangles[t + 1] * 3;
    const ic = triangles[t + 2] * 3;

    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];

    // The un-normalised cross product is already area-weighted, which gives
    // better results than averaging unit normals on irregular meshes.
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    for (const index of [ia, ib, ic]) {
      normals[index] += nx;
      normals[index + 1] += ny;
      normals[index + 2] += nz;
    }
  }

  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (length > 0) {
      normals[i] /= length;
      normals[i + 1] /= length;
      normals[i + 2] /= length;
    } else {
      normals[i + 2] = 1;
    }
  }

  const payload: MeshPayload = { positions, normals, indices: triangles, color, display };
  transfer.push(positions.buffer, normals.buffer, triangles.buffer as ArrayBuffer);
  return payload;
}

function boundsOf(meshes: MeshPayload[]): { min: [number, number, number]; max: [number, number, number] } | null {
  if (meshes.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = mesh.positions[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

post({ type: 'ready', ok: true });
