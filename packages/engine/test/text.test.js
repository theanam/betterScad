/**
 * text() layout: alignment, metrics and font resolution.
 *
 * Alignment is the part most likely to drift, because it is only wrong by a
 * fraction of the em — enough to look "not quite centred" without looking
 * broken. These tests pin the metric lines rather than the ink, which is what
 * OpenSCAD aligns against.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FontRegistry, formatFontSpec, parseFontSpec } from '../dist/index.js';

const FONT = fileURLToPath(new URL('../../app/public/fonts/NotoSans.ttf', import.meta.url));

function registry() {
  const fonts = new FontRegistry();
  const face = fonts.register(readFileSync(FONT));
  assert.ok(face, 'the bundled test font should parse');
  return fonts;
}

function layout(fonts, overrides = {}) {
  const result = fonts.layout({
    text: 'Ag',
    size: 10,
    font: 'Noto Sans',
    halign: 'left',
    valign: 'baseline',
    spacing: 1,
    direction: 'ltr',
    segments: 8,
    ...overrides,
  });
  assert.ok(result, 'layout should resolve a font');
  return result;
}

function inkBounds(result) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of result.contours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Where the font's ascender and descender lines end up after alignment.
 *
 * Derived by measuring how far the ink moved relative to the baseline layout,
 * since alignment shifts the whole run rigidly.
 */
function metricLines(fonts, valign) {
  const base = layout(fonts, { valign: 'baseline' });
  const aligned = layout(fonts, { valign });
  const shift = inkBounds(aligned).minY - inkBounds(base).minY;
  return { top: base.ascender + shift, bottom: base.descender + shift };
}

const CLOSE = 1e-9;

// ---------------------------------------------------------------------------

test('font metrics have the expected signs', () => {
  const result = layout(registry());
  assert.ok(result.ascender > 0, 'ascender is above the baseline');
  assert.ok(result.descender < 0, 'descender is below the baseline');
});

test('glyph outlines are Y-up, matching model space', () => {
  // opentype.js emits canvas-style Y-down coordinates. If that flip is ever
  // dropped, text renders upside down — and every purely symmetric test still
  // passes, so this asserts orientation directly.
  const fonts = registry();

  // `A` has ink only above the baseline.
  const cap = inkBounds(layout(fonts, { text: 'A', valign: 'baseline' }));
  assert.ok(cap.minY >= -CLOSE, `"A" must not descend below the baseline, got ${cap.minY}`);
  assert.ok(cap.maxY > 0, '"A" must rise above the baseline');

  // `g` descends below it.
  const descending = inkBounds(layout(fonts, { text: 'g', valign: 'baseline' }));
  assert.ok(descending.minY < 0, `"g" must descend below the baseline, got ${descending.minY}`);
  assert.ok(descending.maxY > 0, '"g" must also rise above it');

  // And the cap of `A` reaches higher than the x-height of `x`.
  const xHeight = inkBounds(layout(fonts, { text: 'x', valign: 'baseline' }));
  assert.ok(cap.maxY > xHeight.maxY, 'cap height should exceed x-height');
});

test('text reads left to right', () => {
  // A second glyph must be placed to the right of the first, not the left.
  const fonts = registry();
  const single = inkBounds(layout(fonts, { text: 'i' }));
  const pair = inkBounds(layout(fonts, { text: 'ii' }));
  assert.ok(pair.maxX > single.maxX, 'the run should extend rightwards');
  assert.ok(Math.abs(pair.minX - single.minX) < 1, 'and start at the same place');
});

test('valign = "center" centres the ascender/descender band on the origin', () => {
  // The regression this file exists for: halving the ascender alone ignores
  // the descent and drops the text by half of it, ~15% of the font size.
  const { top, bottom } = metricLines(registry(), 'center');
  assert.ok(
    Math.abs((top + bottom) / 2) < CLOSE,
    `band midpoint should be 0, got ${(top + bottom) / 2}`,
  );
  assert.ok(Math.abs(top + bottom) < CLOSE, 'the band should be symmetric about the origin');
});

test('valign = "top" puts the ascender line on the origin', () => {
  const { top } = metricLines(registry(), 'top');
  assert.ok(Math.abs(top) < CLOSE, `ascender line should be 0, got ${top}`);
});

test('valign = "bottom" puts the descender line on the origin', () => {
  const { bottom } = metricLines(registry(), 'bottom');
  assert.ok(Math.abs(bottom) < CLOSE, `descender line should be 0, got ${bottom}`);
});

