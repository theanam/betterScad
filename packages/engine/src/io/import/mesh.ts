/**
 * Mesh importers: STL (binary and ASCII), OBJ and OFF (spec feature 11).
 *
 * All three are written directly against their published formats. Each returns
 * a `TriMesh` with per-triangle vertices; the caller welds them before handing
 * the result to the boolean kernel.
 */

import { TriMesh, emptyMesh } from '../../geom/mesh.js';

export interface ImportIssue {
  message: string;
}

export interface MeshImportResult {
  mesh: TriMesh;
  issues: ImportIssue[];
}

const decoder = new TextDecoder();

/** Dispatches on the file extension, falling back to content sniffing. */
export function importMesh(data: Uint8Array, filename: string): MeshImportResult {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'stl':
      return importSTL(data);
    case 'obj':
      return importOBJ(decoder.decode(data));
    case 'off':
      return importOFF(decoder.decode(data));
    default:
      if (looksLikeBinarySTL(data)) return importSTL(data);
      {
        const text = decoder.decode(data.subarray(0, Math.min(data.length, 4096)));
        if (/^\s*solid\b/.test(text)) return importSTL(data);
        if (/^\s*OFF\b/.test(text)) return importOFF(decoder.decode(data));
        if (/^\s*(v\s|#|mtllib|o\s|g\s)/m.test(text)) return importOBJ(decoder.decode(data));
      }
      return { mesh: emptyMesh(), issues: [{ message: `Unrecognised mesh format for "${filename}".` }] };
  }
}

/**
 * A binary STL is exactly `84 + 50 * triangleCount` bytes. That size check is
 * far more reliable than looking for the word "solid", which binary files
 * often start with too.
 */
function looksLikeBinarySTL(data: Uint8Array): boolean {
  if (data.length < 84) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(80, true);
  return data.length === 84 + count * 50;
}

export function importSTL(data: Uint8Array): MeshImportResult {
  if (looksLikeBinarySTL(data)) return importBinarySTL(data);
  return importAsciiSTL(decoder.decode(data));
}

function importBinarySTL(data: Uint8Array): MeshImportResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  const triangles = new Uint32Array(count * 3);

  let offset = 84;
  for (let t = 0; t < count; t++) {
    offset += 12; // the per-facet normal is recomputed from winding, not trusted
    for (let corner = 0; corner < 3; corner++) {
      const base = t * 9 + corner * 3;
      positions[base] = view.getFloat32(offset, true);
      positions[base + 1] = view.getFloat32(offset + 4, true);
      positions[base + 2] = view.getFloat32(offset + 8, true);
      offset += 12;
    }
    triangles[t * 3] = t * 3;
    triangles[t * 3 + 1] = t * 3 + 1;
    triangles[t * 3 + 2] = t * 3 + 2;
    offset += 2; // attribute byte count
  }
  return { mesh: { positions, triangles }, issues: [] };
}

function importAsciiSTL(text: string): MeshImportResult {
  const positions: number[] = [];
  const issues: ImportIssue[] = [];
  const vertexPattern = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;

  let match: RegExpExecArray | null;
  while ((match = vertexPattern.exec(text)) !== null) {
    positions.push(Number.parseFloat(match[1]), Number.parseFloat(match[2]), Number.parseFloat(match[3]));
  }
  if (positions.length % 9 !== 0) {
    issues.push({ message: 'ASCII STL has a vertex count that is not a multiple of three; trailing data ignored.' });
  }
  const triCount = Math.floor(positions.length / 9);
  const triangles = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) triangles[i] = i;

  return {
    mesh: { positions: new Float32Array(positions.slice(0, triCount * 9)), triangles },
    issues,
  };
}

export function importOBJ(text: string): MeshImportResult {
  const verts: number[] = [];
  const triangles: number[] = [];
  const issues: ImportIssue[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      verts.push(
        Number.parseFloat(parts[1]) || 0,
        Number.parseFloat(parts[2]) || 0,
        Number.parseFloat(parts[3]) || 0,
      );
    } else if (parts[0] === 'f') {
      // Face entries are `v`, `v/vt`, `v//vn` or `v/vt/vn`; only `v` matters here.
      const indices: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const raw = Number.parseInt(parts[i].split('/')[0], 10);
        if (!Number.isFinite(raw)) continue;
        // OBJ indices are 1-based, and negative values count back from the end.
        indices.push(raw > 0 ? raw - 1 : verts.length / 3 + raw);
      }
      // Fan-triangulate, which is correct for the convex faces OBJ normally holds.
      for (let i = 2; i < indices.length; i++) {
        triangles.push(indices[0], indices[i - 1], indices[i]);
      }
    }
  }

  const vertexTotal = verts.length / 3;
  const valid = triangles.every((i) => i >= 0 && i < vertexTotal);
  if (!valid) {
    issues.push({ message: 'OBJ contains out-of-range face indices; those faces were dropped.' });
    const filtered: number[] = [];
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
      if (a >= 0 && b >= 0 && c >= 0 && a < vertexTotal && b < vertexTotal && c < vertexTotal) {
        filtered.push(a, b, c);
      }
    }
    return {
      mesh: { positions: new Float32Array(verts), triangles: new Uint32Array(filtered) },
      issues,
    };
  }

  return {
    mesh: { positions: new Float32Array(verts), triangles: new Uint32Array(triangles) },
    issues,
  };
}

export function importOFF(text: string): MeshImportResult {
  const issues: ImportIssue[] = [];
  // Strip comments and blank lines before parsing the header counts.
  const tokens = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0);

  if (tokens.length === 0 || !/^(ST|C|N|4|n)*OFF\b/.test(tokens[0])) {
    return { mesh: emptyMesh(), issues: [{ message: 'Not an OFF file.' }] };
  }

  // The counts may share the header line or sit on the next one.
  let cursor = 0;
  let header = tokens[0].replace(/^(ST|C|N|4|n)*OFF\b/, '').trim();
  if (header.length === 0) {
    cursor = 1;
    header = tokens[1] ?? '';
  }
  const [vertexTotal, faceTotal] = header.split(/\s+/).map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(vertexTotal) || !Number.isFinite(faceTotal)) {
    return { mesh: emptyMesh(), issues: [{ message: 'OFF header is missing vertex/face counts.' }] };
  }

  const body = tokens.slice(cursor + 1);
  const positions: number[] = [];
  for (let i = 0; i < vertexTotal && i < body.length; i++) {
    const parts = body[i].split(/\s+/);
    positions.push(
      Number.parseFloat(parts[0]) || 0,
      Number.parseFloat(parts[1]) || 0,
      Number.parseFloat(parts[2]) || 0,
    );
  }

  const triangles: number[] = [];
  for (let f = 0; f < faceTotal; f++) {
    const line = body[vertexTotal + f];
    if (!line) break;
    const parts = line.split(/\s+/).map((n) => Number.parseInt(n, 10));
    const count = parts[0];
    if (!Number.isFinite(count) || count < 3) continue;
    const indices = parts.slice(1, 1 + count);
    for (let i = 2; i < indices.length; i++) {
      triangles.push(indices[0], indices[i - 1], indices[i]);
    }
  }
  if (positions.length / 3 < vertexTotal) {
    issues.push({ message: 'OFF file ended before all declared vertices were read.' });
  }

  return {
    mesh: { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) },
    issues,
  };
}
