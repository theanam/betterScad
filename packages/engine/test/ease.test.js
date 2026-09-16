/**
 * `linear_extrude(ease = …)`: a taper that follows a curve rather than a line.
 *
 * Two properties carry the whole feature and each has a test here.
 *
 * The first is that `ease = 0` is not merely close to the stock extrusion, it
 * *is* the stock extrusion. The profile is `f(t) = t − bottom·t(t−1)² −
 * top·t²(t−1)`, so at zero both corrections vanish and what is left is `t`. If
 * that ever stops holding exactly, every existing model that gains an `ease`
 * argument moves, which is the one thing this parameter must never do.
 *
 * The second is the project's hard rule: the legacy `.scad` rewrite has to be
 * geometrically equivalent. The evaluator and the generated module build the
 * curve the same way — a stack of short straight extrusions — and in the same
 * order, down to where the `center` offset is applied, so the two agree by
 * construction rather than by two implementations happening to land together.
 * `equivalent()` below is what holds that, across every awkward combination the
 * parameter can be mixed with: centring, a negative height, twist, `v =`, and a
 * scale given per axis.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, describeExtensions, parse, transpileToLegacyScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function measure(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of result.geometry.parts) {
    const p = part.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        if (p[i + axis] < min[axis]) min[axis] = p[i + axis];
        if (p[i + axis] > max[axis]) max[axis] = p[i + axis];
      }
    }
  }
  const { volume, area } = result.geometry.stats;
  return { bounds: [...min, ...max], volume, area };
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

const sameAs = (actual, expected, what) => {
  assert.ok(
    actual.bounds.every((v, i) => near(v, expected.bounds[i], 1e-6)),
    `${what}\n  bounds ${actual.bounds}\n  expected ${expected.bounds}`,
  );
  assert.ok(near(actual.volume, expected.volume), `${what}: volume ${actual.volume} vs ${expected.volume}`);
  assert.ok(near(actual.area, expected.area), `${what}: area ${actual.area} vs ${expected.area}`);
};

/** The eased form renders as its own legacy export does. */
async function equivalent(source) {
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  sameAs(await measure(legacy), await measure(source), `the export of ${source}\n${legacy}`);
}

// --- ease = 0 is the stock extrusion ----------------------------------------

test('ease = 0 is the straight taper, not an approximation of it', async () => {
  const stock = await measure('$fn = 64; linear_extrude(height = 30, scale = 0.35) circle(12);');
  const eased = await measure('$fn = 64; linear_extrude(height = 30, scale = 0.35, ease = 0) circle(12);');
  sameAs(eased, stock, 'ease = 0');
});

test('ease = 0 leaves the mesh alone as well as the volume', async () => {
  // Volume and bounds can agree while the surface is rebuilt from a stack of
  // slices; the triangle count is what catches that. A straight taper must not
  // quietly become 48 segments because an argument was written.
  const stock = await engine.render('$fn = 64; linear_extrude(height = 30, scale = 0.35) circle(12);');
  const eased = await engine.render('$fn = 64; linear_extrude(height = 30, scale = 0.35, ease = 0) circle(12);');
  const count = (r) => r.geometry.parts.reduce((n, p) => n + p.mesh.positions.length, 0);
  assert.equal(count(eased), count(stock));
});

// --- the parameter does something -------------------------------------------

test('easing changes the solid, and each end independently', async () => {
  const at = async (ease) =>
    (await measure(`$fn = 64; linear_extrude(height = 30, scale = 0.35, ease = ${ease}) circle(12);`)).volume;

  const straight = await at('0');
  const both = await at('1');
  const bottom = await at('[1, 0]');
  const top = await at('[0, 1]');

  assert.ok(both > straight, 'a smoothstep profile holds more than the straight line');
  // Easing only the bottom keeps the wide end wide for longer, so it must hold
  // more than easing only the top, which keeps the narrow end narrow.
  assert.ok(bottom > top, `bottom-eased ${bottom} should exceed top-eased ${top}`);
  assert.ok(!near(bottom, both) && !near(top, both), 'one-sided easing differs from two-sided');
});

test('the profile never folds back, whatever the ease', async () => {
  // A cubic Hermite rising from 0 to 1 is monotonic while both tangents are in
  // [0, 3], and `ease` is clamped to [0, 1]. A folded profile would build the
  // extrusion inside out, so this sweeps the range and insists every one of
  // them renders as a valid solid with the bounds the taper implies.
  for (const ease of ['0', '0.25', '0.5', '0.75', '1', '[1, 0]', '[0, 1]', '[0.3, 0.9]']) {
    const m = await measure(`$fn = 32; linear_extrude(height = 20, scale = 0.4, ease = ${ease}) circle(10);`);
    assert.ok(m.volume > 0, `ease = ${ease} produced no volume`);
    // The profile runs between radius 10 and radius 4 and may not leave that
    // band at any height, which is what a fold would show up as.
    assert.ok(near(m.bounds[5], 20), `ease = ${ease} changed the height`);
    assert.ok(m.bounds[3] <= 10 + 1e-6, `ease = ${ease} bulged past the base radius`);
  }
});

