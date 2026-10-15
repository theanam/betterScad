/**
 * A cutter flush with a face must open the face, not leave a skin on it.
 *
 * The kernel is exact, so a cylinder whose end sits 1e-16 off a wall leaves
 * a 1e-16 membrane across the hole: watertight, correct in volume, and drawn
 * as a solid face. The rotation matrix is where that hair came from.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, cosSinDegrees } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** Triangles lying in the plane y = 0 whose centre is within `r` of (x, *, z). */
function skinTriangles(mesh, x, z, r) {
  const { positions, triangles } = mesh;
  let count = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t] * 3, triangles[t + 1] * 3, triangles[t + 2] * 3];
    const ys = [positions[a + 1], positions[b + 1], positions[c + 1]];
    if (ys.some((y) => Math.abs(y) > 1e-6)) continue;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (Math.hypot(cx - x, cz - z) < r) count++;
  }
  return count;
}

test('right angles are exact', () => {
  assert.deepEqual(cosSinDegrees(-90), [0, -1]);
  assert.deepEqual(cosSinDegrees(90), [0, 1]);
  assert.deepEqual(cosSinDegrees(180), [-1, 0]);
  assert.deepEqual(cosSinDegrees(450), [0, 1]);
  assert.deepEqual(cosSinDegrees(0), [1, 0]);
  const [c, s] = cosSinDegrees(30);
  assert.ok(Math.abs(c - Math.sqrt(3) / 2) < 1e-12 && Math.abs(s - 0.5) < 1e-12);
});

test('a bore rotated onto a wall and flush with its face opens the face', async () => {
  const result = await engine.render(
    'difference(){ cube([44, 6, 80]); translate([22, 0, 20]) rotate([-90, 0, 0]) cylinder(h = 6, d = 4.5, $fn = 50); }',
    { file: 'main.scad', preview: false },
  );
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  const mesh = result.geometry.parts[0].mesh;
  assert.equal(skinTriangles(mesh, 22, 20, 2), 0, 'no triangles across the mouth of the hole');
  assert.ok(Math.abs(result.geometry.stats.volume - (44 * 6 * 80 - Math.PI * 2.25 ** 2 * 6)) < 2);
});
