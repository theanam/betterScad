/**
 * Geometry tests: primitives, booleans, extrusions, modifier roles and export.
 *
 * These load the real Manifold WASM kernel, so they are the closest thing to an
 * end-to-end check the engine has.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import {
  Engine,
  EXPORT_FORMATS,
  exportResult,
  importOFF,
  importSTL,
  parseSurfaceDat,
  surfaceToMesh,
  allRoles,
  resolveContribution,
} from '../dist/index.js';

let engine;

before(async () => {
  engine = await Engine.create();
});

/** Renders and asserts nothing errored, returning the geometry. */
async function render(source, options) {
  const result = await engine.render(source, options);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], 'render should not error');
  return result;
}

const volumeOf = (result) => result.geometry.stats.volume;

// ---------------------------------------------------------------------------

test('cube volume is exact', async () => {
  const result = await render('cube([2, 3, 4]);');
  assert.equal(result.geometry.dimension, 3);
  assert.ok(Math.abs(volumeOf(result) - 24) < 1e-6);
});

test('centred and uncentred cubes occupy different space but equal volume', async () => {
  const centred = await render('cube(10, center = true);');
  const corner = await render('cube(10);');
  assert.ok(Math.abs(volumeOf(centred) - volumeOf(corner)) < 1e-6);
  // A difference of the two must be non-empty: they are in different places.
  const diff = await render('difference() { cube(10); cube(10, center = true); }');
  assert.ok(volumeOf(diff) > 0);
});

test('sphere tessellation matches OpenSCAD segment counts', async () => {
  // $fn = 6 gives 6 longitudes and floor((6+1)/2) = 3 latitude rings.
  const result = await render('sphere(r = 10, $fn = 6);');
  assert.equal(result.geometry.parts.length, 1);
  assert.equal(result.geometry.stats.vertices, 6 * 3);
});

test('cylinder honours $fn, r1/r2 and cone degeneration', async () => {
  const prism = await render('cylinder(h = 10, r = 5, $fn = 3);');
  // A triangular prism: 3 vertices top, 3 bottom.
  assert.equal(prism.geometry.stats.vertices, 6);

  const cone = await render('cylinder(h = 10, r1 = 5, r2 = 0, $fn = 32);');
  const expected = (Math.PI * 25 * 10) / 3;
  // A 32-gon under-fills the circle slightly, so allow a small shortfall.
  assert.ok(volumeOf(cone) < expected && volumeOf(cone) > expected * 0.97);
});

