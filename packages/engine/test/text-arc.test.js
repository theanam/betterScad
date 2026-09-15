/**
 * `text(radius = …)` — a run laid on a circle instead of a straight baseline.
 *
 * Two things are worth pinning. That the placement is right: proportionally
 * spaced, upright, and honouring `halign` around the start angle. And that the
 * legacy export lands in the same place — which is the harder half, because
 * OpenSCAD cannot measure a glyph, so the widths have to be carried into the
 * generated file and used there.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';

import { Engine, FontRegistry, toStockScad } from '../dist/index.js';

const FONT = fileURLToPath(new URL('../../app/public/fonts/NotoSans.ttf', import.meta.url));

let engine;
let fonts;
before(async () => {
  fonts = new FontRegistry();
  const face = fonts.register(readFileSync(FONT));
  assert.ok(face, 'the bundled test font should parse');
  engine = await Engine.create({ fonts });
});

async function measure(source) {
  const result = await engine.render(source, { preview: false });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const shape of result.geometry.contours2d ?? []) {
    for (const contour of shape.contours) {
      for (const [x, y] of contour) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { bounds: [minX, minY, maxX, maxY], area: result.geometry.stats.area };
}

/**
 * The export lands where the engine does.
 *
 * To a relative tolerance rather than bit for bit: the generated module reaches
 * the same placement by a different route — its per-glyph `text(halign =
 * "center")` measures the advance itself, in a different multiplication order —
 * and floating-point multiplication does not associate. The residue below is
 * nanometres on a part measured in millimetres.
 */
async function exportMatches(source) {
  const legacy = toStockScad(source, 'arc.scad', { fonts });
  assert.deepEqual(legacy.errors, [], `export failed for:\n${source}`);
  assert.equal(legacy.verbatim, false, `${source} should have been rewritten`);

  const original = await measure(source);
  const exported = await measure(legacy.source);

  const relative = Math.abs(original.area - exported.area) / Math.max(1, original.area);
  assert.ok(relative < 1e-6, `${source}: area ${original.area} vs ${exported.area}`);
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(original.bounds[i] - exported.bounds[i]) < 1e-6,
      `${source}: bounds ${original.bounds} vs ${exported.bounds}`,
    );
  }
}

test('the run follows the circle instead of a straight baseline', async () => {
  const straight = await measure('text("BETTERSCAD", size = 5, $fn = 32);');
  const arced = await measure('text("BETTERSCAD", size = 5, radius = 20, $fn = 32);');
  // Same letters, so nearly the same ink.
  assert.ok(Math.abs(straight.area - arced.area) / straight.area < 0.02, 'the ink should survive');

  // Every point sits in the band between the baseline circle and the cap line,
  // which is what "on the circle" means and what a bounding box cannot say.
  const result = await engine.render('text("BETTERSCAD", size = 5, radius = 20, $fn = 32);', {
    preview: false,
  });
  for (const shape of result.geometry.contours2d) {
    for (const contour of shape.contours) {
      for (const [x, y] of contour) {
        const r = Math.hypot(x, y);
        assert.ok(r > 19.9 && r < 26, `point at radius ${r} is not on the run`);
      }
    }
  }
});

test('halign measures around the start angle', async () => {
  // Centred on 12 o'clock, so the run straddles x = 0. Only roughly symmetric:
  // it is centred by arc length, and a letter's ink is not centred in its own
  // advance — an F has nothing on its right-hand side.
  const centred = await measure('text("ABCDEF", size = 5, radius = 20, halign = "center", $fn = 32);');
  assert.ok(centred.bounds[0] < -6 && centred.bounds[2] > 6, `got ${centred.bounds}`);

  // Left starts at the angle and runs one way; right ends there.
  const left = await measure('text("ABCDEF", size = 5, radius = 20, $fn = 32);');
  const right = await measure('text("ABCDEF", size = 5, radius = 20, halign = "right", $fn = 32);');
  assert.ok(left.bounds[0] > -1, `left-aligned should start at the angle, got ${left.bounds}`);
  assert.ok(right.bounds[2] < 1, `right-aligned should end at the angle, got ${right.bounds}`);
});

