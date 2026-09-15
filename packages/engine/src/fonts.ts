/**
 * Font handling for `text()` (spec features 2 and 23).
 *
 * The registry is deliberately transport-agnostic: it takes font *bytes*. The
 * app layer decides where those come from — a bundled offline set, the system
 * via the Local Font Access API, or Google Fonts cached in IndexedDB — and the
 * engine stays usable headlessly (spec feature 24).
 */

import opentype from 'opentype.js';

export interface FontFace {
  family: string;
  /** e.g. `Regular`, `Bold`, `Bold Italic`. */
  style: string;
  font: opentype.Font;
}

/** A closed contour in font-relative coordinates, already scaled to the requested size. */
export type Contour = [number, number][];

export interface TextRequest {
  text: string;
  size: number;
  /** OpenSCAD spelling: `Family:style=Bold Italic`. */
  font: string;
  halign: string;
  valign: string;
  spacing: number;
  direction: string;
  /** Curve flattening resolution, derived from `$fn`/`$fa`/`$fs`. */
  segments: number;
}

export interface TextResult {
  contours: Contour[];
  /** Advance width of the whole string, useful for `textmetrics`-style queries. */
  advance: number;
  ascender: number;
  descender: number;
}

/**
 * Builds the `font =` spec for a face, the inverse of `parseFontSpec`.
 *
 * `Regular` is omitted because it is the default; emitting
 * `"Noto Sans:style=Regular"` is correct but noisier than anyone wants to read
 * or type.
 */
export function formatFontSpec(family: string, style?: string): string {
  if (!style || style.trim().toLowerCase() === 'regular') return family;
  return `${family}:style=${style.trim()}`;
}

