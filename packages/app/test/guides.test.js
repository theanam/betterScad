/**
 * Smart guides: a point or a shape pulls to the key points of its neighbours.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTargets, snapToTargets, targetsOf } from '../src/sketch/guides.js';

const box = { kind: 'rect', x: 10, y: 10, w: 20, h: 10, r: 0 };

test('a box offers its corners, edge midpoints and centre', () => {
  const at = targetsOf(box, 0).map((t) => t.at);
  assert.equal(at.length, 9);
  assert.ok(at.some(([x, y]) => x === 20 && y === 15), 'the centre');
  assert.ok(at.some(([x, y]) => x === 30 && y === 15), 'the right edge midpoint');
});

test('each axis snaps on its own, to the nearest target within tolerance', () => {
  // A second box, so a point can share an x with one and a y with the other.
  const targets = collectTargets([box, { kind: 'rect', x: 50, y: 40, w: 10, h: 10, r: 0 }]);
  // Box one's right edge in x, box two's centre in y: two guides, no point.
  const r = snapToTargets([[30.4, 44.7]], targets, 0.5);
  assert.ok(Math.abs(r.dx - (30 - 30.4)) < 1e-9);
  assert.ok(Math.abs(r.dy - (45 - 44.7)) < 1e-9);
  assert.deepEqual(r.guides.map((g) => g.axis), ['x', 'y']);
  assert.equal(r.point, undefined);
  // Both axes on one corner: a point snap.
  const corner = snapToTargets([[29.8, 20.2]], targets, 0.5);
  assert.deepEqual(corner.point, [30, 20]);
  // Nothing near: nothing moves.
  const none = snapToTargets([[80, 80]], targets, 0.5);
  assert.equal(none.guides.length, 0);
  assert.equal(none.dx, 0);
});

test('a moving shape snaps by any of its key points, and never to itself', () => {
  const other = { kind: 'rect', x: 30.3, y: 0, w: 5, h: 5, r: 0 };
  const targets = collectTargets([box, other], 1);
  assert.ok(targets.every((t) => t.node !== 1));
  // Its left edge is 0.3 off the first box's right edge.
  const r = snapToTargets(targetsOf(other, 1).map((t) => t.at), targets, 0.5);
  assert.ok(Math.abs(r.dx - -0.3) < 1e-9, `dx ${r.dx}`);
});

test('the origin is always a target', () => {
  const r = snapToTargets([[0.2, -0.3]], collectTargets([]), 0.5);
  assert.deepEqual(r.point, [0, 0]);
});
