/**
 * 3D export: STL (binary + ASCII), OFF, AMF and 3MF (spec feature 10).
 *
 * Each writer takes plain `TriMesh` data, so exporting never touches the WASM
 * kernel and can run anywhere the engine does.
 */

import { TriMesh, faceNormal, mergeMeshes, triangleCount } from '../../geom/mesh.js';

export interface ExportPart {
  mesh: TriMesh;
  /** RGBA in 0..1; written where the format supports colour. */
  color?: [number, number, number, number];
  name?: string;
}

export interface ExportOptions {
  /** Written into formats that carry provenance metadata. */
  generator?: string;
  /** Unit name for 3MF/AMF. OpenSCAD models are conventionally millimetres. */
  unit?: 'millimeter' | 'micron' | 'centimeter' | 'inch' | 'foot' | 'meter';
}

const DEFAULT_GENERATOR = 'BetterSCAD';

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

export function exportBinarySTL(parts: ExportPart[], options: ExportOptions = {}): Uint8Array {
  const mesh = mergeMeshes(parts.map((p) => p.mesh));
  const total = triangleCount(mesh);
  const buffer = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const header = `${options.generator ?? DEFAULT_GENERATOR} binary STL`;
  for (let i = 0; i < Math.min(header.length, 79); i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, total, true);

  let offset = 84;
  for (let t = 0; t < total; t++) {
    const [nx, ny, nz] = normalized(faceNormal(mesh, t));
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.triangles[t * 3 + corner];
      view.setFloat32(offset, mesh.positions[v * 3], true);
      view.setFloat32(offset + 4, mesh.positions[v * 3 + 1], true);
      view.setFloat32(offset + 8, mesh.positions[v * 3 + 2], true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }
  return bytes;
}

export function exportAsciiSTL(parts: ExportPart[], options: ExportOptions = {}): string {
  const mesh = mergeMeshes(parts.map((p) => p.mesh));
  const name = options.generator ?? DEFAULT_GENERATOR;
  const lines: string[] = [`solid ${name}`];

  for (let t = 0; t < triangleCount(mesh); t++) {
    const [nx, ny, nz] = normalized(faceNormal(mesh, t));
    lines.push(`  facet normal ${f(nx)} ${f(ny)} ${f(nz)}`, '    outer loop');
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.triangles[t * 3 + corner];
      lines.push(
        `      vertex ${f(mesh.positions[v * 3])} ${f(mesh.positions[v * 3 + 1])} ${f(mesh.positions[v * 3 + 2])}`,
      );
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OFF
// ---------------------------------------------------------------------------

export function exportOFF(parts: ExportPart[]): string {
  const mesh = mergeMeshes(parts.map((p) => p.mesh));
  const vertexTotal = mesh.positions.length / 3;
  const faceTotal = triangleCount(mesh);

  const lines: string[] = ['OFF', `${vertexTotal} ${faceTotal} 0`];
  for (let v = 0; v < vertexTotal; v++) {
    lines.push(`${f(mesh.positions[v * 3])} ${f(mesh.positions[v * 3 + 1])} ${f(mesh.positions[v * 3 + 2])}`);
  }
  for (let t = 0; t < faceTotal; t++) {
    lines.push(`3 ${mesh.triangles[t * 3]} ${mesh.triangles[t * 3 + 1]} ${mesh.triangles[t * 3 + 2]}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// AMF
// ---------------------------------------------------------------------------

/** AMF 1.2 — one `<volume>` per colour group, so colours survive the round trip. */
export function exportAMF(parts: ExportPart[], options: ExportOptions = {}): string {
  const unit = options.unit ?? 'millimeter';
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<amf unit="${unit}" version="1.1">`,
    `  <metadata type="cad">${escapeXml(options.generator ?? DEFAULT_GENERATOR)}</metadata>`,
  ];

  parts.forEach((part, index) => {
    if (part.color) {
      out.push(
        `  <material id="${index + 1}">`,
        `    <color><r>${f(part.color[0])}</r><g>${f(part.color[1])}</g><b>${f(part.color[2])}</b><a>${f(part.color[3])}</a></color>`,
        '  </material>',
      );
    }
  });

  out.push('  <object id="1">', '    <mesh>', '      <vertices>');

  // AMF indexes vertices per object, so parts are concatenated with an offset.
  let offset = 0;
  const offsets: number[] = [];
  for (const part of parts) {
    offsets.push(offset);
    const count = part.mesh.positions.length / 3;
    for (let v = 0; v < count; v++) {
      out.push(
        '        <vertex><coordinates>' +
          `<x>${f(part.mesh.positions[v * 3])}</x>` +
          `<y>${f(part.mesh.positions[v * 3 + 1])}</y>` +
          `<z>${f(part.mesh.positions[v * 3 + 2])}</z>` +
          '</coordinates></vertex>',
      );
    }
    offset += count;
  }
  out.push('      </vertices>');

  parts.forEach((part, index) => {
    const materialAttr = part.color ? ` materialid="${index + 1}"` : '';
    out.push(`      <volume${materialAttr}>`);
    if (part.name) out.push(`        <metadata type="name">${escapeXml(part.name)}</metadata>`);
    const base = offsets[index];
    for (let t = 0; t < triangleCount(part.mesh); t++) {
      out.push(
        '        <triangle>' +
          `<v1>${part.mesh.triangles[t * 3] + base}</v1>` +
          `<v2>${part.mesh.triangles[t * 3 + 1] + base}</v2>` +
          `<v3>${part.mesh.triangles[t * 3 + 2] + base}</v3>` +
          '</triangle>',
      );
    }
    out.push('      </volume>');
  });

  out.push('    </mesh>', '  </object>', '</amf>', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

/**
 * The 3D model part of a 3MF package.
 *
 * 3MF is a ZIP container; `write3MF` in `zip.ts` wraps this with the content
 * types and relationships parts to produce the actual `.3mf` file.
 */
export function build3MFModel(parts: ExportPart[], options: ExportOptions = {}): string {
  const unit = (options.unit ?? 'millimeter').replace('meter', 'meter');
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">`,
    `  <metadata name="Application">${escapeXml(options.generator ?? DEFAULT_GENERATOR)}</metadata>`,
    '  <resources>',
  ];

  const colored = parts.filter((p) => p.color);
  if (colored.length > 0) {
    out.push('    <m:colorgroup id="1">');
    for (const part of colored) {
      out.push(`      <m:color color="${toHex8(part.color!)}" />`);
    }
    out.push('    </m:colorgroup>');
  }

  parts.forEach((part, index) => {
    const objectId = index + 2; // id 1 is the colour group
    const colorIndex = colored.indexOf(part);
    const propsAttr =
      colorIndex >= 0 ? ` pid="1" pindex="${colorIndex}"` : '';
    out.push(`    <object id="${objectId}" type="model"${propsAttr}>`, '      <mesh>', '        <vertices>');
    const count = part.mesh.positions.length / 3;
    for (let v = 0; v < count; v++) {
      out.push(
        `          <vertex x="${f(part.mesh.positions[v * 3])}" y="${f(part.mesh.positions[v * 3 + 1])}" z="${f(part.mesh.positions[v * 3 + 2])}" />`,
      );
    }
    out.push('        </vertices>', '        <triangles>');
    for (let t = 0; t < triangleCount(part.mesh); t++) {
      out.push(
        `          <triangle v1="${part.mesh.triangles[t * 3]}" v2="${part.mesh.triangles[t * 3 + 1]}" v3="${part.mesh.triangles[t * 3 + 2]}" />`,
      );
    }
    out.push('        </triangles>', '      </mesh>', '    </object>');
  });

  out.push('  </resources>', '  <build>');
  parts.forEach((_, index) => out.push(`    <item objectid="${index + 2}" />`));
  out.push('  </build>', '</model>', '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalized(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]);
  // A degenerate triangle has no meaningful normal; zero is the conventional
  // placeholder and every STL reader tolerates it.
  if (length === 0) return [0, 0, 0];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Compact fixed-precision float, avoiding exponent notation in STL/OFF. */
function f(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return Number.parseFloat(n.toFixed(6)).toString();
}

function toHex8(color: [number, number, number, number]): string {
  const byte = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}${byte(color[3])}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { escapeXml };