/** Parses `"Liberation Sans:style=Bold Italic"` into its parts. */
export function parseFontSpec(spec: string): { family: string; style: string } {
  const [familyPart, ...rest] = spec.split(':');
  const family = familyPart.trim();
  let style = '';
  for (const segment of rest) {
    const match = /^\s*style\s*=\s*(.+)$/i.exec(segment);
    if (match) style = match[1].trim();
  }
  return { family, style };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class FontRegistry {
  private readonly faces: FontFace[] = [];
  private defaultFamily = '';

  /**
   * Registers a font from its raw bytes.
   *
   * Returns the parsed face, or `undefined` when the bytes are not a font
   * this build can read — callers surface that as a diagnostic rather than
   * failing the whole render.
   */
  register(data: ArrayBuffer | Uint8Array): FontFace | undefined {
    try {
      const buffer =
        data instanceof Uint8Array
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data;
      const font = opentype.parse(buffer);
      const family = font.names.fontFamily?.en ?? font.names.fullName?.en ?? 'Unknown';
      const style = font.names.fontSubfamily?.en ?? 'Regular';
      const face: FontFace = { family, style, font };
      this.faces.push(face);
      if (!this.defaultFamily) this.defaultFamily = family;
      return face;
    } catch {
      return undefined;
    }
  }

  /** Sets the family used when `text()` is called without a `font=`. */
  setDefaultFamily(family: string): void {
    this.defaultFamily = family;
  }

  get families(): string[] {
    return [...new Set(this.faces.map((f) => f.family))].sort();
  }

  /**
   * Every loaded face as a family/style pair.
   *
   * A UI needs the style to build the `font = "Family:style=Style"` spec that
   * `text()` expects; the family list alone cannot express a Bold face.
   */
  get list(): { family: string; style: string }[] {
    return this.faces
      .map((f) => ({ family: f.family, style: f.style }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.style.localeCompare(b.style));
  }

  stylesFor(family: string): string[] {
    const want = normalize(family);
    return this.faces.filter((f) => normalize(f.family) === want).map((f) => f.style);
  }

  get isEmpty(): boolean {
    return this.faces.length === 0;
  }

  /**
   * Resolves a font spec to a face.
   *
   * Falls back family -> default family -> any registered face, so a script
   * referencing a font the user does not have still renders something rather
   * than silently producing empty geometry.
   */
  resolve(spec: string): FontFace | undefined {
    if (this.faces.length === 0) return undefined;
    const { family, style } = parseFontSpec(spec || this.defaultFamily);
    const wantFamily = normalize(family || this.defaultFamily);
    const wantStyle = normalize(style);

    const inFamily = this.faces.filter((f) => normalize(f.family) === wantFamily);
    const pool = inFamily.length > 0 ? inFamily : this.faces;

    if (wantStyle) {
      const exact = pool.find((f) => normalize(f.style) === wantStyle);
      if (exact) return exact;
      // Tolerate `Bold Italic` vs `BoldItalic` and word-order differences.
      const wanted = new Set(wantStyle.split(' '));
      const loose = pool.find((f) => {
        const have = new Set(normalize(f.style).split(' '));
        return [...wanted].every((w) => have.has(w));
      });
      if (loose) return loose;
    }
    return pool.find((f) => normalize(f.style) === 'regular') ?? pool[0];
  }

  /** Converts a string to closed contours in model space. */
  layout(request: TextRequest): TextResult | undefined {
    const face = this.resolve(request.font);
    if (!face) return undefined;
    return layoutWithFace(face, request);
  }

  /**
   * Advance widths at size 1, one per character.
   *
   * What the legacy export carries, because OpenSCAD cannot measure a glyph.
   * At size 1 so the exported module can scale them, which is what keeps `size`
   * and `spacing` live in the generated file rather than baked into it.
   */
  advances(chars: string[], font = ''): number[] | undefined {
    const face = this.resolve(font);
    if (!face) return undefined;
    const scale = 1 / face.font.unitsPerEm;
    return chars.map((char) => {
      const [glyph] = face.font.stringToGlyphs(char);
      return (glyph?.advanceWidth ?? 0) * scale;
    });
  }

  /**
   * The same string as separate glyphs, for anything that places them
   * individually — text on a curve, and the advance table its export carries.
   */
  glyphs(
    request: TextRequest,
  ): { glyphs: GlyphPlacement[]; ascender: number; descender: number } | undefined {
    const face = this.resolve(request.font);
    if (!face) return undefined;
    const scale = request.size / face.font.unitsPerEm;
    return {
      glyphs: layoutGlyphs(face, request),
      ascender: face.font.ascender * scale,
      descender: face.font.descender * scale,
    };
  }
}

/** One glyph, at its own origin, with the room it takes on the baseline. */
export interface GlyphPlacement {
  /** The character it came from, for the legacy export's advance table. */
  char: string;
  /** Contours with the glyph's own origin at (0, 0) and its baseline at y = 0. */
  contours: Contour[];
  /** Advance width in model units, already scaled by `size` and `spacing`. */
  advance: number;
}

/**
 * The same layout, one glyph at a time and each left at its own origin.
 *
 * Text on a curve has to move every glyph independently, so it needs them
 * apart rather than merged into one run. Nothing is lost by splitting them:
 * this layout applies no kerning, so a glyph's position depends only on the
 * advances before it.
 */
export function layoutGlyphs(face: FontFace, request: TextRequest): GlyphPlacement[] {
  const { font } = face;
  const scale = request.size / font.unitsPerEm;
  const spacing = Number.isFinite(request.spacing) ? request.spacing : 1;

  const glyphs = font.stringToGlyphs(request.text);
  const chars = [...request.text];
  const reversed = request.direction === 'rtl' || request.direction === 'btt';
  const order = reversed ? [...glyphs].reverse() : glyphs;
  const labels = reversed ? [...chars].reverse() : chars;

  return order.map((glyph, index) => ({
    char: labels[index] ?? '',
    contours: flattenPath(glyph.getPath(0, 0, request.size), request.segments),
    advance: (glyph.advanceWidth ?? 0) * scale * spacing,
  }));
}

/**
 * Lays out a string and flattens every glyph outline to polygons.
 *
 * `spacing` scales inter-glyph advance only (not glyph size), matching
 * OpenSCAD. `direction: "rtl"` reverses the run; `ttb`/`btt` stack glyphs
 * vertically using the font's line height.
 */
export function layoutWithFace(face: FontFace, request: TextRequest): TextResult {
  const { font } = face;
  const size = request.size;
  const scale = size / font.unitsPerEm;
  const spacing = Number.isFinite(request.spacing) ? request.spacing : 1;
  const vertical = request.direction === 'ttb' || request.direction === 'btt';

  const glyphs = font.stringToGlyphs(request.text);
  const order =
    request.direction === 'rtl' || request.direction === 'btt' ? [...glyphs].reverse() : glyphs;

  const lineHeight = (font.ascender - font.descender) * scale;
  const contours: Contour[] = [];
  let penX = 0;
  let penY = 0;

  for (const glyph of order) {
    const path = glyph.getPath(penX, penY, size);
    contours.push(...flattenPath(path, request.segments));
    // `penY` is in opentype's Y-down space, so increasing it steps *down* the
    // page once the outline is flipped into model space.
    if (vertical) penY += lineHeight * spacing;
    else penX += (glyph.advanceWidth ?? 0) * scale * spacing;
  }

  const advance = vertical ? 0 : penX;
  const height = vertical ? Math.abs(penY) + lineHeight : lineHeight;
  const ascender = font.ascender * scale;
  const descender = font.descender * scale;

  // Alignment shifts the whole run; OpenSCAD measures from the baseline.
  let dx = 0;
  let dy = 0;
  switch (request.halign) {
    case 'center':
      dx = -advance / 2;
      break;
    case 'right':
      dx = -advance;
      break;
    default:
      dx = 0;
  }
  // Vertical alignment is measured against the font's own ascender/descender
  // band, not the ink of this particular string, so "Ag" and "xx" align
  // identically. `descender` is negative, being below the baseline.
  switch (request.valign) {
    case 'top':
      dy = -ascender;
      break;
    case 'center':
      // The midpoint of the band, which spans descender..ascender. Halving the
      // ascender alone ignores the descent and drops the text by half of it —
      // roughly 15% of the font size for a typical face.
      dy = -(ascender + descender) / 2;
      break;
    case 'bottom':
      dy = -descender;
      break;
    default:
      dy = 0; // baseline
  }
  void height;

  if (dx !== 0 || dy !== 0) {
    for (const contour of contours) {
      for (const point of contour) {
        point[0] += dx;
        point[1] += dy;
      }
    }
  }

  return { contours, advance, ascender, descender };
}

/**
 * Flattens an opentype path (moveTo/lineTo/quadratic/cubic/close) into closed
 * polylines, subdividing each curve into `segments` straight pieces.
 *
 * **Coordinate flip.** opentype.js emits canvas-style coordinates with Y
 * pointing *down* — the cap of an `A` sits at negative Y — while OpenSCAD model
 * space is Y-up, which is also how `font.ascender` / `font.descender` are
 * signed. Y is negated here, at the one place outlines enter the engine, so
 * everything downstream works in a single consistent space.
 *
 * Flipping reverses contour winding, which is harmless: text is assembled with
 * the even-odd fill rule, so only the nesting of contours decides what is a
 * hole, not their direction.
 */
function flattenPath(path: opentype.Path, segments: number): Contour[] {
  const steps = Math.max(2, Math.min(64, Math.round(segments)));
  const contours: Contour[] = [];
  let current: Contour = [];
  // Pen position stays in opentype's own space; only emitted points are flipped.
  let x = 0;
  let y = 0;

  const push = (px: number, py: number): void => {
    const flippedY = -py;
    const last = current[current.length - 1];
    // Drop consecutive duplicates; they make downstream triangulation unhappy.
    if (last && Math.abs(last[0] - px) < 1e-9 && Math.abs(last[1] - flippedY) < 1e-9) return;
    current.push([px, flippedY]);
  };

  const finish = (): void => {
    if (current.length >= 3) contours.push(current);
    current = [];
  };

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        finish();
        x = cmd.x;
        y = cmd.y;
        push(x, y);
        break;
      case 'L':
        x = cmd.x;
        y = cmd.y;
        push(x, y);
        break;
      case 'Q': {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(
            mt * mt * x0 + 2 * mt * t * cmd.x1 + t * t * cmd.x,
            mt * mt * y0 + 2 * mt * t * cmd.y1 + t * t * cmd.y,
          );
        }
        x = cmd.x;
        y = cmd.y;
        break;
      }
      case 'C': {
        const x0 = x;
        const y0 = y;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(
            mt * mt * mt * x0 + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x,
            mt * mt * mt * y0 + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y,
          );
        }
        x = cmd.x;
        y = cmd.y;
        break;
      }
      case 'Z':
        finish();
        break;
    }
  }
  finish();
  return contours;
}
