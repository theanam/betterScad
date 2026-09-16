/**
 * `offset()`, and the one thing about it that is easy to get wrong.
 *
 * Offsetting does not distribute over union: `offset(A ∪ B)` is not
 * `offset(A) ∪ offset(B)`. The difference sits exactly on the edges the union
 * creates, which is why it hid for so long — every convex test case looks
 * right, because a convex shape has no such edges.
 *
 * Two overlapping squares make a cross whose four inner corners are reflex.
 * Inset the cross and those corners round off; inset the two squares separately
 * and the corners never existed to be rounded, so they come out sharp. The
 * tests below pin the fix by writing the same cross two ways — as a union and
 * as a single polygon — and insisting the two agree.
 *
 * The other half of the job is not over-correcting. A negative `r` on a
 * *convex* profile is supposed to leave sharp corners: the inward offset of a
 * square is a smaller square. Rounding those would be just as wrong, so that is
 * pinned too.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** Signed area of a closed contour. */
function shoelace(contour) {
  let sum = 0;
  for (let i = 0; i < contour.length; i++) {
    const [x1, y1] = contour[i];
    const [x2, y2] = contour[(i + 1) % contour.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

async function region(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  let area = 0;
  let vertices = 0;
  let contours = 0;
  for (const shape of result.geometry.contours2d ?? []) {
    for (const contour of shape.contours) {
      area += shoelace(contour);
      vertices += contour.length;
      contours++;
    }
  }
  return { area: +area.toFixed(3), vertices, contours };
}

// The same cross, written two ways. The union spelling is the one that used to
// be offset piece by piece.
const AS_UNION = 'union() { square([30, 10], center = true); square([10, 30], center = true); }';
const AS_POLYGON =
  'polygon([[-15,-5],[-5,-5],[-5,-15],[5,-15],[5,-5],[15,-5],' +
  '[15,5],[5,5],[5,15],[-5,15],[-5,5],[-15,5]])';

const both = (offset) => [`$fn = 64; ${offset} ${AS_UNION}`, `$fn = 64; ${offset} ${AS_POLYGON};`];

test('offset() sees its children as one region, not one at a time', async () => {
  for (const offset of ['offset(r = -2)', 'offset(r = 2)', 'offset(delta = -2)', 'offset(delta = 2)']) {
    const [viaUnion, viaPolygon] = both(offset);
    const a = await region(viaUnion);
    const b = await region(viaPolygon);
    assert.equal(a.contours, 1, `${offset}: an offset region has one boundary`);
    assert.ok(
      Math.abs(a.area - b.area) < 1e-3,
      `${offset}: union spelling gave ${a.area}, polygon spelling gave ${b.area}`,
    );
    assert.equal(a.vertices, b.vertices, `${offset}: the two spellings disagree on the boundary`);
  }
});

test('a negative r rounds the corners the union creates', async () => {
  // The reported symptom. The cross has four reflex corners; a round join must
  // put an arc at each, so the boundary gains far more than its twelve points.
  const { vertices, contours } = await region(`$fn = 64; offset(r = -2) ${AS_UNION}`);
  assert.equal(contours, 1);
  assert.ok(vertices > 60, `expected arcs at the reflex corners, got ${vertices} points`);
});

test('a negative r still leaves a convex profile sharp', async () => {
  // Not a bug, and the thing most likely to be broken by over-correcting: the
  // inward offset of a square is a smaller square. There is no reflex corner
  // for the round join to act on, so four points is the right answer.
  const square = await region('$fn = 64; offset(r = -2) square(20, center = true);');
  assert.equal(square.vertices, 4);
  assert.ok(Math.abs(square.area - 256) < 1e-6, `expected 16x16, got area ${square.area}`);

  // And the outward offset of the same square does round, so the join type is
  // reaching Clipper rather than being ignored in both directions.
  const grown = await region('$fn = 64; offset(r = 2) square(20, center = true);');
  assert.ok(grown.vertices > 60, `expected rounded corners, got ${grown.vertices} points`);
});

test('delta keeps corners sharp where r rounds them', async () => {
  const mitred = await region(`$fn = 64; offset(delta = -2) ${AS_UNION}`);
  assert.equal(mitred.contours, 1);
  assert.equal(mitred.vertices, 12, 'a mitre join keeps the cross at twelve corners');

  const cut = await region(`$fn = 64; offset(delta = -2, chamfer = true) ${AS_UNION}`);
  assert.equal(cut.contours, 1);
  // A flat cut across each reflex corner adds a point at each of the four.
  assert.equal(cut.vertices, 16);
});

test('an inset that consumes the shape leaves nothing, without failing', async () => {
  const gone = await region('$fn = 32; offset(r = -12) square(20, center = true);');
  assert.equal(gone.contours, 0);
  assert.equal(gone.area, 0);
});

test('offset() on 3D geometry says so', async () => {
  const result = await engine.render('offset(r = 2) cube(10);');
  assert.ok(
    result.diagnostics.some((d) => d.code === 'kernel.offset-3d'),
    'offsetting a solid must warn rather than silently do nothing',
  );
});
