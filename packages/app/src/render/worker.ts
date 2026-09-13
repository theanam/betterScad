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
      preview: request.preview,
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
 * Above this angle between neighbouring faces, the edge between them is a
 * crease: the two sides get their own normals instead of being averaged into
 * one. 30° is the usual choice and lands where it should here — a $fn = 48
 * sphere steps 7.5° per ring and stays smooth, a cube's 90° edges stay sharp,
 * and a cylinder's flat cap never blends into its wall.
 */
const CREASE_COS = Math.cos((30 * Math.PI) / 180);

/** Two corner normals close enough to share a vertex rather than split it. */
const SAME_NORMAL_COS = 0.9999;

/**
 * Converts a mesh to a GPU-ready payload with crease-aware vertex normals.
 *
 * Averaging every adjacent face into a shared vertex is what makes a cube shade
 * like a ball: its eight vertices are shared by three faces each, so every
 * corner normal comes out along the body diagonal and the GPU interpolates that
 * across faces that are actually flat. Manifold emits exactly that topology —
 * `cube(20)` is 8 vertices and 12 triangles — so the preview has to reconstruct
 * the hard edges rather than assume they survived.
 *
 * Faces are only averaged together when they meet at less than `CREASE_COS`;
 * across a crease the vertex is duplicated so each side keeps its own normal.
 * Vertices that need no split keep their original index, which matters because
 * de-indexing wholesale would triple the buffers for smooth meshes — the ones
 * that are already the largest.
 *
 * Computed in the worker rather than the viewport because the worker already
 * owns the data, and the split has to happen before the buffers are transferred.
 */
function toPayload(
  mesh: { positions: Float32Array; triangles: Uint32Array },
  color: [number, number, number, number],
  display: MeshPayload['display'],
  transfer: Transferable[],
): MeshPayload {
  const { positions, triangles } = mesh;
  const vertexCount = positions.length / 3;
  const faceCount = triangles.length / 3;

  // --- per-face normals ---------------------------------------------------
  // Area-weighted for averaging (the un-normalised cross product is already
  // proportional to area, which beats averaging unit normals on irregular
  // meshes), and unit for comparing angles.
  const faceWeighted = new Float32Array(faceCount * 3);
  const faceUnit = new Float32Array(faceCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const ia = triangles[f * 3] * 3;
    const ib = triangles[f * 3 + 1] * 3;
    const ic = triangles[f * 3 + 2] * 3;

    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    faceWeighted[f * 3] = nx;
    faceWeighted[f * 3 + 1] = ny;
    faceWeighted[f * 3 + 2] = nz;

    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      faceUnit[f * 3] = nx / length;
      faceUnit[f * 3 + 1] = ny / length;
      faceUnit[f * 3 + 2] = nz / length;
    } else {
      // A degenerate triangle has no direction to contribute; leaving it zero
      // keeps it out of every average rather than poisoning its neighbours.
      faceUnit[f * 3 + 2] = 0;
    }
  }

  // --- which faces touch each vertex, as a compressed adjacency list -------
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < triangles.length; i++) offsets[triangles[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];

  const adjacency = new Uint32Array(triangles.length);
  const cursor = offsets.slice(0, vertexCount);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) adjacency[cursor[triangles[f * 3 + k]]++] = f;
  }

  // --- corner normals, splitting vertices across creases -------------------
  const normals = new Float32Array(positions.length);
  const written = new Uint8Array(vertexCount);
  const indices = new Uint32Array(triangles.length);

  // Only the vertices that actually split allocate anything, so a smooth mesh
  // pays nothing for this.
  const splits = new Map<number, number[]>();
  const extraPositions: number[] = [];
  const extraNormals: number[] = [];
  let nextIndex = vertexCount;

  for (let f = 0; f < faceCount; f++) {
    const fx = faceUnit[f * 3];
    const fy = faceUnit[f * 3 + 1];
    const fz = faceUnit[f * 3 + 2];

    for (let k = 0; k < 3; k++) {
      const v = triangles[f * 3 + k];

      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let j = offsets[v]; j < offsets[v + 1]; j++) {
        const g = adjacency[j];
        const dot = fx * faceUnit[g * 3] + fy * faceUnit[g * 3 + 1] + fz * faceUnit[g * 3 + 2];
        if (dot < CREASE_COS) continue;
        nx += faceWeighted[g * 3];
        ny += faceWeighted[g * 3 + 1];
        nz += faceWeighted[g * 3 + 2];
      }

      const length = Math.hypot(nx, ny, nz);
      if (length > 0) {
        nx /= length;
        ny /= length;
        nz /= length;
      } else {
        nx = fx;
        ny = fy;
        nz = fz;
      }

      indices[f * 3 + k] = placeCorner(v, nx, ny, nz);
    }
  }

  /** Reuses the vertex when the normal matches, and splits it when it does not. */
  function placeCorner(v: number, nx: number, ny: number, nz: number): number {
    if (!written[v]) {
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      written[v] = 1;
      return v;
    }
    if (normals[v * 3] * nx + normals[v * 3 + 1] * ny + normals[v * 3 + 2] * nz >= SAME_NORMAL_COS) {
      return v;
    }

    const existing = splits.get(v);
    if (existing) {
      for (const index of existing) {
        const at = (index - vertexCount) * 3;
        if (extraNormals[at] * nx + extraNormals[at + 1] * ny + extraNormals[at + 2] * nz >= SAME_NORMAL_COS) {
          return index;
        }
      }
    }

    const index = nextIndex++;
    extraPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    extraNormals.push(nx, ny, nz);
    if (existing) existing.push(index);
    else splits.set(v, [index]);
    return index;
  }

  // --- assemble -----------------------------------------------------------
  let outPositions = positions;
  let outNormals = normals;
  if (extraPositions.length > 0) {
    outPositions = new Float32Array(positions.length + extraPositions.length);
    outPositions.set(positions);
    outPositions.set(extraPositions, positions.length);

    outNormals = new Float32Array(normals.length + extraNormals.length);
    outNormals.set(normals);
    outNormals.set(extraNormals, normals.length);
  }

  const payload: MeshPayload = {
    positions: outPositions,
    normals: outNormals,
    indices,
    color,
    display,
  };
  transfer.push(outPositions.buffer, outNormals.buffer, indices.buffer);
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