test('valign = "baseline" is the default and leaves the run unmoved', () => {
  const fonts = registry();
  const baseline = inkBounds(layout(fonts, { valign: 'baseline' }));
  const unspecified = inkBounds(layout(fonts, { valign: 'nonsense' }));
  assert.ok(Math.abs(baseline.minY - unspecified.minY) < CLOSE);
  // Ink of "Ag" straddles the baseline: the g descends below y = 0, the A rises.
  assert.ok(baseline.minY < 0, 'the g should descend below the baseline');
  assert.ok(baseline.maxY > 0, 'the A should rise above it');
});

test('vertical alignment uses font metrics, not the ink of the string', () => {
  // "xx" has no ascender or descender ink, but must align exactly like "Ag".
  const fonts = registry();
  const tall = layout(fonts, { text: 'Ag', valign: 'center' });
  const short = layout(fonts, { text: 'xx', valign: 'center' });

  const shiftOf = (text, valign) =>
    inkBounds(layout(fonts, { text, valign })).minY -
    inkBounds(layout(fonts, { text, valign: 'baseline' })).minY;

  assert.ok(
    Math.abs(shiftOf('Ag', 'center') - shiftOf('xx', 'center')) < CLOSE,
    'strings with different ink must receive the same vertical shift',
  );
  assert.ok(tall.ascender === short.ascender);
});

test('halign shifts by the advance width', () => {
  const fonts = registry();
  const left = layout(fonts, { halign: 'left' });
  const centered = layout(fonts, { halign: 'center' });
  const right = layout(fonts, { halign: 'right' });

  const shift = (a, b) => inkBounds(b).minX - inkBounds(a).minX;
  assert.ok(Math.abs(shift(left, centered) + left.advance / 2) < CLOSE);
  assert.ok(Math.abs(shift(left, right) + left.advance) < CLOSE);
  assert.ok(left.advance > 0);
});

test('spacing scales advance without scaling the glyphs', () => {
  const fonts = registry();
  const normal = layout(fonts, { text: 'AAA', spacing: 1 });
  const wide = layout(fonts, { text: 'AAA', spacing: 2 });

  assert.ok(wide.advance > normal.advance, 'wider spacing advances further');
  // The first glyph is drawn at the pen origin either way, so its height —
  // which spacing must not touch — is identical.
  assert.ok(Math.abs(inkBounds(wide).maxY - inkBounds(normal).maxY) < CLOSE);
});

test('an unknown family falls back instead of rendering nothing', () => {
  const fonts = registry();
  const result = fonts.layout({
    text: 'Ag',
    size: 10,
    font: 'Definitely Not Installed:style=Bold',
    halign: 'left',
    valign: 'baseline',
    spacing: 1,
    direction: 'ltr',
    segments: 8,
  });
  assert.ok(result && result.contours.length > 0, 'should fall back to a loaded face');
});

test('font specs round-trip between formatting and parsing', () => {
  // `formatFontSpec` is what the font picker shows and inserts, so it has to
  // produce exactly what `text(font = …)` parses back.
  const cases = [
    ['Noto Sans', 'Regular', 'Noto Sans'],
    ['Noto Sans', undefined, 'Noto Sans'],
    ['Noto Sans', 'Bold', 'Noto Sans:style=Bold'],
    ['Playfair Display', 'Bold Italic', 'Playfair Display:style=Bold Italic'],
  ];

  for (const [family, style, expected] of cases) {
    const spec = formatFontSpec(family, style);
    assert.equal(spec, expected);
    assert.equal(parseFontSpec(spec).family, family);
  }

  // Regular is dropped because it is the default, not because it is ignored.
  assert.equal(parseFontSpec(formatFontSpec('Noto Sans', 'Regular')).style, '');
  assert.equal(parseFontSpec(formatFontSpec('Noto Sans', 'Bold')).style, 'Bold');
});

test('the registry lists faces with their styles', () => {
  const fonts = registry();
  const faces = fonts.list;
  assert.ok(faces.length > 0);
  for (const face of faces) {
    assert.equal(typeof face.family, 'string');
    assert.equal(typeof face.style, 'string');
    assert.ok(face.family.length > 0 && face.style.length > 0);
  }
  // A spec built from any listed face must resolve back to that same face.
  const [first] = faces;
  const resolved = fonts.resolve(formatFontSpec(first.family, first.style));
  assert.ok(resolved && resolved.family === first.family);
});