test('spacing is proportional, not one slot per character', async () => {
  // Eight narrow letters take less arc than eight wide ones. Even spacing would
  // give them the same.
  const narrow = await measure('text("iiiiiiii", size = 5, radius = 30, halign = "center", $fn = 24);');
  const wide = await measure('text("MMMMMMMM", size = 5, radius = 30, halign = "center", $fn = 24);');
  assert.ok(
    wide.bounds[2] - wide.bounds[0] > (narrow.bounds[2] - narrow.bounds[0]) * 2,
    `expected M to take far more arc than i: ${narrow.bounds} vs ${wide.bounds}`,
  );
});

test('facing = "in" puts the letters the other way up', async () => {
  const out = await measure('text("ABC", size = 5, radius = 20, halign = "center", start = 270, $fn = 32);');
  const inward = await measure(
    'text("ABC", size = 5, radius = 20, halign = "center", start = 270, facing = "in", $fn = 32);',
  );
  // Outward at the bottom hangs below the radius; inward sits above it.
  assert.ok(out.bounds[1] < -20, `outward should extend past the radius, got ${out.bounds}`);
  assert.ok(inward.bounds[1] > -21 && inward.bounds[3] < -13, `inward should sit inside, got ${inward.bounds}`);
});

test('a zero radius is an error, not a guess', async () => {
  const result = await engine.render('text("X", size = 5, radius = 0);');
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'error' && /radius must not be zero/.test(d.message)),
    'expected an error for radius = 0',
  );
});

test('a circle and a vertical run are refused rather than combined', async () => {
  const result = await engine.render('text("X", size = 5, radius = 10, direction = "ttb");');
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'error' && /cannot be combined with direction/.test(d.message)),
    'expected an error for radius with a vertical direction',
  );
});

test('text with no radius is untouched, and exports byte for byte', async () => {
  const source = 'text("PLAIN", size = 5);\n';
  const legacy = toStockScad(source, 'arc.scad', { fonts });
  assert.equal(legacy.verbatim, true);
  assert.equal(legacy.source, source);
});

test('the export places the glyphs where the engine does', async () => {
  for (const source of [
    'text("BETTERSCAD", size = 5, radius = 20, halign = "center", $fn = 48);',
    'text("BATTERY", size = 4, radius = 15, $fn = 32);',
    'text("CAP", size = 5, radius = 18, halign = "center", facing = "in", start = 270, $fn = 32);',
    'text("ABC", size = 6, radius = 30, valign = "top", spacing = 1.4, $fn = 24);',
    'text("DIAL", size = 5, radius = 22, halign = "right", start = 40, $fn = 40);',
    'n = 3; text(str("M", n), size = 4, radius = 12, $fn = 32);',
    'for (i = [0:5]) text(str(i), size = 3, radius = 20, halign = "center", start = 90 - i * 30, $fn = 24);',
  ]) {
    await exportMatches(source);
  }
});

test('the export carries the widths, because OpenSCAD cannot measure them', async () => {
  const legacy = toStockScad('text("AB", size = 5, radius = 20);', 'arc.scad', { fonts });
  // Only the characters used, not the whole font.
  assert.match(legacy.source, /__adv_keys = \["A", "B"\]/);
  // And the table is shared rather than repeated per call.
  const twice = toStockScad(
    'text("AB", size = 5, radius = 20); text("AB", size = 3, radius = 9);',
    'arc.scad',
    { fonts },
  );
  assert.equal(twice.source.match(/__adv_keys =/g).length, 1);
});

test('a runtime string still exports, on a table of printable ASCII', async () => {
  const legacy = toStockScad('s = "hi"; text(s, size = 5, radius = 20);', 'arc.scad', { fonts });
  assert.deepEqual(legacy.errors, []);
  assert.match(legacy.source, /__adv_keys = \[" ", "!"/);
});

test('without the font the export refuses rather than misplacing the text', async () => {
  // Both the "no registry at all" case and the one that actually bit: a
  // registry that was passed but holds nothing useful. The question is whether
  // the face was there, not whether an object was.
  for (const options of [undefined, { fonts: new FontRegistry() }]) {
    const legacy = toStockScad('text("AB", size = 5, radius = 20);', 'arc.scad', options);
    assert.equal(legacy.verbatim, true, 'nothing should have been rewritten');
    assert.equal(legacy.source, 'text("AB", size = 5, radius = 20);');
    assert.ok(
      legacy.errors.some((e) => /needs the font/.test(e.message)),
      `expected an explanatory error, got ${JSON.stringify(legacy.errors)}`,
    );
  }
});
