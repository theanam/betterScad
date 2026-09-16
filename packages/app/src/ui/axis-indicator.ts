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
const SIZE = 74;

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

/**
 * The arrow head, in viewBox units, where one unit is the full arm.
 *
 * Deliberately small: this is a legend, not a manipulator, and at 74px a head
 * big enough to be a handle turns three thin axes into three darts. These come
 * out at roughly 6x4 CSS pixels.
 *
 * In viewBox units rather than pixels — unlike `STROKE` — because a head is
 * geometry rather than weight. If the box is ever resized the arms and their
 * heads should scale together; a head pinned to pixels would swell relative to
 * the arm it sits on.
 */
const HEAD_LENGTH = 0.2;
const HEAD_WIDTH = 0.14;

/**
 * Below this projected arm length, the head is dropped.
 *
 * An axis pointing at or away from the camera projects to nearly nothing, and
 * its direction becomes noise — normalising a near-zero vector would spin the
 * head randomly as the camera creeps past dead-on. Worse, a head is a fixed
 * length, so on an arm shorter than one it would reach back past the origin and
 * point the wrong way. Under this threshold the arm is a stub a few pixels long
 * and the letter beside it is doing the work anyway.
 */
const MIN_ARM_FOR_HEAD = HEAD_LENGTH * 1.5;

/**
 * One CSS pixel, the same weight the viewport draws its own axis lines at.
 *
 * In pixels rather than viewBox units, via `non-scaling-stroke`: a width in
 * user units would scale with `SIZE`, so resizing the indicator would quietly
 * re-weight it and it would stop matching the lines in the scene.
 */
const STROKE = 1;

/** How far the arm runs under its head, to hide the join. */
const STROKE_OVERLAP = 0.02;

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

      // The projected arm. Shorter than `ARM` when the axis leans out of the
      // screen, which is what makes the indicator read as three dimensions.
      const tipX = axis.x * ARM;
      const tipY = axis.y * ARM;
      const armLength = Math.hypot(tipX, tipY);
      const head = armLength >= MIN_ARM_FOR_HEAD;

      // With a head, the line stops at its base rather than running to the tip:
      // the round linecap would otherwise bulge past the apex and blunt the
      // point. The overlap closes the anti-aliasing seam between the two.
      let endX = tipX;
      let endY = tipY;
      if (head) {
        const ux = tipX / armLength;
        const uy = tipY / armLength;
        const baseX = tipX - ux * HEAD_LENGTH;
        const baseY = tipY - uy * HEAD_LENGTH;
        endX = baseX + ux * STROKE_OVERLAP;
        endY = baseY + uy * STROKE_OVERLAP;

        // Perpendicular to the arm, so the head leans with the axis.
        const px = -uy * (HEAD_WIDTH / 2);
        const py = ux * (HEAD_WIDTH / 2);

        parts.push(
          svg('polygon', {
            points:
              `${round(tipX)},${round(tipY)} ` +
              `${round(baseX + px)},${round(baseY + py)} ` +
              `${round(baseX - px)},${round(baseY - py)}`,
            fill: color,
          }),
        );
      }

      parts.push(
        svg('line', {
          x1: 0,
          y1: 0,
          x2: round(endX),
          y2: round(endY),
          stroke: color,
          'stroke-width': STROKE,
          'vector-effect': 'non-scaling-stroke',
          'stroke-linecap': 'round',
        }),
      );

      const text = svg('text', {
        x: round(axis.x * LABEL),
        y: round(axis.y * LABEL),
        fill: color,
        'font-size': 0.34,
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
