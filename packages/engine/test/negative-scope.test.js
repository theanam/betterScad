/**
 * Scoping rules for the `negative()` extension.
 *
 * A negative subtracts from every sibling in its enclosing *brace* scope —
 * `{ … }`, a module body, or the top level. Wrappers that are not scopes
 * (transforms, `if`, `for`, `let`, `color`) are transparent: the negative rides
 * up through them, carrying their transforms, until it reaches a scope.
 *
 * Every case is checked twice: once for the geometry it produces, and once for
 * the legacy `.scad` it transpiles to, which must produce identical geometry
 * (spec feature 21).
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, parse, transpileToLegacyScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function volumeOf(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);
  return result.geometry.stats.volume;
}

/**
 * Asserts the volume, and that the legacy transpile produces the same solid.
 *
 * The round trip is the real guarantee: a scoping change that the evaluator and
 * the transpiler disagree about would silently ship broken `.scad` exports.
 */
async function check(source, expected) {
  const actual = await volumeOf(source);
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `expected volume ${expected}, got ${actual.toFixed(4)} for:\n${source}`,
  );

  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.equal(
    parse(legacy).diagnostics.filter((d) => d.severity === 'error').length,
    0,
    `legacy output does not parse:\n${legacy}`,
  );
  assert.ok(
    !/^\s*negative\s*\(/m.test(legacy),
    `negative() survived into legacy output:\n${legacy}`,
  );

  const legacyVolume = await volumeOf(legacy);
  assert.ok(
    Math.abs(legacyVolume - expected) < 1e-6,
    `legacy transpile differs: expected ${expected}, got ${legacyVolume.toFixed(4)}\n${legacy}`,
  );
}

// --- reach -----------------------------------------------------------------

test('at the top level a negative cuts everything', async () => {
  await check('cube(10); negative() translate([5,0,0]) cube(10);', 500);
});

test('inside a block it cuts only that block', async () => {
  await check(
    `union() { cube(10); negative() translate([5,0,0]) cube(10); }
     translate([20,0,0]) cube(10);`,
    1500,
  );
});

// --- transparent wrappers --------------------------------------------------

test('a transform between the negative and its scope is transparent', async () => {
  await check('union() { cube(10); translate([5,0,0]) negative() cube(10); }', 500);
});

test('the transform is applied to the cutter, not ignored', async () => {
  // If the translate were dropped rather than carried, the cutter would sit at
  // the origin and remove the whole cube instead of half of it.
  await check('union() { cube(10); translate([5,0,0]) negative() cube(10); }', 500);
  await check('union() { cube(10); translate([20,0,0]) negative() cube(10); }', 1000);
});

test('nested transforms all apply', async () => {
  await check(
    'union() { cube(10); translate([5,0,0]) rotate([0,0,0]) negative() cube(10); }',
    500,
  );
});

test('`if` is transparent', async () => {
  await check('union() { cube(10); if (true) negative() translate([5,0,0]) cube(10); }', 500);
  await check('union() { cube(10); if (false) negative() translate([5,0,0]) cube(10); }', 1000);
});

test('`for` is transparent, once per iteration', async () => {
  await check(
    `union() {
       cube([30,10,10]);
       for (i = [0:1]) negative() translate([i*10,0,0]) cube(10);
     }`,
    1000,
  );
});

test('`color` is transparent', async () => {
  await check('union() { cube(10); color("red") negative() translate([5,0,0]) cube(10); }', 500);
});

// --- barriers --------------------------------------------------------------

test('a module body is a scope, so a negative cannot cut the caller', async () => {
  await check(
    `module hole() { negative() cube(100, center = true); }
     cube(10);
     hole();`,
    1000,
  );
});

test('an unbraced module body is still a scope', async () => {
  await check(
    `module hole() negative() cube(100, center = true);
     cube(10);
     hole();`,
    1000,
  );
});

test('a nested block contains its own negative', async () => {
  await check(
    `union() {
       cube([10,10,10]);
       union() {
         translate([20,0,0]) cube(10);
         negative() translate([20,0,0]) cube([5,10,10]);
       }
     }`,
    1500,
  );
});

