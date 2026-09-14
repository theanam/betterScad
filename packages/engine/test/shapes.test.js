/**
 * The added shapes: `rounded_square`, `rounded_cube`, `regular_polygon`.
 *
 * Each is defined in the interpreter as the scene subtree its legacy export
 * prints, so the downgrade is equivalent by construction rather than by two
 * implementations happening to agree. These tests are what holds that: every
 * shape is checked against the stock spelling it claims to be, and then against
 * its own export.
 *
 * They also pin the generated file's shape. A helper module is emitted once and
 * called, however many times the shape is used, and it never takes a name the
 * source already declares.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, describeExtensions, parse, transpileToLegacyScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function measure(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);

  // 3D geometry arrives as meshes, 2D as contours, so both are walked.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const see = (x, y, z) => {
    const p = [x, y, z];
    for (let axis = 0; axis < 3; axis++) {
      if (p[axis] < min[axis]) min[axis] = p[axis];
      if (p[axis] > max[axis]) max[axis] = p[axis];
    }
  };
  for (const part of result.geometry.parts) {
    for (let i = 0; i < part.mesh.positions.length; i += 3) {
      see(part.mesh.positions[i], part.mesh.positions[i + 1], part.mesh.positions[i + 2]);
    }
  }
  for (const shape of result.geometry.contours2d ?? []) {
    for (const contour of shape.contours) for (const [x, y] of contour) see(x, y, 0);
  }
  const { volume, area } = result.geometry.stats;
  return { bounds: [...min, ...max], volume, area };
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

/** Same geometry as the stock spelling, and the export says so too. */
async function equivalent(sugar, stock) {
  const expected = await measure(stock);
  const actual = await measure(sugar);
  assert.ok(
    actual.bounds.every((v, i) => near(v, expected.bounds[i], 1e-6)),
    `${sugar}\n  bounds ${actual.bounds}\n  expected ${expected.bounds}`,
  );
  assert.ok(near(actual.volume, expected.volume, 1e-6), `${sugar}: volume ${actual.volume} vs ${expected.volume}`);
  assert.ok(near(actual.area, expected.area, 1e-6), `${sugar}: area ${actual.area} vs ${expected.area}`);

  const legacy = transpileToLegacyScad(parse(sugar).file, { header: false }).source;
  const exported = await measure(legacy);
  assert.ok(
    exported.bounds.every((v, i) => near(v, expected.bounds[i], 1e-6)) &&
      near(exported.volume, expected.volume, 1e-6) &&
      near(exported.area, expected.area, 1e-6),
    `the export of ${sugar} differs:\n  ${exported.bounds} vol ${exported.volume} area ${exported.area}\n` +
      `  expected ${expected.bounds} vol ${expected.volume} area ${expected.area}\n${legacy}`,
  );
}

// --- rounded_square ---------------------------------------------------------

test('rounded_square is a hull of corner circles', async () => {
  await equivalent(
    '$fn = 32;\nrounded_square([30, 20], 5, center = true);',
    `$fn = 32;
     hull() for (x = [-1, 1], y = [-1, 1])
       translate([x * 10, y * 5]) circle(r = 5);`,
  );
});

test('rounded_square sits in the positive quadrant unless centred', async () => {
  const { bounds } = await measure('$fn = 64;\nrounded_square([30, 20], 5);');
  const slack = 0.02;
  assert.ok(bounds.slice(0, 2).every((v) => near(v, 0, slack)), `expected a corner at the origin, got ${bounds}`);
  assert.ok(near(bounds[3], 30, slack) && near(bounds[4], 20, slack), `expected 30 x 20, got ${bounds}`);
});

test('the area is the rounded rectangle it claims to be', async () => {
  // Independent of how it is built: a w x h rectangle with r-rounded corners
  // loses exactly (4 - PI) r^2 to the corners.
  const { area } = await measure('$fn = 256;\nrounded_square([30, 20], 5);');
  const expected = 30 * 20 - (4 - Math.PI) * 25;
  assert.ok(Math.abs(area - expected) / expected < 1e-3, `area ${area}, expected ${expected}`);
});

test('a scalar size is square', async () => {
  await equivalent('$fn = 24;\nrounded_square(20, 4);', '$fn = 24;\nrounded_square([20, 20], 4);');
});

test('r = 0 is a plain square', async () => {
  await equivalent('rounded_square([8, 5], 0);', 'square([8, 5]);');
  await equivalent('rounded_square([8, 5], 0, center = true);', 'square([8, 5], center = true);');
});

test('a radius past half the shortest side is clamped, with a warning', async () => {
  // Left alone it would ask for a square with a negative straight section.
  const result = await engine.render('$fn = 32;\nrounded_square([10, 6], 50);');
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'warning' && /larger than half/.test(d.message)),
    'expected a clamp warning',
  );
  // Clamped to 3 the corners meet, so the shape is a 10 x 6 stadium. This is
  // the case an offset-of-inset-square construction cannot build at all: the
  // square it grows from would be zero-height.
  const { bounds, area } = await measure('$fn = 256;\nrounded_square([10, 6], 50);');
  assert.ok(near(bounds[3] - bounds[0], 10, 0.02) && near(bounds[4] - bounds[1], 6, 0.02), `got ${bounds}`);
  const stadium = 4 * 6 + Math.PI * 9; // a 4 x 6 rectangle plus two half-discs
  assert.ok(Math.abs(area - stadium) / stadium < 1e-3, `area ${area}, expected a stadium ${stadium}`);
});

// --- rounded_cube -----------------------------------------------------------

