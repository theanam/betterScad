/**
 * A plain indexed triangle mesh — the interchange format between the kernel,
 * the importers/exporters and the viewport.
 *
 * Deliberately free of any Manifold types so that hosts can consume engine
 * output without loading the WASM (spec feature 3: clean, embeddable API).
 */

export interface TriMesh {
  /** Interleaved xyz, length `3 * vertexCount`. */
  positions: Float32Array;
  /** Triangle corner indices, CCW seen from outside, length `3 * triangleCount`. */
  triangles: Uint32Array;
}

export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function vertexCount(mesh: TriMesh): number {
  return mesh.positions.length / 3;
}

export function triangleCount(mesh: TriMesh): number {
  return mesh.triangles.length / 3;
}

export function emptyMesh(): TriMesh {
  return { positions: new Float32Array(0), triangles: new Uint32Array(0) };
}

export function bounds(mesh: TriMesh): MeshBounds {
  if (mesh.positions.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = mesh.positions[i + axis];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  return { min, max };
}

export function mergeMeshes(meshes: TriMesh[]): TriMesh {
  const totalVerts = meshes.reduce((n, m) => n + m.positions.length, 0);
  const totalTris = meshes.reduce((n, m) => n + m.triangles.length, 0);
  const positions = new Float32Array(totalVerts);
  const triangles = new Uint32Array(totalTris);
  let vOffset = 0;
  let tOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vOffset);
    const base = vOffset / 3;
    for (let i = 0; i < mesh.triangles.length; i++) {
      triangles[tOffset + i] = mesh.triangles[i] + base;
    }
    vOffset += mesh.positions.length;
    tOffset += mesh.triangles.length;
  }
  return { positions, triangles };
}

/** Per-triangle geometric normal, unnormalised length equal to twice the area. */
export function faceNormal(
  mesh: TriMesh,
  tri: number,
): [number, number, number] {
  const [ia, ib, ic] = [mesh.triangles[tri * 3], mesh.triangles[tri * 3 + 1], mesh.triangles[tri * 3 + 2]];
  const ax = mesh.positions[ia * 3];
  const ay = mesh.positions[ia * 3 + 1];
  const az = mesh.positions[ia * 3 + 2];
  const bx = mesh.positions[ib * 3] - ax;
  const by = mesh.positions[ib * 3 + 1] - ay;
  const bz = mesh.positions[ib * 3 + 2] - az;
  const cx = mesh.positions[ic * 3] - ax;
  const cy = mesh.positions[ic * 3 + 1] - ay;
  const cz = mesh.positions[ic * 3 + 2] - az;
  return [by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx];
}

/**
 * Removes vertices no triangle references and welds exact duplicates.
 *
 * Importers routinely produce per-triangle vertices (STL always does); the
 * boolean kernel needs shared vertices to recognise a closed surface.
 */
export function weldVertices(mesh: TriMesh, epsilon = 1e-7): TriMesh {
  const quantum = epsilon > 0 ? 1 / epsilon : 1e7;
  const map = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(vertexCount(mesh));

  for (let v = 0; v < remap.length; v++) {
    const x = mesh.positions[v * 3];
    const y = mesh.positions[v * 3 + 1];
    const z = mesh.positions[v * 3 + 2];
    const key = `${Math.round(x * quantum)},${Math.round(y * quantum)},${Math.round(z * quantum)}`;
    let index = map.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      positions.push(x, y, z);
      map.set(key, index);
    }
    remap[v] = index;
  }

  const triangles: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = remap[mesh.triangles[t]];
    const b = remap[mesh.triangles[t + 1]];
    const c = remap[mesh.triangles[t + 2]];
    // Welding can collapse a sliver into a degenerate triangle; drop those.
    if (a === b || b === c || a === c) continue;
    triangles.push(a, b, c);
  }

  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}