test('difference, union and intersection produce the expected volumes', async () => {
  const union = await render('union() { cube(10); translate([10,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(union) - 2000) < 1e-4);

  const diff = await render('difference() { cube(10); translate([5,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(diff) - 500) < 1e-4);

  const inter = await render('intersection() { cube(10); translate([5,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(inter) - 500) < 1e-4);
});

test('linear_extrude of a square is a box', async () => {
  const result = await render('linear_extrude(height = 5) square([2, 3]);');
  assert.ok(Math.abs(volumeOf(result) - 30) < 1e-6);
});

test('linear_extrude with a negative height extrudes downwards', async () => {
  const result = await render('linear_extrude(height = -5) square(2);');
  assert.ok(Math.abs(volumeOf(result) - 20) < 1e-6);
  const { min, max } = boundsOfResult(result);
  assert.ok(max[2] <= 1e-6 && min[2] < -4.9, 'the solid should sit below z = 0');
});

test('rotate_extrude sweeps a profile into a torus', async () => {
  const result = await render('rotate_extrude($fn = 64) translate([10, 0]) circle(2, $fn = 64);');
  // Pappus: V = 2*pi*R * pi*r^2
  const expected = 2 * Math.PI * 10 * Math.PI * 4;
  assert.ok(Math.abs(volumeOf(result) - expected) / expected < 0.02);
});

test('hull and minkowski run and enlarge the input', async () => {
  const plain = await render('cube(10, center = true);');
  const hulled = await render('hull() { cube(10, center = true); translate([20,0,0]) sphere(1, $fn=16); }');
  assert.ok(volumeOf(hulled) > volumeOf(plain));

  const summed = await render('minkowski() { cube(10, center = true); sphere(2, $fn = 12); }');
  assert.ok(volumeOf(summed) > 1000);
});

test('projection flattens 3D to 2D', async () => {
  const shadow = await render('projection() cube(10, center = true);');
  assert.equal(shadow.geometry.dimension, 2);
  assert.ok(Math.abs(shadow.geometry.stats.area - 100) < 1e-4);

  const cut = await render('projection(cut = true) translate([0,0,-5]) cylinder(h = 10, r = 5, $fn = 64);');
  assert.equal(cut.geometry.dimension, 2);
  assert.ok(cut.geometry.stats.area > 70);
});

test('offset grows and shrinks 2D geometry', async () => {
  const base = await render('square(10, center = true);');
  const grown = await render('offset(r = 2, $fn = 64) square(10, center = true);');
  const shrunk = await render('offset(delta = -2) square(10, center = true);');
  assert.ok(grown.geometry.stats.area > base.geometry.stats.area);
  assert.ok(Math.abs(shrunk.geometry.stats.area - 36) < 1e-4);
});

test('polyhedron builds a closed solid with OpenSCAD winding', async () => {
  // A unit tetrahedron; OpenSCAD faces are clockwise seen from outside.
  const source = `
    polyhedron(
      points = [[0,0,0], [1,0,0], [0,1,0], [0,0,1]],
      faces  = [[0,1,2], [0,3,1], [0,2,3], [1,3,2]]
    );
  `;
  const result = await render(source);
  assert.ok(Math.abs(volumeOf(result) - 1 / 6) < 1e-6, 'volume should be positive, not inverted');
});

test('polygon with paths cuts a hole', async () => {
  const source = `
    polygon(
      points = [[0,0],[10,0],[10,10],[0,10], [3,3],[7,3],[7,7],[3,7]],
      paths  = [[0,1,2,3], [4,5,6,7]]
    );
  `;
  const result = await render(source);
  assert.ok(Math.abs(result.geometry.stats.area - (100 - 16)) < 1e-4);
});

test('resize scales to an explicit size, with auto preserving proportions', async () => {
  const resized = await render('resize([20, 0, 0], auto = true) cube(10);');
  const { min, max } = boundsOfResult(resized);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(max[axis] - min[axis] - 20) < 1e-4, `axis ${axis} should be 20`);
  }
});

test('color() attaches to geometry and the innermost one wins', async () => {
  const result = await render('color("red") { cube(1); color("blue") translate([2,0,0]) cube(1); }');
  assert.equal(result.geometry.parts.length, 2);
  const colors = result.geometry.parts.map((p) => p.color.slice(0, 3).join(','));
  assert.ok(colors.includes('1,0,0'), 'expected a red part');
  assert.ok(colors.includes('0,0,1'), 'expected a blue part');
});

// --- modifier roles (spec 3a) ----------------------------------------------

test('every registered role declares a legacy downgrade path', () => {
  // Spec feature 21 is enforced at registration; this guards the invariant.
  for (const role of allRoles()) {
    assert.ok(
      role.legacy.modifier || role.legacy.transpile,
      `role "${role.name}" has no legacy downgrade path`,
    );
  }
});

test('role contributions resolve with the documented precedence', () => {
  assert.equal(resolveContribution([]), 'solid');
  assert.equal(resolveContribution(['highlight']), 'solid');
  assert.equal(resolveContribution(['background']), 'annotation');
  assert.equal(resolveContribution(['negative']), 'subtractive');
  assert.equal(resolveContribution(['root']), 'isolate');
  // `disabled` beats everything: an explicitly switched-off node stays off.
  assert.equal(resolveContribution(['root', 'disabled']), 'ignored');
  assert.equal(resolveContribution(['background', 'root']), 'isolate');
});

test('* disables a subtree', async () => {
  const result = await render('cube(10); *cube(100);');
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4);
});

test('% excludes geometry from the result but keeps it as a preview annotation', async () => {
  const result = await render('cube(10); %cube(100);');
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4, '% must not contribute volume');
  assert.equal(result.geometry.annotations.length, 1, '% should appear as an annotation');
});

test('% inside a difference does not cut', async () => {
  // The classic reason % must not be a normal child: it would otherwise carve.
  const result = await render('difference() { cube(10); %translate([5,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4);
});

test('# draws an overlay and still contributes its geometry', async () => {
  // OpenSCAD's `#` is a transparent volume laid over the model, not a colour
  // applied to it. The part itself is untouched; the highlight rides alongside.
  const result = await render('#cube(10);');
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4);
  assert.equal(result.geometry.parts[0].display, 'normal');
  assert.deepEqual(result.geometry.annotations.map((a) => a.display), ['highlight']);
});

test('# on a cutter survives the cut it is marking', async () => {
  // The whole reason the modifier exists: the hole is still cut, and you can
  // see where. Recolouring the piece showed nothing, because the piece was
  // subtracted away and took the highlight with it.
  for (const source of [
    'difference() { cube(20, center = true); #cylinder(h = 30, r = 6, center = true); }',
    'cube(20); negative() #translate([10, 10, -1]) cylinder(h = 30, r = 5);',
  ]) {
    const result = await render(source);
    assert.deepEqual(
      result.geometry.annotations.map((a) => a.display),
      ['highlight'],
      `no highlight survived: ${source}`,
    );
    // And it is still a cut, not merely a picture of one.
    assert.ok(volumeOf(result) < 8000, `${source}: nothing was removed`);
  }
});

test('preview geometry is carried up once, however deep it is nested', async () => {
  // It used to be collected twice at every level — once into the scope's own
  // list and again out of the operand — so a ghost two unions deep arrived four
  // times over.
  for (const source of [
    'cube(10); %cylinder(h = 30, r = 6);',
    'union() { cube(20); %cylinder(h = 30, r = 6); }',
    'union() { union() { union() { cube(20); %cylinder(h = 30, r = 6); } } }',
  ]) {
    const result = await render(source);
    assert.equal(result.geometry.annotations.length, 1, `duplicated by: ${source}`);
  }
});