test('rounded_cube is a hull of corner spheres', async () => {
  await equivalent(
    '$fn = 24;\nrounded_cube([20, 14, 8], 3, center = true);',
    `$fn = 24;
     hull() for (x = [-1, 1], y = [-1, 1], z = [-1, 1])
       translate([x * 7, y * 4, z * 1]) sphere(r = 3);`,
  );
});

test('rounded_cube sits in the positive octant unless centred', async () => {
  const { bounds } = await measure('$fn = 24;\nrounded_cube([20, 14, 8], 3);');
  // Loose, because a tessellated sphere's vertices sit just inside its radius,
  // so the hull comes out a hair under the nominal size — as it does in stock
  // OpenSCAD too. The point here is the corner's position, not the rounding.
  const slack = 0.05;
  assert.ok(
    bounds.slice(0, 3).every((v) => near(v, 0, slack)),
    `expected a corner at the origin, got ${bounds}`,
  );
  assert.ok(
    near(bounds[3], 20, slack) && near(bounds[4], 14, slack) && near(bounds[5], 8, slack),
    `expected 20 x 14 x 8, got ${bounds}`,
  );
});

test('a scalar size is a cube, and r = 0 is a plain one', async () => {
  await equivalent('$fn = 16;\nrounded_cube(10, 2);', '$fn = 16;\nrounded_cube([10, 10, 10], 2);');
  await equivalent('rounded_cube([6, 4, 2], 0);', 'cube([6, 4, 2]);');
  await equivalent('rounded_cube(6, 0, center = true);', 'cube(6, center = true);');
});

// --- regular_polygon --------------------------------------------------------

test('regular_polygon is a circle at the circumradius', async () => {
  // A hexagon of side 10 has circumradius 10.
  await equivalent('regular_polygon(6, 10);', 'circle(r = 10, $fn = 6);');
  await equivalent('regular_polygon(3, 12);', `circle(r = ${12 / (2 * Math.sin(Math.PI / 3))}, $fn = 3);`);
});

test('every side really is the length asked for', async () => {
  for (const [sides, length] of [[3, 7], [5, 4], [8, 3], [17, 2]]) {
    const { area } = await measure(`regular_polygon(${sides}, ${length});`);
    // Area of a regular polygon from its side length.
    const expected = (sides * length * length) / (4 * Math.tan(Math.PI / sides));
    assert.ok(
      Math.abs(area - expected) / expected < 1e-6,
      `${sides}-gon of side ${length}: area ${area}, expected ${expected}`,
    );
  }
});

test('a shape that cannot close is an error, not a guess', async () => {
  for (const source of ['regular_polygon(2, 10);', 'regular_polygon(0, 10);', 'regular_polygon(-4, 10);']) {
    const result = await engine.render(source);
    assert.ok(
      result.diagnostics.some((d) => d.severity === 'error' && /at least 3 sides/.test(d.message)),
      `expected an error for ${source}`,
    );
  }
  for (const source of ['regular_polygon(6, 0);', 'regular_polygon(6, -3);']) {
    const result = await engine.render(source);
    assert.ok(
      result.diagnostics.some((d) => d.severity === 'error' && /side length/.test(d.message)),
      `expected an error for ${source}`,
    );
  }
});

// --- what the export looks like ---------------------------------------------

test('a shape used many times defines its module once', async () => {
  const source = `for (i = [0:4]) translate([i * 12, 0, 0]) rounded_square(10, 2);
rounded_square([20, 8], 3, center = true);`;
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;

  assert.equal(
    legacy.match(/module __rounded_square\(/g)?.length,
    1,
    `expected exactly one definition:\n${legacy}`,
  );
  assert.equal(
    legacy.match(/__rounded_square\(/g)?.length,
    3,
    `expected one definition and two calls:\n${legacy}`,
  );
  // The body keeps its shape: a loop is still a loop, a call still a call.
  assert.ok(/for \(i = \[0 : 4\]\)/.test(legacy), `the loop was not preserved:\n${legacy}`);
});

test('only the shapes actually used are defined', async () => {
  const legacy = transpileToLegacyScad(parse('regular_polygon(5, 4);').file, { header: false }).source;
  assert.ok(/module __regular_polygon\(/.test(legacy));
  assert.ok(!/__rounded_square|__rounded_cube/.test(legacy), `defined something unused:\n${legacy}`);
});

test('a helper never shadows a module the file already declares', async () => {
  const source = `module __rounded_square(a) { cube(a); }
rounded_square(10, 2);
__rounded_square(3);`;
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.ok(/module __rounded_square_2\(/.test(legacy), `expected a renamed helper:\n${legacy}`);
  // The user's own module and its call survive untouched.
  assert.ok(/module __rounded_square\(a\)/.test(legacy));
  assert.equal(legacy.match(/^\s*__rounded_square\(3\);/m)?.length, 1);
});

test('the export is stock, and stays stock on a second pass', async () => {
  const source = '$fn = 24;\nrounded_cube([10, 8, 6], 2);\nregular_polygon(6, 5);\n';
  const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
  assert.ok(!/(^|[^_\w])rounded_cube\(|(^|[^_\w])regular_polygon\(/.test(legacy), `sugar survived:\n${legacy}`);
  assert.deepEqual(describeExtensions(parse(legacy).file), []);
});

test('the new shapes are reported as extensions', async () => {
  const source = 'rounded_square(4, 1);\nrounded_cube(4, 1);\nregular_polygon(5, 2);';
  const names = describeExtensions(parse(source).file).map((e) => e.name).sort();
  assert.deepEqual(names, ['regular_polygon()', 'rounded_cube()', 'rounded_square()']);
});
