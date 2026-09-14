/**
 * Overlapping solids are really unioned before they leave the engine.
 *
 * `union` is lazy everywhere inside the evaluator, and that is the right
 * default: pieces stay separate so each keeps its own colour, and not running
 * the boolean is most of what makes a preview quick. The viewport does not mind
 * two solids sharing space.
 *
 * A mesh file minds very much. Two overlapping shells written to an STL are an
 * interior wall, and a slicer reads a wall it cannot get outside of as a
 * cavity — which is exactly what came back from a printed model: hooks that
 * sliced as holes. So the boolean is run for a final render and for export,
 * and only skipped while previewing.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function build(source, preview) {
  const result = await engine.render(source, { preview });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);
  return result.geometry;
}

/**
 * Whether every edge of a part is shared by exactly two triangles.
 *
 * The property a slicer needs, checked the way a slicer would: weld the
 * vertices by position, then look for an edge with anything other than two
 * faces on it.
 */
function isClosed(mesh) {
  const ids = new Map();
  const at = (i) => {
    const key = [0, 1, 2].map((a) => mesh.positions[i * 3 + a].toFixed(4)).join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key);
  };
  const edges = new Map();
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [at(mesh.triangles[t]), at(mesh.triangles[t + 1]), at(mesh.triangles[t + 2])];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p}-${q}` : `${q}-${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

/** Two boxes sharing half their volume. */
const OVERLAPPING = 'cube([10, 10, 10]); translate([5, 0, 0]) cube([10, 10, 10]);';

test('a preview leaves overlapping solids alone', async () => {
  const geometry = await build(OVERLAPPING, true);
  assert.equal(geometry.parts.length, 2, 'preview should not pay for the boolean');
  // Two 1000 mm3 boxes, counted twice over the 500 they share.
  assert.ok(Math.abs(geometry.stats.volume - 2000) < 1e-6, `${geometry.stats.volume}`);
});

test('a final render unions them', async () => {
  const geometry = await build(OVERLAPPING, false);
  assert.equal(geometry.parts.length, 1, 'export geometry should be one solid');
  // 2000 less the 500 they share: the volume of the thing you would print.
  assert.ok(Math.abs(geometry.stats.volume - 1500) < 1e-6, `${geometry.stats.volume}`);
});

test('and what comes out is closed', async () => {
  // The whole point. Unmerged, these two parts are interior walls.
  const geometry = await build(OVERLAPPING, false);
  for (const part of geometry.parts) {
    assert.ok(isClosed(part.mesh), 'exported part is not a closed manifold');
  }
});

test('solids that never touch are left as they are', async () => {
  const apart = 'cube(10); translate([50, 0, 0]) cube(10);';
  const geometry = await build(apart, false);
  assert.ok(Math.abs(geometry.stats.volume - 2000) < 1e-6, `${geometry.stats.volume}`);
  for (const part of geometry.parts) assert.ok(isClosed(part.mesh));
});

test('colours survive the merge', async () => {
  // A multi-colour export carries one object per colour. Merging across them
  // would throw that away, so the union is per colour.
  const source = `
    color("red") cube([10, 10, 10]);
    color("red") translate([5, 0, 0]) cube([10, 10, 10]);
    color("blue") translate([0, 20, 0]) cube([10, 10, 10]);
  `;
  const geometry = await build(source, false);
  assert.equal(geometry.parts.length, 2, 'one part per colour, not one part in total');

  // The two red boxes became one solid; the blue one was already alone.
  const volumes = geometry.parts.map((p) => p.color.join(','));
  assert.equal(new Set(volumes).size, 2, 'the two parts should be different colours');
  assert.ok(Math.abs(geometry.stats.volume - 2500) < 1e-6, `${geometry.stats.volume}`);
});

test('the reported volume is the volume of the thing you would print', async () => {
  // Three boxes in a row, each overlapping the next.
  const source = 'for (i = [0:2]) translate([i * 5, 0, 0]) cube([10, 10, 10]);';
  const preview = await build(source, true);
  const exported = await build(source, false);
  assert.ok(preview.stats.volume > exported.stats.volume, 'preview double-counts, as it may');
  assert.ok(Math.abs(exported.stats.volume - 2000) < 1e-6, `${exported.stats.volume}`);
});

test('a negative sweep survives the whole path', async () => {
  // The model that started this: an arc swept backwards, unioned with its cap
  // and a stem it only touches. It used to export as three shells, two of them
  // inside-out. It should now be one closed solid with positive volume.
  const source = `
    $fn = 48;
    translate([14, 0, 0]) rotate_extrude(angle = -180) translate([10, 0]) square([4, 6]);
    translate([26, 0, 0]) cylinder(d = 4, h = 6);
    hull() { cube([4, 0.1, 6]); translate([0, 11.9, 0]) cube([4, 0.1, 10]); }
  `;
  const geometry = await build(source, false);
  assert.equal(geometry.parts.length, 1, 'should come out as a single solid');
  assert.ok(geometry.stats.volume > 0, `volume is ${geometry.stats.volume}`);
  assert.ok(isClosed(geometry.parts[0].mesh), 'the exported solid is not closed');
});
