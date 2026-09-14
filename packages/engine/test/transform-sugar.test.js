/**
 * Loose-number and single-axis transforms.
 *
 * `translate(x, y, z)` for `translate([x, y, z])`, and `translatex(d)` /
 * `rotatez(a)` / `mirrory()` for the single-axis cases. Sugar only — each one
 * is the stock call with the brackets or the zeros filled in.
 *
 * Two things are checked for every form, because sugar that is *nearly* the
 * same is worse than no sugar at all:
 *
 *   1. it produces the same geometry as the stock spelling, and
 *   2. its legacy `.scad` export produces the same geometry again.
 *
 * The third group is the important one: every stock call shape must still reach
 * the code it always did. `rotate(a, v)` in particular is real OpenSCAD whose
 * second argument is a vector, and it must not be mistaken for `rotate(x, y, z)`.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, describeExtensions, parse, transpileToLegacyScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function boundsOf(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of result.geometry.parts) {
    for (let i = 0; i < part.mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = part.mesh.positions[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
  }
  return [...min, ...max];
}

const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

/**
 * Asserts the sugar matches the stock spelling, and that its downgrade does too.
 *
 * The downgrade leg is what makes this sugar rather than a dialect: an export
 * that drifted would hand someone a `.scad` that builds a different part.
 */
async function equivalent(sugar, stock) {
  const expected = await boundsOf(stock);
  const actual = await boundsOf(sugar);
  assert.ok(close(actual, expected), `${sugar}\n  gave ${actual}\n  expected ${expected} (from ${stock})`);

  const legacy = transpileToLegacyScad(parse(sugar).file, { header: false }).source;
  const downgraded = await boundsOf(legacy);
  assert.ok(
    close(downgraded, expected),
    `the legacy export of ${sugar} gave ${downgraded}, expected ${expected}\n${legacy}`,
  );
}

// --- loose numbers instead of a vector -------------------------------------

test('translate takes loose numbers', async () => {
  await equivalent('translate(10, 5, 2) cube(4);', 'translate([10, 5, 2]) cube(4);');
});

test('a two-number translate leaves z alone', async () => {
  await equivalent('translate(10, 5) cube(4);', 'translate([10, 5, 0]) cube(4);');
});

test('rotate takes loose numbers', async () => {
  await equivalent('rotate(0, 0, 90) cube([4, 8, 2]);', 'rotate([0, 0, 90]) cube([4, 8, 2]);');
});

test('mirror takes loose numbers', async () => {
  await equivalent('translate(5, 0, 0) mirror(1, 0, 0) cube(4);', 'translate([5, 0, 0]) mirror([1, 0, 0]) cube(4);');
});

test('loose numbers can be expressions, not just literals', async () => {
  await equivalent('d = 3;\ntranslate(d * 2, d + 1, -d) cube(4);', 'd = 3;\ntranslate([d * 2, d + 1, -d]) cube(4);');
});

// --- single-axis forms ------------------------------------------------------

test('translatex / translatey / translatez', async () => {
  await equivalent('translatex(7) cube(4);', 'translate([7, 0, 0]) cube(4);');
  await equivalent('translatey(7) cube(4);', 'translate([0, 7, 0]) cube(4);');
  await equivalent('translatez(7) cube(4);', 'translate([0, 0, 7]) cube(4);');
});

test('rotatex / rotatey / rotatez', async () => {
  await equivalent('rotatex(90) cube([2, 4, 8]);', 'rotate([90, 0, 0]) cube([2, 4, 8]);');
  await equivalent('rotatey(90) cube([2, 4, 8]);', 'rotate([0, 90, 0]) cube([2, 4, 8]);');
  await equivalent('rotatez(90) cube([2, 4, 8]);', 'rotate([0, 0, 90]) cube([2, 4, 8]);');
});

test('mirrorx / mirrory / mirrorz take no argument', async () => {
  await equivalent('translatex(5) mirrorx() cube(4);', 'translate([5, 0, 0]) mirror([1, 0, 0]) cube(4);');
  await equivalent('translatey(5) mirrory() cube(4);', 'translate([0, 5, 0]) mirror([0, 1, 0]) cube(4);');
  await equivalent('translatez(5) mirrorz() cube(4);', 'translate([0, 0, 5]) mirror([0, 0, 1]) cube(4);');
});

test('the single-axis forms nest and take expressions', async () => {
  await equivalent(
    'n = 2;\ntranslatex(n * 5) rotatez(45) translatez(n) cube(4);',
    'n = 2;\ntranslate([n * 5, 0, 0]) rotate([0, 0, 45]) translate([0, 0, n]) cube(4);',
  );
});

// --- stock syntax must be untouched ----------------------------------------

test('rotate(a, v) is still the stock axis rotation', async () => {
  // Two positional arguments whose second is a vector. Reading this as
  // `rotate(x, y, z)` would silently rotate about the wrong thing.
  const stock = await boundsOf('rotate(90, [0, 0, 1]) cube([4, 8, 2]);');
  const spelled = await boundsOf('rotate([0, 0, 90]) cube([4, 8, 2]);');
  assert.ok(close(stock, spelled), `rotate(a, v) changed meaning: ${stock} vs ${spelled}`);
});

test('a vector argument is still a vector', async () => {
  await equivalent('translate([1, 2, 3]) cube(4);', 'translate([1, 2, 3]) cube(4);');
});

test('a single-argument translate is unchanged', async () => {
  // Whatever `translate(5)` meant before, it must go on meaning it — the sugar
  // only reads the extra slots when a second argument is actually present.
  const result = await engine.render('translate(5) cube(4);');
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
});

test('named arguments still bind the stock way', async () => {
  await equivalent('translate(v = [1, 2, 3]) cube(4);', 'translate([1, 2, 3]) cube(4);');
});

// --- the downgrade is reported ----------------------------------------------

test('every sugared call is reported as an extension', async () => {
  const source = [
    'translate(1, 2, 3) cube(1);',
    'translatex(1) cube(1);',
    'rotatey(1) cube(1);',
    'mirrorz() cube(1);',
    'rotate(1, 2, 3) cube(1);',
  ].join('\n');
  const names = describeExtensions(parse(source).file).map((e) => e.name).sort();
  assert.deepEqual(names, [
    'mirrorz()',
    'rotate(x, y, z)',
    'rotatey()',
    'translate(x, y, z)',
    'translatex()',
  ]);
});

test('stock transforms are not reported as extensions', async () => {
  const source = 'translate([1,2,3]) rotate(45, [0,0,1]) mirror([1,0,0]) cube(1);';
  assert.deepEqual(describeExtensions(parse(source).file), []);
});

test('a file using only sugar downgrades to stock, and stays stock', async () => {
  const source = 'translatex(4) rotatez(30) cube(2);\n';
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.ok(!/translatex|rotatez/.test(legacy), `sugar survived into the export:\n${legacy}`);
  // Transpiling the result again must find nothing left to rewrite.
  assert.deepEqual(describeExtensions(parse(legacy).file), []);
});
