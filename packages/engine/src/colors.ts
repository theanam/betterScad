/**
 * Colour parsing for `color()` — CSS named colours, `#rgb`/`#rrggbb[aa]`, and
 * `[r, g, b]` / `[r, g, b, a]` vectors in 0..1.
 */

import { RGBA } from './kernel/geometry.js';
import { Value, asNumber } from './values.js';

/** The CSS/SVG named colours, which OpenSCAD's `color()` accepts verbatim. */
export const CSS_COLORS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
  coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
  darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
  darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
  deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700',
  goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f',
  grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
  lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
  linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
  mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6',
  olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500',
  orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f',
  pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080',
  rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1',
  saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
  seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb',
  slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
  springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080',
  thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee',
  wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
  yellowgreen: '9acd32',
};

export const DEFAULT_COLOR: RGBA = [0.98, 0.6, 0.16, 1];

/**
 * What "vary colours" paints items with, in order.
 *
 * Chosen to tell neighbours apart, so each is far from the one before it. Two
 * hues are missing on purpose: amber, which is the model's own colour and the
 * app's colour for state and action, and cyan, which is the `#` highlight and
 * the measure tool — a varied item must never be mistaken for either.
 */
export const ITEM_COLORS: readonly RGBA[] = [
  [0.79, 0.42, 0.24, 1], // terracotta
  [0.42, 0.5, 0.76, 1], // slate blue
  [0.5, 0.64, 0.42, 1], // sage
  [0.78, 0.38, 0.5, 1], // rose
  [0.54, 0.56, 0.6, 1], // steel
  [0.58, 0.4, 0.66, 1], // plum
  [0.85, 0.81, 0.75, 1], // sand
  [0.25, 0.56, 0.42, 1], // pine
];

/**
 * Resolves a `color()` argument.
 *
 * Returns `undefined` when the value names no colour, so the caller can leave
 * the existing colour in place rather than overwriting it with a guess.
 */
export function parseColor(value: Value, alpha?: number): RGBA | undefined {
  let rgba: RGBA | undefined;

  if (typeof value === 'string') {
    rgba = parseColorString(value);
  } else if (Array.isArray(value)) {
    const channels = value.map((c) => asNumber(c, Number.NaN));
    if (channels.length >= 3 && channels.slice(0, 3).every(Number.isFinite)) {
      rgba = [
        clamp01(channels[0]),
        clamp01(channels[1]),
        clamp01(channels[2]),
        channels.length >= 4 && Number.isFinite(channels[3]) ? clamp01(channels[3]) : 1,
      ];
    }
  }

  if (!rgba) return undefined;
  // An explicit `alpha=` argument always wins over the vector's fourth channel.
  if (alpha !== undefined && Number.isFinite(alpha)) rgba = [rgba[0], rgba[1], rgba[2], clamp01(alpha)];
  return rgba;
}

export function parseColorString(raw: string): RGBA | undefined {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return undefined;

  const named = CSS_COLORS[text];
  if (named) return hexToRgba(named);

  if (text.startsWith('#')) return hexToRgba(text.slice(1));
  return undefined;
}

function hexToRgba(hex: string): RGBA | undefined {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const expand = (c: string): number => Number.parseInt(c + c, 16) / 255;
  const byte = (c: string): number => Number.parseInt(c, 16) / 255;

  if (clean.length === 3) return [expand(clean[0]), expand(clean[1]), expand(clean[2]), 1];
  if (clean.length === 4) {
    return [expand(clean[0]), expand(clean[1]), expand(clean[2]), expand(clean[3])];
  }
  if (clean.length === 6) {
    return [byte(clean.slice(0, 2)), byte(clean.slice(2, 4)), byte(clean.slice(4, 6)), 1];
  }
  if (clean.length === 8) {
    return [
      byte(clean.slice(0, 2)),
      byte(clean.slice(2, 4)),
      byte(clean.slice(4, 6)),
      byte(clean.slice(6, 8)),
    ];
  }
  return undefined;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function rgbaToHex(color: RGBA): string {
  const byte = (c: number): string =>
    Math.round(clamp01(c) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}`;
}
