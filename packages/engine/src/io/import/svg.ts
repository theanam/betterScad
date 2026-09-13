/**
 * SVG importer for 2D profiles (spec feature 2: `import()` of SVG).
 *
 * Parsed with a small self-contained scanner rather than DOMParser, so the
 * engine works identically in a worker, in Node for headless rendering
 * (spec feature 24), and in the browser.
 *
 * SVG's Y axis points down and OpenSCAD's points up, so every contour is
 * flipped vertically about the document height, matching OpenSCAD's own
 * import behaviour.
 */

import type { Contour2, Point2 } from './dxf.js';

export interface SvgImportResult {
  contours: Contour2[];
  /** Document size in user units, used for the Y flip and for `center=`. */
  width: number;
  height: number;
  issues: { message: string }[];
}

interface Element {
  name: string;
  attrs: Record<string, string>;
}

const TAG = /<([a-zA-Z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function scanElements(text: string): Element[] {
  const elements: Element[] = [];
  // Comments and CDATA can contain angle brackets that would confuse the scan.
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  let match: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((match = TAG.exec(cleaned)) !== null) {
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    ATTR.lastIndex = 0;
    while ((attrMatch = ATTR.exec(match[2] ?? '')) !== null) {
      attrs[attrMatch[1]] = attrMatch[2] ?? attrMatch[3] ?? '';
    }
    elements.push({ name: match[1], attrs });
  }
  return elements;
}

/** Converts an SVG length (`10`, `10px`, `2cm`, `50%`) to user units. */
function toUserUnits(raw: string | undefined, fallback: number, dpi: number): number {
  if (!raw) return fallback;
  const match = /^\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(raw);
  if (!match) return fallback;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return fallback;
  switch (match[2].toLowerCase()) {
    case '':
    case 'px':
      return value;
    case 'pt':
      return (value * dpi) / 72;
    case 'pc':
      return (value * dpi) / 6;
    case 'in':
      return value * dpi;
    case 'cm':
      return (value * dpi) / 2.54;
    case 'mm':
      return (value * dpi) / 25.4;
    default:
      return fallback;
  }
}

export function importSVG(
  text: string,
  options: { segments?: number; dpi?: number } = {},
): SvgImportResult {
  const steps = Math.max(4, Math.min(128, options.segments ?? 24));
  const dpi = options.dpi ?? 96;
  const elements = scanElements(text);
  const issues: { message: string }[] = [];

  const svg = elements.find((e) => e.name.toLowerCase() === 'svg');
  let width = toUserUnits(svg?.attrs.width, 0, dpi);
  let height = toUserUnits(svg?.attrs.height, 0, dpi);
  const viewBox = svg?.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    if (width === 0) width = viewBox[2];
    if (height === 0) height = viewBox[3];
  }

  const contours: Contour2[] = [];

  for (const element of elements) {
    switch (element.name.toLowerCase()) {
      case 'path': {
        const parsed = parsePathData(element.attrs.d ?? '', steps);
        contours.push(...parsed.contours);
        if (parsed.unsupported.size > 0) {
          issues.push({
            message: `SVG path commands not supported: ${[...parsed.unsupported].join(', ')}.`,
          });
        }
        break;
      }
      case 'rect': {
        const x = Number.parseFloat(element.attrs.x ?? '0') || 0;
        const y = Number.parseFloat(element.attrs.y ?? '0') || 0;
        const w = Number.parseFloat(element.attrs.width ?? '0') || 0;
        const h = Number.parseFloat(element.attrs.height ?? '0') || 0;
        if (w > 0 && h > 0) contours.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
        break;
      }
      case 'circle': {
        const cx = Number.parseFloat(element.attrs.cx ?? '0') || 0;
        const cy = Number.parseFloat(element.attrs.cy ?? '0') || 0;
        const r = Number.parseFloat(element.attrs.r ?? '0') || 0;
        if (r > 0) contours.push(ellipse(cx, cy, r, r, steps));
        break;
      }
      case 'ellipse': {
        const cx = Number.parseFloat(element.attrs.cx ?? '0') || 0;
        const cy = Number.parseFloat(element.attrs.cy ?? '0') || 0;
        const rx = Number.parseFloat(element.attrs.rx ?? '0') || 0;
        const ry = Number.parseFloat(element.attrs.ry ?? '0') || 0;
        if (rx > 0 && ry > 0) contours.push(ellipse(cx, cy, rx, ry, steps));
        break;
      }
      case 'polygon':
      case 'polyline': {
        const points = parsePointList(element.attrs.points ?? '');
        if (points.length >= 3) contours.push(points);
        break;
      }
      default:
        break;
    }
  }

  if (height === 0) {
    // Without a declared height, flip about the content's own extent.
    let maxY = 0;
    for (const contour of contours) for (const p of contour) maxY = Math.max(maxY, p[1]);
    height = maxY;
  }
  if (width === 0) {
    let maxX = 0;
    for (const contour of contours) for (const p of contour) maxX = Math.max(maxX, p[0]);
    width = maxX;
  }

  for (const contour of contours) {
    for (const point of contour) point[1] = height - point[1];
  }

  return { contours, width, height, issues };
}

function ellipse(cx: number, cy: number, rx: number, ry: number, steps: number): Contour2 {
  const contour: Contour2 = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    contour.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return contour;
}

function parsePointList(raw: string): Contour2 {
  const numbers = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const points: Contour2 = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
}

/**
 * Parses an SVG path `d` attribute into closed contours.
 *
 * Supports M/L/H/V/C/S/Q/T/A/Z in both absolute and relative forms — the full
 * set an outline can be drawn with.
 */
export function parsePathData(
  d: string,
  steps: number,
): { contours: Contour2[]; unsupported: Set<string> } {
  const contours: Contour2[] = [];
  const unsupported = new Set<string>();
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [];

  let contour: Contour2 = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Reflected control points for the smooth variants S and T.
  let lastCubicControl: Point2 | undefined;
  let lastQuadControl: Point2 | undefined;
  let command = '';
  let index = 0;

  const nextNumber = (): number => {
    const value = Number.parseFloat(tokens[index++]);
    return Number.isFinite(value) ? value : 0;
  };
  const hasNumber = (): boolean => index < tokens.length && !/[a-zA-Z]/.test(tokens[index]);

  const push = (px: number, py: number): void => {
    const last = contour[contour.length - 1];
    if (last && Math.abs(last[0] - px) < 1e-9 && Math.abs(last[1] - py) < 1e-9) return;
    contour.push([px, py]);
  };

  const finish = (): void => {
    if (contour.length >= 3) contours.push(contour);
    contour = [];
  };

  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++];
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    switch (upper) {
      case 'M': {
        finish();
        const mx = nextNumber();
        const my = nextNumber();
        x = relative ? x + mx : mx;
        y = relative ? y + my : my;
        startX = x;
        startY = y;
        push(x, y);
        // Extra coordinate pairs after an M are implicit L commands.
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const lx = nextNumber();
        const ly = nextNumber();
        x = relative ? x + lx : lx;
        y = relative ? y + ly : ly;
        push(x, y);
        break;
      }
      case 'H': {
        const hx = nextNumber();
        x = relative ? x + hx : hx;
        push(x, y);
        break;
      }
      case 'V': {
        const vy = nextNumber();
        y = relative ? y + vy : vy;
        push(x, y);
        break;
      }
      case 'C':
      case 'S': {
        let c1x: number;
        let c1y: number;
        if (upper === 'C') {
          c1x = relative ? x + nextNumber() : nextNumber();
          c1y = relative ? y + nextNumber() : nextNumber();
        } else {
          // S reflects the previous cubic control point about the current point.
          c1x = lastCubicControl ? 2 * x - lastCubicControl[0] : x;
          c1y = lastCubicControl ? 2 * y - lastCubicControl[1] : y;
        }
        const c2x = relative ? x + nextNumber() : nextNumber();
        const c2y = relative ? y + nextNumber() : nextNumber();
        const ex = relative ? x + nextNumber() : nextNumber();
        const ey = relative ? y + nextNumber() : nextNumber();
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(
            mt * mt * mt * x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
            mt * mt * mt * y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey,
          );
        }
        lastCubicControl = [c2x, c2y];
        lastQuadControl = undefined;
        x = ex;
        y = ey;
        break;
      }
      case 'Q':
      case 'T': {
        let cx: number;
        let cy: number;
        if (upper === 'Q') {
          cx = relative ? x + nextNumber() : nextNumber();
          cy = relative ? y + nextNumber() : nextNumber();
        } else {
          cx = lastQuadControl ? 2 * x - lastQuadControl[0] : x;
          cy = lastQuadControl ? 2 * y - lastQuadControl[1] : y;
        }
        const ex = relative ? x + nextNumber() : nextNumber();
        const ey = relative ? y + nextNumber() : nextNumber();
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(mt * mt * x + 2 * mt * t * cx + t * t * ex, mt * mt * y + 2 * mt * t * cy + t * t * ey);
        }
        lastQuadControl = [cx, cy];
        lastCubicControl = undefined;
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = Math.abs(nextNumber());
        const ry = Math.abs(nextNumber());
        const rotation = nextNumber();
        const largeArc = nextNumber() !== 0;
        const sweep = nextNumber() !== 0;
        const ex = relative ? x + nextNumber() : nextNumber();
        const ey = relative ? y + nextNumber() : nextNumber();
        appendArc(push, x, y, rx, ry, rotation, largeArc, sweep, ex, ey, steps);
        lastCubicControl = undefined;
        lastQuadControl = undefined;
        x = ex;
        y = ey;
        break;
      }
      case 'Z': {
        x = startX;
        y = startY;
        finish();
        break;
      }
      default: {
        unsupported.add(command);
        // Consume the stray numbers so the loop still terminates.
        while (hasNumber()) index++;
        break;
      }
    }
  }

  finish();
  return { contours, unsupported };
}

/** Endpoint-parameterised elliptical arc, per the SVG 1.1 implementation notes. */
function appendArc(
  push: (x: number, y: number) => void,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
  steps: number,
): void {
  if (rx === 0 || ry === 0) {
    push(x2, y2);
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Scale the radii up if they are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = denominator === 0 ? 0 : sign * Math.sqrt(Math.max(0, numerator / denominator));

  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angleOf = (ux: number, uy: number): number => Math.atan2(uy, ux);
  const theta1 = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  let deltaTheta = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry) - theta1;
  if (!sweep && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  if (sweep && deltaTheta < 0) deltaTheta += 2 * Math.PI;

  const count = Math.max(2, Math.ceil((steps * Math.abs(deltaTheta)) / (Math.PI * 2)));
  for (let i = 1; i <= count; i++) {
    const theta = theta1 + (deltaTheta * i) / count;
    const px = cosPhi * rx * Math.cos(theta) - sinPhi * ry * Math.sin(theta) + cx;
    const py = sinPhi * rx * Math.cos(theta) + cosPhi * ry * Math.sin(theta) + cy;
    push(px, py);
  }
}
