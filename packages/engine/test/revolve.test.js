/**
 * `rotate_extrude()` with a negative angle.
 *
 * Manifold's `revolve` sweeps the other way round for a negative angle and
 * reverses the winding with it, so handing the angle straight through produced
 * an inside-out solid: the right shape, in the right place, with every normal
 * pointing inward.
 *
 * Nothing local caught it. The mesh is closed, it is edge-manifold, and the
 * viewport shades both faces, so the preview looked correct. It surfaced two
 * steps downstream — as booleans that produced nonsense, and as exported STLs
 * whose hooks a slicer read as holes and carved out of everything around them.
 *
 * So these tests measure the things that were still true while it was broken:
 * the sign of the volume, and what happens when the result meets another solid.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

const PROFILE = 'translate([10, 0]) square([4, 6])';

async function measure(source) {
  const result = await engine.render(`$fn = 48;\n${source}`);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of result.geometry.parts) {
    const p = part.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[i + a]);
        max[a] = Math.max(max[a], p[i + a]);
      }
    }
  }
  const { volume, area } = result.geometry.stats;
  return { volume, area, min, max };
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('a negative angle sweeps a solid, not an inside-out one', async () => {
  // The bug in one assertion: this volume used to come back negative.
  for (const angle of [-45, -90, -180, -270, -360]) {
    const { volume } = await measure(`rotate_extrude(angle = ${angle}) ${PROFILE};`);
    assert.ok(volume > 0, `rotate_extrude(angle = ${angle}) has volume ${volume}`);
  }
});

test('sweeping backwards covers as much as sweeping forwards', async () => {
  for (const angle of [45, 90, 180, 270, 360]) {
    const forward = await measure(`rotate_extrude(angle = ${angle}) ${PROFILE};`);
    const backward = await measure(`rotate_extrude(angle = ${-angle}) ${PROFILE};`);
    assert.ok(
      near(forward.volume, backward.volume, 1e-6),
      `${angle} gives ${forward.volume} but ${-angle} gives ${backward.volume}`,
    );
    assert.ok(near(forward.area, backward.area, 1e-6), `areas differ at ${angle}`);
  }
});

test('and it lands on the other side of the axis', async () => {
  // Not merely the same size: `angle = -90` occupies the quarter turn *below*
  // the X axis, which is what makes it different from `angle = 90` at all.
  const forward = await measure(`rotate_extrude(angle = 90) ${PROFILE};`);
  const backward = await measure(`rotate_extrude(angle = -90) ${PROFILE};`);

  assert.ok(forward.min[1] > -1e-9, `+90 should stay at y >= 0, got ${forward.min[1]}`);
  assert.ok(forward.max[1] > 1, '+90 should reach into positive y');
  assert.ok(backward.max[1] < 1e-9, `-90 should stay at y <= 0, got ${backward.max[1]}`);
  assert.ok(backward.min[1] < -1, '-90 should reach into negative y');

  // Mirror images across y, so the x extent is shared.
  assert.ok(near(forward.min[0], backward.min[0], 1e-6));
  assert.ok(near(forward.max[0], backward.max[0], 1e-6));
});

test('a backwards sweep behaves in a boolean', async () => {
  // Where it actually bit. An inverted solid unions to nonsense — this came
  // back with a *negative* volume and a mesh no slicer could read.
  const merge = (angle) =>
    measure(`intersection() {
      union() {
        rotate_extrude(angle = ${angle}) ${PROFILE};
        translate([12, 0]) cylinder(d = 4, h = 6);
      }
      translate([-100, -100, -100]) cube(200);
    }`);

  const backward = await merge(-180);
  assert.ok(backward.volume > 0, `union with a backwards sweep has volume ${backward.volume}`);

  // The mirror of the forward case, so the same amount of material.
  const forward = await merge(180);
  assert.ok(
    near(forward.volume, backward.volume, 1e-6),
    `${forward.volume} vs ${backward.volume}`,
  );
});

test('start still turns the result, whichever way it swept', async () => {
  const plain = await measure(`rotate_extrude(angle = -90) ${PROFILE};`);
  const turned = await measure(`rotate_extrude(angle = -90, start = 90) ${PROFILE};`);
  assert.ok(near(plain.volume, turned.volume, 1e-6), 'start should not change the volume');

  // `angle = -90` spans the quarter turn below the X axis; `start = 90` turns
  // that a quarter forwards, putting it above.
  assert.ok(plain.max[1] < 1e-9, `without start it should sit at y <= 0, got ${plain.max[1]}`);
  assert.ok(turned.min[1] > -1e-6, `start = 90 should lift it to y >= 0, got ${turned.min[1]}`);
  assert.ok(turned.max[1] > 1, 'start = 90 should reach into positive y');
});
