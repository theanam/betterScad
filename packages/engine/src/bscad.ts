/**
 * The native `.bscad` file format (spec feature 22).
 *
 * A `.bscad` file *is* a `.scad` file. Metadata — panel layout, saved
 * Customizer presets, viewport state — lives in a leading block comment, so the
 * same bytes open unmodified in stock OpenSCAD. That makes the native format
 * its own downgrade path, in the spirit of spec feature 21.
 */

export const BSCAD_MAGIC = 'BetterSCAD';
export const BSCAD_FORMAT_VERSION = 1;

export interface BscadMetadata {
  version: number;
  /** Free-form layout state owned by the app (panel sizes, active tab, …). */
  layout?: Record<string, unknown>;
  /** Named Customizer presets: preset name -> parameter name -> value. */
  presets?: Record<string, Record<string, unknown>>;
  /** Which preset was last active. */
  activePreset?: string;
  camera?: { rotation?: [number, number, number]; target?: [number, number, number]; distance?: number };
  /** Anything a future version adds is preserved on round-trip. */
  [key: string]: unknown;
}

export interface BscadFile {
  /** The OpenSCAD source, with the metadata comment removed. */
  source: string;
  metadata: BscadMetadata;
  /** False when the input carried no metadata block (i.e. a plain `.scad`). */
  hadMetadata: boolean;
}

const HEADER_PATTERN = /^\s*\/\*\s*BetterSCAD\s*\r?\n([\s\S]*?)\r?\n\s*\*\/\s*\r?\n?/;

/**
 * Reads a `.bscad` (or plain `.scad`) file.
 *
 * Malformed metadata is a warning condition, not a failure: the source is far
 * more valuable than the panel layout, so a corrupt header degrades to
 * defaults rather than refusing to open the file.
 */
export function parseBscad(text: string): BscadFile {
  const match = HEADER_PATTERN.exec(text);
  if (!match) {
    return { source: text, metadata: { version: BSCAD_FORMAT_VERSION }, hadMetadata: false };
  }

  let metadata: BscadMetadata = { version: BSCAD_FORMAT_VERSION };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = { version: BSCAD_FORMAT_VERSION, ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Keep the defaults; the source below is still perfectly good.
  }

  return { source: text.slice(match[0].length), metadata, hadMetadata: true };
}

export function serializeBscad(source: string, metadata: BscadMetadata): string {
  const payload = JSON.stringify({ ...metadata, version: BSCAD_FORMAT_VERSION }, null, 2);
  return `/* ${BSCAD_MAGIC}\n${payload}\n*/\n${source}`;
}

/** Strips metadata to produce a plain `.scad` file. */
export function toLegacyScadSource(text: string): string {
  return parseBscad(text).source;
}

/** True when the text carries a BetterSCAD metadata header. */
export function hasBscadMetadata(text: string): boolean {
  return HEADER_PATTERN.test(text);
}
