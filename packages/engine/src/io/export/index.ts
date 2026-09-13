/**
 * Unified export surface (spec feature 10).
 *
 * One entry point that takes a render result and a format, and returns bytes
 * plus the MIME type and a suggested filename extension.
 */

import { BuildResult } from '../../kernel/evaluate.js';
import {
  ExportOptions,
  ExportPart,
  build3MFModel,
  exportAMF,
  exportAsciiSTL,
  exportBinarySTL,
  exportOFF,
} from './mesh3d.js';
import { Vector2DPart, exportDXF, exportSVG } from './vector2d.js';
import { createZip } from './zip.js';

export type ExportFormat = 'stl' | 'stl-ascii' | '3mf' | 'off' | 'amf' | 'svg' | 'dxf';

export interface ExportDescriptor {
  format: ExportFormat;
  label: string;
  extension: string;
  mimeType: string;
  dimension: 2 | 3;
}

export const EXPORT_FORMATS: ExportDescriptor[] = [
  { format: 'stl', label: 'STL (binary)', extension: 'stl', mimeType: 'model/stl', dimension: 3 },
  { format: 'stl-ascii', label: 'STL (ASCII)', extension: 'stl', mimeType: 'model/stl', dimension: 3 },
  { format: '3mf', label: '3MF', extension: '3mf', mimeType: 'model/3mf', dimension: 3 },
  { format: 'off', label: 'OFF', extension: 'off', mimeType: 'text/plain', dimension: 3 },
  { format: 'amf', label: 'AMF', extension: 'amf', mimeType: 'application/octet-stream', dimension: 3 },
  { format: 'svg', label: 'SVG', extension: 'svg', mimeType: 'image/svg+xml', dimension: 2 },
  { format: 'dxf', label: 'DXF', extension: 'dxf', mimeType: 'image/vnd.dxf', dimension: 2 },
];

export interface ExportedFile {
  data: Uint8Array;
  mimeType: string;
  extension: string;
}

const encoder = new TextEncoder();

export class ExportError extends Error {}

export function exportResult(
  result: BuildResult,
  format: ExportFormat,
  options: ExportOptions & { unit?: ExportOptions['unit'] } = {},
): ExportedFile {
  const descriptor = EXPORT_FORMATS.find((d) => d.format === format);
  if (!descriptor) throw new ExportError(`Unknown export format "${format}".`);

  if (descriptor.dimension === 3) {
    const parts: ExportPart[] = result.parts.map((p, i) => ({
      mesh: p.mesh,
      color: p.color,
      name: `part${i + 1}`,
    }));
    if (parts.length === 0) {
      throw new ExportError(
        result.dimension === 2
          ? 'This model is 2D. Export it as SVG or DXF, or wrap it in linear_extrude().'
          : 'Nothing to export: the model produced no geometry.',
      );
    }
    return exportMesh(parts, format, descriptor, options);
  }

  const parts: Vector2DPart[] = result.contours2d.map((c) => ({ contours: c.contours, color: c.color }));
  if (parts.length === 0) {
    throw new ExportError(
      result.dimension === 3
        ? 'This model is 3D. Export it as STL/3MF/OFF/AMF, or use projection() to flatten it.'
        : 'Nothing to export: the model produced no 2D geometry.',
    );
  }
  const text = format === 'svg' ? exportSVG(parts, options) : exportDXF(parts, options);
  return { data: encoder.encode(text), mimeType: descriptor.mimeType, extension: descriptor.extension };
}

function exportMesh(
  parts: ExportPart[],
  format: ExportFormat,
  descriptor: ExportDescriptor,
  options: ExportOptions,
): ExportedFile {
  switch (format) {
    case 'stl':
      return {
        data: exportBinarySTL(parts, options),
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
      };
    case 'stl-ascii':
      return {
        data: encoder.encode(exportAsciiSTL(parts, options)),
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
      };
    case 'off':
      return {
        data: encoder.encode(exportOFF(parts)),
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
      };
    case 'amf':
      return {
        data: encoder.encode(exportAMF(parts, options)),
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
      };
    case '3mf':
      return {
        data: package3MF(parts, options),
        mimeType: descriptor.mimeType,
        extension: descriptor.extension,
      };
    default:
      throw new ExportError(`"${format}" is not a 3D format.`);
  }
}

/** Wraps the 3MF model part in the OPC container the format requires. */
function package3MF(parts: ExportPart[], options: ExportOptions): Uint8Array {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />' +
    '</Types>\n';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />' +
    '</Relationships>\n';

  return createZip([
    { path: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { path: '_rels/.rels', data: encoder.encode(rels) },
    { path: '3D/3dmodel.model', data: encoder.encode(build3MFModel(parts, options)) },
  ]);
}

export {
  build3MFModel,
  createZip,
  exportAMF,
  exportAsciiSTL,
  exportBinarySTL,
  exportDXF,
  exportOFF,
  exportSVG,
};
export type { ExportOptions, ExportPart, Vector2DPart };
