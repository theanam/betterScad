/**
 * The little three-arm axis indicator in the viewport HUD, as OpenSCAD has.
 *
 * It answers a different question from the view cube in the opposite corner.
 * The cube is a control — it names the six standard views and you click it to
 * get there. This names the three axes and nothing else, which is what you want
 * while reading a `translate([0, 12, 0])` and wondering which way the model is
 * about to move.
 *
 * Drawn as an SVG rather than a third pass over the WebGL canvas: it is three
 * lines and three letters, it updates only when the camera does, and keeping it
 * in the DOM means it inherits the HUD's own type and colours.
 */

/** One axis, already projected onto the screen by `OrbitCamera.screenAxes`. */
export interface ScreenAxis {
  label: 'X' | 'Y' | 'Z';
  x: number;
  y: number;
  /** How far the axis leans out of the screen; decides what draws over what. */
  towards: number;
}

/** Box size in CSS pixels. */
const SIZE = 60;

/**
 * The viewBox's half-width.
 *
 * Bigger than the arms so the letters have somewhere to sit *inside* the box.
 * Drawing them outside it and relying on `overflow: visible` works until
 * something clips, and a label that disappears at one camera angle is worse
 * than a slightly smaller one.
 */
const EXTENT = 1.25;

/** Arm length and label distance, in viewBox units. */
const ARM = 1;
const LABEL = 1.12;

/** Thin: these are pointers, not geometry. */
const STROKE = 0.07;

const SVG_NS = 'http://www.w3.org/2000/svg';

const COLORS: Record<ScreenAxis['label'], { token: string; fallback: string }> = {
  X: { token: '--bs-viewport-axis-x', fallback: '#d2453f' },
  Y: { token: '--bs-viewport-axis-y', fallback: '#2f8f5b' },
  Z: { token: '--bs-viewport-axis-z', fallback: '#3b74df' },
};

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export class AxisIndicator {
  readonly element: SVGSVGElement;

  constructor() {
    this.element = document.createElementNS(SVG_NS, 'svg');
    // Origin in the middle, so an axis direction is its own coordinate.
    this.element.setAttribute('viewBox', `${-EXTENT} ${-EXTENT} ${EXTENT * 2} ${EXTENT * 2}`);
    this.element.setAttribute('width', String(SIZE));
    this.element.setAttribute('height', String(SIZE));
    this.element.setAttribute('class', 'axisindicator');
    this.element.setAttribute('aria-hidden', 'true');
  }

  update(axes: ScreenAxis[]): void {
    const parts: SVGElement[] = [];

    // Furthest first, so an arm pointing towards the viewer crosses over one
    // pointing away rather than under it.
    for (const axis of [...axes].sort((a, b) => a.towards - b.towards)) {
      const color = `var(${COLORS[axis.label].token}, ${COLORS[axis.label].fallback})`;

      parts.push(
        svg('line', {
          x1: 0,
          y1: 0,
          x2: round(axis.x * ARM),
          y2: round(axis.y * ARM),
          stroke: color,
          'stroke-width': STROKE,
          'stroke-linecap': 'round',
        }),
      );

      const text = svg('text', {
        x: round(axis.x * LABEL),
        y: round(axis.y * LABEL),
        fill: color,
        'font-size': 0.38,
        'text-anchor': 'middle',
        // `central` rather than `middle`: `middle` centres on the x-height,
        // which sits a letter noticeably low at this size.
        'dominant-baseline': 'central',
      });
      text.textContent = axis.label.toLowerCase();
      parts.push(text);
    }

    this.element.replaceChildren(...parts);
  }
}

/** Two decimals is well past what a 46px box can show, and keeps the DOM small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