test('! renders only its subtree, discarding everything else', async () => {
  const result = await render('cube(100); translate([0,0,0]) !cube(10); sphere(50);');
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4, 'only the ! subtree should survive');
});

test('negative() subtracts from every sibling in its scope', async () => {
  // The extension the role architecture exists for (spec 3a).
  const result = await render('union() { cube(10); negative() translate([5,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(result) - 500) < 1e-4);

  // And it matches the difference() it transpiles to.
  const equivalent = await render('difference() { cube(10); translate([5,0,0]) cube(10); }');
  assert.ok(Math.abs(volumeOf(result) - volumeOf(equivalent)) < 1e-6);
});

test('negative() cuts every sibling, not just the first', async () => {
  const result = await render(`
    union() {
      cube([10, 10, 10]);
      translate([10, 0, 0]) cube([10, 10, 10]);
      negative() translate([0, 0, 5]) cube([20, 10, 10]);
    }
  `);
  assert.ok(Math.abs(volumeOf(result) - 1000) < 1e-4);
});

// --- import / export --------------------------------------------------------

test('STL round-trips through export and import', async () => {
  const result = await render('cube([2, 3, 4]);');

  for (const format of ['stl', 'stl-ascii']) {
    const file = exportResult(result.geometry, format);
    const reimported = importSTL(file.data);
    assert.equal(reimported.issues.length, 0, `${format} should re-import cleanly`);
    assert.equal(reimported.mesh.triangles.length / 3, 12, `${format} should carry 12 triangles`);
  }
});

test('OFF round-trips', async () => {
  const result = await render('cube([2, 3, 4]);');
  const file = exportResult(result.geometry, 'off');
  const reimported = importOFF(new TextDecoder().decode(file.data));
  assert.equal(reimported.issues.length, 0);
  assert.equal(reimported.mesh.triangles.length / 3, 12);
});

test('3MF is a valid ZIP container', async () => {
  const result = await render('cube(1);');
  const file = exportResult(result.geometry, '3mf');
  assert.equal(file.data[0], 0x50);
  assert.equal(file.data[1], 0x4b);
  const text = new TextDecoder().decode(file.data);
  assert.ok(text.includes('3D/3dmodel.model'));
  assert.ok(text.includes('[Content_Types].xml'));
});

test('2D formats export from 2D geometry, and refuse 3D with a useful message', async () => {
  const flat = await render('square([10, 5]);');
  const svg = exportResult(flat.geometry, 'svg');
  const svgText = new TextDecoder().decode(svg.data);
  assert.ok(svgText.startsWith('<?xml'));
  assert.ok(svgText.includes('<path'));

  const dxf = exportResult(flat.geometry, 'dxf');
  const dxfText = new TextDecoder().decode(dxf.data);
  assert.ok(dxfText.includes('LWPOLYLINE'));
  assert.ok(dxfText.trimEnd().endsWith('EOF'));

  const solid = await render('cube(1);');
  assert.throws(() => exportResult(solid.geometry, 'svg'), /projection\(\)/);
  assert.throws(() => exportResult(flat.geometry, 'stl'), /linear_extrude\(\)/);
});

test('every declared export format actually produces bytes', async () => {
  const solid = await render('cube(1);');
  const flat = await render('square(1);');
  for (const descriptor of EXPORT_FORMATS) {
    const source = descriptor.dimension === 3 ? solid : flat;
    const file = exportResult(source.geometry, descriptor.format);
    assert.ok(file.data.length > 0, `${descriptor.format} produced no bytes`);
    assert.equal(file.extension, descriptor.extension);
  }
});

test('import() brings an STL back into the scene', async () => {
  const original = await render('cube([2, 3, 4]);');
  const stl = exportResult(original.geometry, 'stl');

  const assets = { read: async (path) => (path === 'box.stl' ? stl.data : undefined) };
  const reimported = await render('import("box.stl");', { assets });
  assert.ok(Math.abs(volumeOf(reimported) - 24) < 1e-4);
});

test('surface() builds a solid from a .dat heightmap', async () => {
  const dat = '0 0 0\n0 5 0\n0 0 0\n';
  const grid = parseSurfaceDat(dat);
  assert.equal(grid.width, 3);
  assert.equal(grid.height, 3);

  const mesh = surfaceToMesh(grid);
  assert.ok(mesh.triangles.length > 0);

  const assets = { read: async () => new TextEncoder().encode(dat) };
  const result = await render('surface("hill.dat");', { assets });
  assert.ok(volumeOf(result) > 0);
});

test('$t and $preview are available to scripts', async () => {
  const result = await engine.render('echo($t, $preview);', { time: 0.25, preview: false });
  assert.ok(result.diagnostics.some((d) => d.severity === 'echo' && d.message.includes('0.25, false')));
});

test('geometry errors are reported without throwing', async () => {
  // A polyhedron with a missing face is not a closed solid.
  const result = await engine.render(`
    polyhedron(points = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], faces = [[0,2,1],[0,1,3]]);
  `);
  assert.ok(result.diagnostics.some((d) => d.severity === 'error'));
  assert.equal(result.geometry.parts.length, 0);
});

function boundsOfResult(result) {
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
  return { min, max };
}
