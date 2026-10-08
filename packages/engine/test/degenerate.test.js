/**
 * Zero-size shapes next to real ones.
 *
 * `Manifold.cube([0, 0, 0])` reports itself empty but unions as the whole
 * scene: `union([cylinder, thatCube])` had zero volume, so one degenerate
 * primitive anywhere blanked the entire model. And `new CrossSection([])`
 * throws outright. Both showed up as a `circle(d = 0)` in a torus whose
 * thickness came out to nothing.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function render(source) {
  const result = await engine.render(source, { file: 'degenerate.scad', preview: false });
  return { diagnostics: result.diagnostics, volume: result.geometry.stats.volume };
}

for (const [name, degenerate] of [
  ['cube(0)', 'cube(0)'],
  ['sphere(0)', 'sphere(0)'],
  ['cylinder(h = 0)', 'cylinder(h = 0, d = 2)'],
  ['circle(d = 0) revolved', 'rotate_extrude() circle(d = 0)'],
  ['square(0) linear_extruded', 'linear_extrude(2) square(0)'],
]) {
  test(`${name} does not blank its siblings`, async () => {
    const { diagnostics, volume } = await render(`cylinder(d = 2, h = 2, $fn = 16); ${degenerate};`);
    assert.deepEqual(diagnostics, []);
    assert.ok(Math.abs(volume - 6.12) < 0.01, `volume ${volume}`);
  });
}

test('a zero-thickness torus is empty, not an error', async () => {
  const { diagnostics, volume } = await render(
    'rotate_extrude() translate([5, 0]) circle(d = 0);',
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(volume, 0);
});
