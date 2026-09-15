/**
 * The added shape arguments and shapes: `square(r)`, `cube(r)`,
 * `cylinder(fillet)`, `regular_polygon`.
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

// --- square(r) --------------------------------------------------------------

test('square(r) is a hull of corner circles', async () => {
  await equivalent(
    '$fn = 32;\nsquare([30, 20], center = true, r = 5);',
    `$fn = 32;
     hull() for (x = [-1, 1], y = [-1, 1])
       translate([x * 10, y * 5]) circle(r = 5);`,
  );
});

test('square(r) sits in the positive quadrant unless centred', async () => {
  const { bounds } = await measure('$fn = 64;\nsquare([30, 20], r = 5);');
  const slack = 0.02;
  assert.ok(bounds.slice(0, 2).every((v) => near(v, 0, slack)), `expected a corner at the origin, got ${bounds}`);
  assert.ok(near(bounds[3], 30, slack) && near(bounds[4], 20, slack), `expected 30 x 20, got ${bounds}`);
});

test('the area is the rounded rectangle it claims to be', async () => {
  // Independent of how it is built: a w x h rectangle with r-rounded corners
  // loses exactly (4 - PI) r^2 to the corners.
  const { area } = await measure('$fn = 256;\nsquare([30, 20], r = 5);');
  const expected = 30 * 20 - (4 - Math.PI) * 25;
  assert.ok(Math.abs(area - expected) / expected < 1e-3, `area ${area}, expected ${expected}`);
});

test('a scalar size is square', async () => {
  await equivalent('$fn = 24;\nsquare(20, r = 4);', '$fn = 24;\nsquare([20, 20], r = 4);');
});

test('r = 0, or no r at all, is a plain square', async () => {
  await equivalent('square([8, 5], r = 0);', 'square([8, 5]);');
  await equivalent('square([8, 5], center = true, r = 0);', 'square([8, 5], center = true);');
});

test('a square with no r exports byte for byte', async () => {
  // The whole point of folding the radius into `square` rather than adding a
  // shape beside it: a file that does not round anything is still stock.
  const source = 'square([8, 5], center = true);\n';
  const legacy = transpileToLegacyScad(parse(source).file, { header: false });
  assert.deepEqual(describeExtensions(parse(source).file), []);
  assert.equal(legacy.source.trim(), source.trim());
});

test('a radius past half the shortest side is clamped, with a warning', async () => {
  // Left alone it would ask for a square with a negative straight section.
  const result = await engine.render('$fn = 32;\nsquare([10, 6], r = 50);');
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'warning' && /larger than half/.test(d.message)),
    'expected a clamp warning',
  );
  // Clamped to 3 the corners meet, so the shape is a 10 x 6 stadium. This is
  // the case an offset-of-inset-square construction cannot build at all: the
  // square it grows from would be zero-height.
  const { bounds, area } = await measure('$fn = 256;\nsquare([10, 6], r = 50);');
  assert.ok(near(bounds[3] - bounds[0], 10, 0.02) && near(bounds[4] - bounds[1], 6, 0.02), `got ${bounds}`);
  const stadium = 4 * 6 + Math.PI * 9; // a 4 x 6 rectangle plus two half-discs
  assert.ok(Math.abs(area - stadium) / stadium < 1e-3, `area ${area}, expected a stadium ${stadium}`);
});

// --- cube(r) ----------------------------------------------------------------

test('cube(r) is a hull of corner spheres', async () => {
  await equivalent(
    '$fn = 24;\ncube([20, 14, 8], center = true, r = 3);',
    `$fn = 24;
     hull() for (x = [-1, 1], y = [-1, 1], z = [-1, 1])
       translate([x * 7, y * 4, z * 1]) sphere(r = 3);`,
  );
});

test('cube(r) sits in the positive octant unless centred', async () => {
  const { bounds } = await measure('$fn = 24;\ncube([20, 14, 8], r = 3);');
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
  await equivalent('$fn = 16;\ncube(10, r = 2);', '$fn = 16;\ncube([10, 10, 10], r = 2);');
  await equivalent('cube([6, 4, 2], r = 0);', 'cube([6, 4, 2]);');
  await equivalent('cube(6, center = true, r = 0);', 'cube(6, center = true);');
});

test('r is the third argument, after the two cube has always had', async () => {
  // `cube(10, true)` has meant one thing since OpenSCAD was written, so the
  // radius goes after it rather than in front.
  await equivalent('$fn = 16;\ncube(10, true, 2);', '$fn = 16;\ncube(10, center = true, r = 2);');
});

test('the shapes it replaced say what to write instead', async () => {
  for (const [source, expected] of [
    ['rounded_cube(10, 2);', /cube\(size, center, r\)/],
    ['rounded_square([10, 6], 2);', /square\(size, center, r\)/],
  ]) {
    const result = await engine.render(source);
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    assert.ok(errors.some((d) => expected.test(d.message)), `${source}: got ${JSON.stringify(errors)}`);
  }
});

// --- cylinder(fillet) -------------------------------------------------------

test('no fillet is the stock cylinder, and exports byte for byte', async () => {
  await equivalent('cylinder(h = 10, r = 4, fillet = 0, $fn = 16);', 'cylinder(h = 10, r = 4, $fn = 16);');

  const source = 'cylinder(h = 10, r = 4, $fn = 16);\n';
  assert.deepEqual(describeExtensions(parse(source).file), []);
  assert.equal(transpileToLegacyScad(parse(source).file, { header: false }).source.trim(), source.trim());
});

test('a rounded fillet removes the volume a quarter-torus occupies', async () => {
  // Independent of the construction: rounding one end of a cylinder of radius
  // R by f removes the difference between the f-square corner ring and the
  // quarter-disc inside it, swept about the axis. Pappus gives that exactly.
  const R = 8;
  const f = 2;
  const { volume } = await measure(`$fn = 512;\ncylinder(h = 20, r = ${R}, fillet1 = ${f});`);

  const square = f * f;
  const quarter = (Math.PI * f * f) / 4;
  // Centroids, measured from the axis: the corner square's is at R - f/2, the
  // quarter disc's at R - f + 4f/(3*PI).
  const removed =
    2 * Math.PI * ((square * (R - f / 2)) - (quarter * (R - f + (4 * f) / (3 * Math.PI))));
  const expected = Math.PI * R * R * 20 - removed;
  assert.ok(Math.abs(volume - expected) / expected < 1e-3, `volume ${volume}, expected ${expected}`);
});

test('a chamfer is the chord across the same two tangent points', async () => {
  // Which makes it a truncated cone of height f meeting the wall at 45 degrees.
  const R = 8;
  const f = 3;
  const { volume } = await measure(`$fn = 512;\ncylinder(h = 20, r = ${R}, fillet1 = ${f}, fillet_style = "chamfer");`);
  const cone = (Math.PI * f * (R * R + R * (R - f) + (R - f) * (R - f))) / 3;
  const expected = Math.PI * R * R * (20 - f) + cone;
  assert.ok(Math.abs(volume - expected) / expected < 1e-3, `volume ${volume}, expected ${expected}`);
});

test('fillet sets both ends and fillet1 / fillet2 override each', async () => {
  await equivalent(
    '$fn = 48;\ncylinder(h = 12, r = 5, fillet = 1.5);',
    '$fn = 48;\ncylinder(h = 12, r = 5, fillet1 = 1.5, fillet2 = 1.5);',
  );
  // 1 is the bottom and 2 the top, the same way round as r1 and r2.
  const low = await measure('$fn = 48;\ncylinder(h = 12, r1 = 5, r2 = 5, fillet1 = 2);');
  const high = await measure('$fn = 48;\ncylinder(h = 12, r1 = 5, r2 = 5, fillet2 = 2);');
  assert.ok(near(low.volume, high.volume, 1e-6), 'a symmetric cylinder loses the same either end');
  assert.ok(!near(low.bounds[2], high.bounds[2], 1e-9) === false, 'both keep the full height');
});

test('the fillet follows a taper rather than assuming a right angle', async () => {
  // On a cone the corner is not 90 degrees, so a quarter circle would not meet
  // both edges. The test that it does: the result is still tangent, so its
  // volume sits between the unfilleted cone and one chamfered by the same f.
  const plain = await measure('$fn = 256;\ncylinder(h = 20, r1 = 12, r2 = 4);');
  const round = await measure('$fn = 256;\ncylinder(h = 20, r1 = 12, r2 = 4, fillet = 2);');
  const cham = await measure('$fn = 256;\ncylinder(h = 20, r1 = 12, r2 = 4, fillet = 2, fillet_style = "chamfer");');
  assert.ok(round.volume < plain.volume, 'a fillet removes material');
  assert.ok(cham.volume < round.volume, 'a chamfer removes more than the arc inside it');
});

test('a fillet larger than the end it eases is clamped, with a warning', async () => {
  const result = await engine.render('$fn = 32;\ncylinder(h = 10, r = 3, fillet = 40);');
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'warning' && /does not fit/.test(d.message)),
    'expected a clamp warning',
  );
});

test('centre still centres, with the fillet on', async () => {
  const { bounds } = await measure('$fn = 64;\ncylinder(h = 20, r = 6, center = true, fillet = 2);');
  assert.ok(near(bounds[2], -10, 0.02) && near(bounds[5], 10, 0.02), `expected -10..10, got ${bounds}`);
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
