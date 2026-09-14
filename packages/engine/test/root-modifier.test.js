/**
 * The `!` root modifier.
 *
 * It does not mean "show only this". It means **"use this subtree as the design
 * root"** — so everything *outside* the marked subtree is discarded, including
 * the transforms, colour and extrudes wrapping it, while everything *inside*
 * still applies. The OpenSCAD manual is explicit about the asymmetry: given
 * `translate(…) !rotate(…) cube();` the rotate runs and the translate has no
 * effect.
 *
 * That distinction is the whole test file. Getting it wrong renders the right
 * object in the wrong place, which is worse than rendering nothing, because it
 * looks like it worked.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { DEFAULT_COLOR, Engine } from '../dist/index.js';

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
  return { min, max, result };
}

/** Asserts where the geometry actually sits on X, which is what a translate moves. */
async function assertSpanX(source, expectedMin, expectedMax) {
  const { min, max } = await boundsOf(source);
  assert.ok(
    Math.abs(min[0] - expectedMin) < 1e-6 && Math.abs(max[0] - expectedMax) < 1e-6,
    `expected x ${expectedMin}..${expectedMax}, got ${min[0].toFixed(3)}..${max[0].toFixed(3)} for:\n${source}`,
  );
}

// --- transforms above and below --------------------------------------------

test('a transform outside the marked subtree has no effect', async () => {
  // The reported case: the object rendered alone, but still displaced by the
  // translate it was written under.
  await assertSpanX('translate([30, 0, 0]) !cube(10);', 0, 10);
});

test('a transform inside the marked subtree still applies', async () => {
  await assertSpanX('!translate([30, 0, 0]) cube(10);', 30, 40);
});

test('only the transforms below the mark apply', async () => {
  await assertSpanX('translate([30, 0, 0]) !translate([5, 0, 0]) cube(10);', 5, 15);
});

test('nested transforms above the mark are all discarded', async () => {
  await assertSpanX(
    'translate([100, 0, 0]) rotate([0, 0, 90]) translate([7, 0, 0]) !cube(10);',
    0,
    10,
  );
});

// --- everything else above the mark ----------------------------------------

test('siblings are discarded wherever they sit', async () => {
  await assertSpanX('cube(10); translate([50, 0, 0]) !translate([2, 0, 0]) cube(4);', 2, 6);
});

test('an enclosing boolean is discarded, not applied', async () => {
  // Were the difference still applied, the sphere would come back hollowed or
  // empty rather than whole.
  const { result } = await boundsOf(`
    difference() {
      cube(40, center = true);
      translate([30, 0, 0]) !sphere(10, $fn = 64);
    }
  `);
  const volume = result.geometry.stats.volume;
  const sphere = (4 / 3) * Math.PI * 1000;
  assert.ok(
    Math.abs(volume - sphere) / sphere < 0.02,
    `expected a whole sphere (~${sphere.toFixed(0)}), got ${volume.toFixed(0)}`,
  );
  // Centred on the origin, not on the translate. Tolerance is loose because a
  // tessellated sphere's vertices sit just inside its radius.
  const { min, max } = await boundsOf(
    'difference() { cube(40, center = true); translate([30, 0, 0]) !sphere(10, $fn = 64); }',
  );
  assert.ok(Math.abs(min[0] + max[0]) < 0.1, `expected a centred sphere, got ${min[0]}..${max[0]}`);
  assert.ok(Math.abs(max[0] - min[0] - 20) < 0.1, `expected a diameter of 20, got ${max[0] - min[0]}`);
});

test('an enclosing resize is discarded', async () => {
  await assertSpanX('resize([100, 0, 0]) translate([30, 0, 0]) !cube(10);', 0, 10);
});

test('an enclosing extrude is discarded, and the result stays 2D', async () => {
  const result = await engine.render('linear_extrude(50) !square(10);');
  assert.equal(result.geometry.dimension, 2, 'the square must not be extruded');
});

test('an enclosing colour does not paint the root subtree', async () => {
  // Parts always carry a colour by the time they reach here — an unpainted one
  // gets the default — so the check is that it is *not* the red asked for.
  const result = await engine.render('color("red") !cube(10);');
  assert.equal(result.geometry.parts.length, 1);
  assert.deepEqual(
    [...result.geometry.parts[0].color],
    [...DEFAULT_COLOR],
    'colour sits outside the marked subtree, so the cube keeps the default',
  );
});

test('a colour inside the marked subtree still paints', async () => {
  const result = await engine.render('translate([30, 0, 0]) !color("red") cube(10);');
  assert.equal(result.geometry.parts.length, 1);
  const [r, g, b] = result.geometry.parts[0].color;
  assert.ok(r === 1 && g === 0 && b === 0, `expected red, got ${r}, ${g}, ${b}`);
});

// --- interaction with the other modifiers ----------------------------------

test('a disabled mark is still disabled', async () => {
  // `*` wins over `!`: an explicitly disabled subtree stays disabled, so the
  // rest of the design renders normally.
  await assertSpanX('cube(10); translate([50, 0, 0]) *!cube(4);', 0, 10);
});

test('the mark survives being reached through a module', async () => {
  await assertSpanX(
    `module part() { translate([5, 0, 0]) cube(10); }
     translate([80, 0, 0]) !part();`,
    5,
    15,
  );
});