test('a negative in one block cannot reach a sibling block', async () => {
  await check(
    `union() { cube(10); }
     union() { negative() cube(100, center = true); }`,
    1000,
  );
});

test('braces on a transform make it a scope', async () => {
  // `translate(v) negative() c;` bubbles out; `translate(v) { negative() c; }`
  // does not, because the braces are the scope.
  await check('union() { cube(10); translate([5,0,0]) { negative() cube(10); } }', 1000);
});

// --- diagnostics -----------------------------------------------------------

test('a negative with nothing to cut warns rather than vanishing silently', async () => {
  const result = await engine.render('union() { negative() cube(10); }');
  assert.ok(
    result.diagnostics.some(
      (d) => d.severity === 'warning' && /nothing to subtract from/.test(d.message),
    ),
    'expected a warning when a negative finds no siblings',
  );
});

// --- equivalence with difference() -----------------------------------------

test('negative() matches the difference() it transpiles to', async () => {
  const withNegative = await volumeOf(`
    union() {
      cube([20,20,10]);
      translate([0,0,10]) cylinder(h = 5, r = 8, $fn = 32);
      translate([10,10,-1]) negative() cylinder(h = 20, r = 4, $fn = 32);
    }
  `);
  const withDifference = await volumeOf(`
    difference() {
      union() {
        cube([20,20,10]);
        translate([0,0,10]) cylinder(h = 5, r = 8, $fn = 32);
      }
      translate([10,10,-1]) cylinder(h = 20, r = 4, $fn = 32);
    }
  `);
  assert.ok(Math.abs(withNegative - withDifference) < 1e-6, 'the two forms must agree exactly');
});

// --- declarations are not geometry ------------------------------------------
//
// The downgrade wraps a scope's geometry in `difference()`. A block is a scope
// in OpenSCAD too, so anything swept into that wrapper stops being visible to
// the cutters standing beside it. Every case above is pure geometry, which is
// exactly why this went unnoticed: it only bites when a cutter refers to
// something the scope declared.

test('a cutter can still see a function the scope declares', async () => {
  await check(
    `function bore() = 5;
     cube([20, 20, 10], center = true);
     negative() cube([bore(), bore(), 40], center = true);`,
    3750,
  );
});

test('a cutter can still see a variable the scope declares', async () => {
  await check(
    `a = 6;
     cube([20, 20, 10], center = true);
     negative() cube([a, a, 40], center = true);`,
    3640,
  );
});

test('assignments reach the cutter however late they are written', async () => {
  // Assignments are scope-wide, so this is legal and means the same thing. The
  // export has to preserve that, not just the common top-down spelling.
  await check(
    `cube([20, 20, 10], center = true);
     negative() cube([w, w, 40], center = true);
     w = 8;`,
    3360,
  );
});

test('the same holds inside a module body', async () => {
  await check(
    `module lid() {
       t = 4;
       cube([20, 20, 10], center = true);
       negative() cube([t, t, 40], center = true);
     }
     lid();`,
    3840,
  );
});

test('a module the scope declares survives the rewrite', async () => {
  await check(
    `module bore() { cube([5, 5, 40], center = true); }
     cube([20, 20, 10], center = true);
     negative() bore();`,
    3750,
  );
});

test('declarations are printed outside the generated difference', async () => {
  const legacy = transpileToLegacyScad(
    parse(
      `size = 30;
       function bore() = size / 6;
       module plate() { cube([size, size, 4], center = true); }
       plate();
       negative() cube([bore(), bore(), 40], center = true);`,
    ).file,
    { header: false },
  ).source;

  const cut = legacy.indexOf('difference() {');
  assert.ok(cut > 0, `expected a difference() in:\n${legacy}`);
  for (const declaration of ['size = 30;', 'function bore()', 'module plate()']) {
    const at = legacy.indexOf(declaration);
    assert.ok(at >= 0, `${declaration} is missing from:\n${legacy}`);
    assert.ok(at < cut, `${declaration} was swept inside the difference:\n${legacy}`);
  }
});