// --- the named spellings ----------------------------------------------------

test('the named eases are the pairs they stand for', async () => {
  const pairs = [['"none"', '0'], ['"in"', '[1, 0]'], ['"out"', '[0, 1]'], ['"in_out"', '[1, 1]']];
  for (const [name, pair] of pairs) {
    const body = (ease) => `$fn = 48; linear_extrude(height = 25, scale = 0.3, ease = ${ease}) circle(9);`;
    sameAs(await measure(body(name)), await measure(body(pair)), `ease = ${name}`);
  }
});

test('an ease outside 0..1 is clamped rather than refused', async () => {
  const body = (ease) => `$fn = 48; linear_extrude(height = 25, scale = 0.3, ease = ${ease}) circle(9);`;
  sameAs(await measure(body('2')), await measure(body('1')), 'ease = 2');
  sameAs(await measure(body('-1')), await measure(body('0')), 'ease = -1');

  const result = await engine.render(body('2'));
  assert.ok(
    result.diagnostics.some((d) => d.code === 'eval.ease-range'),
    'clamping an out-of-range ease must say so',
  );
});

test('an unknown named ease warns and falls back to straight', async () => {
  const body = (ease) => `$fn = 48; linear_extrude(height = 25, scale = 0.3, ease = ${ease}) circle(9);`;
  sameAs(await measure(body('"swoosh"')), await measure(body('0')), 'ease = "swoosh"');
  const result = await engine.render(body('"swoosh"'));
  assert.ok(result.diagnostics.some((d) => d.code === 'eval.ease'), 'an unknown ease must say so');
});

// --- the downgrade ----------------------------------------------------------

test('the legacy export matches, in every combination ease can appear in', async () => {
  const cases = [
    '$fn = 64; linear_extrude(height = 30, scale = 0.35, ease = 1) circle(12);',
    '$fn = 64; linear_extrude(height = 30, scale = 0.35, ease = [1, 0]) circle(12);',
    '$fn = 48; linear_extrude(height = 20, scale = 0.4, ease = 0.7, center = true) square(10, center = true);',
    '$fn = 48; linear_extrude(height = -20, scale = 0.4, ease = 1) circle(8);',
    '$fn = 48; linear_extrude(height = 25, scale = 0.5, twist = 90, ease = [1, 0.3]) square(9, center = true);',
    '$fn = 48; linear_extrude(height = 20, scale = 0.5, ease = 0.8, v = [4, 2, 20]) circle(7);',
    '$fn = 48; linear_extrude(height = 20, scale = [0.2, 0.9], ease = 1) square(10, center = true);',
    '$fn = 48; linear_extrude(height = 20, scale = 0.4, ease = "in", slices = 12) circle(10);',
    // The clamp has to happen in the generated module too, not just in the
    // evaluator, or an out-of-range ease exports as a different solid.
    '$fn = 48; linear_extrude(height = 20, scale = 0.4, ease = 2) circle(10);',
    '$fn = 48; linear_extrude(height = 20, scale = 0.4, ease = [-1, 3]) circle(10);',
  ];
  for (const source of cases) await equivalent(source);
});

test('the slice count reaches the generated module', async () => {
  // The helper cannot derive the default the way the evaluator does, so the
  // transpiler writes it out. If the two ever disagree the export changes shape
  // while the source does not, which is the quietest possible bug.
  const written = transpileToLegacyScad(
    parse('linear_extrude(height = 10, scale = 0.5, ease = 1) circle(4);').file,
    { header: false },
  ).source;
  assert.match(written, /slices = 48/);

  const explicit = transpileToLegacyScad(
    parse('linear_extrude(height = 10, scale = 0.5, ease = 1, slices = 9) circle(4);').file,
    { header: false },
  ).source;
  assert.match(explicit, /slices = 9/);
});

test('the helper is emitted once however often the ease is used', async () => {
  const source = [
    'linear_extrude(height = 10, scale = 0.5, ease = 1) circle(4);',
    'translate([20, 0, 0]) linear_extrude(height = 10, scale = 0.2, ease = "in") square(5);',
  ].join('\n');
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.equal(legacy.match(/module __eased_extrude/g).length, 1);
  assert.equal(legacy.match(/__eased_extrude\(/g).length, 3, 'one definition and two calls');
});

test('a generated helper never takes a name the source already declares', async () => {
  const source = [
    'module __eased_extrude(x) { cube(x); }',
    '__eased_extrude(3);',
    'linear_extrude(height = 10, scale = 0.5, ease = 1) circle(4);',
  ].join('\n');
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.match(legacy, /module __eased_extrude_2\(/);
});

// --- what the file says it uses ---------------------------------------------

test('an eased extrude is reported as an extension, a straight one is not', async () => {
  const names = (source) => describeExtensions(parse(source).file).map((e) => e.name);
  assert.deepEqual(names('linear_extrude(height = 10, scale = 0.5) circle(4);'), []);
  assert.deepEqual(
    names('linear_extrude(height = 10, scale = 0.5, ease = 1) circle(4);'),
    ['linear_extrude(ease = …)'],
  );
});
