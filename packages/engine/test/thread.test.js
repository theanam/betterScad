/**
 * `thread()`: the fit, the downgrade, and the guard rails.
 *
 * The claim this shape makes is narrower than "it looks like a screw": a bolt
 * and the hole cut by the same call with `internal = true` **must** assemble.
 * That is one property, and it is checked directly — the cut solid has to
 * contain the bolt with nothing left over, at every clearance — rather than by
 * eyeballing a render.
 *
 * The rest holds the same line the other added shapes do: the legacy `.scad`
 * export is the construction the interpreter built, so the two are measured
 * against each other and not merely assumed to agree.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, evaluate, parse, transpileToLegacyScad } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function render(source) {
  const result = await engine.render(source);
  return {
    errors: result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    warnings: result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
    geometry: result.geometry,
  };
}

async function measure(source) {
  const { errors, geometry } = await render(source);
  assert.deepEqual(errors, [], `render failed for:\n${source}`);
  return geometry.stats;
}

/** Total volume, which is 0 for an empty result rather than undefined. */
async function volume(source) {
  return (await measure(source)).volume;
}

const M8 = '$fn = 48;\nd = 8; p = 1.25; h = 10;\n';

test('a bolt fits the hole its own internal thread cuts', async () => {
  // The cut solid has to *contain* the bolt: anything of the bolt left outside
  // it is material the nut would collide with.
  for (const clearance of [0, 0.1, 0.2, 0.4]) {
    const left = await volume(`${M8}difference() {
      thread(d = d, pitch = p, h = h);
      thread(d = d, pitch = p, h = h, internal = true, clearance = ${clearance});
    }`);
    // Not exactly zero: a boolean between two solids this size leaves rounding
    // behind. A millionth of a cubic millimetre against a 400 mm3 bolt is that
    // rounding, not a collision.
    assert.ok(left < 1e-6, `clearance ${clearance} leaves ${left} of the bolt outside the hole`);
  }
});

test('a bolt and a threaded nut do not touch', async () => {
  const interference = await volume(`${M8}intersection() {
    thread(d = d, pitch = p, h = h);
    difference() {
      cylinder(h = h, r = 7);
      thread(d = d, pitch = p, h = h, internal = true);
    }
  }`);
  assert.ok(interference < 1e-6, `bolt and nut overlap by ${interference}`);
});

test('clearance is what opens the gap, and more of it opens more', async () => {
  // End shaping off: an internal thread is countersunk and an external one
  // tapered, so leaving it on would measure the ends rather than the fit.
  const square = ', chamfer = false';
  const gap = async (clearance) =>
    (await volume(
      `${M8}thread(d = d, pitch = p, h = h, internal = true, clearance = ${clearance}${square});`,
    )) - (await volume(`${M8}thread(d = d, pitch = p, h = h${square});`));

  const [none, some, more] = [await gap(0), await gap(0.2), await gap(0.4)];
  assert.ok(Math.abs(none) < 1e-9, `at clearance 0 the pair should be one solid, differ by ${none}`);
  assert.ok(some > 0, `clearance 0.2 should grow the cut solid, grew by ${some}`);
  assert.ok(more > some, `clearance 0.4 should grow it further, ${more} vs ${some}`);
});

test('the thread is right-handed', async () => {
  // Sample the crest and follow it up. A right-hand helix rises
  // counter-clockwise, so the angle increases with height.
  const { geometry } = await render(`${M8}thread(d = d, pitch = p, h = h, chamfer = false);`);
  const bands = new Map();
  const points = geometry.parts[0].mesh.positions;
  for (let i = 0; i < points.length; i += 3) {
    const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
    if (Math.hypot(x, y) < 3.99 || z < 3 || z > 6) continue;
    const band = Math.round(z * 20) / 20;
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(Math.atan2(y, x));
  }
  const rows = [...bands.entries()].sort((a, b) => a[0] - b[0]);
  assert.ok(rows.length >= 8, 'expected a crest to follow');

  let previous;
  for (const [, angles] of rows) {
    // Mean of angles, done on the unit circle so the wrap at 180 is harmless.
    const mean = Math.atan2(
      angles.reduce((s, a) => s + Math.sin(a), 0),
      angles.reduce((s, a) => s + Math.cos(a), 0),
    );
    if (previous !== undefined) {
      let step = mean - previous;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      assert.ok(step > 0, 'crest should turn counter-clockwise as it rises');
    }
    previous = mean;
  }
});

test('the major diameter is the diameter asked for', async () => {
  // The crest is an arc, not a chord across the tooth: closing it straight
  // would plane the tip flat and quietly make the bolt undersized.
  const { geometry } = await render(`${M8}thread(d = d, pitch = p, h = h, chamfer = false);`);
  const points = geometry.parts[0].mesh.positions;
  let widest = 0;
  for (let i = 0; i < points.length; i += 3) {
    widest = Math.max(widest, Math.hypot(points[i], points[i + 1]));
  }
  assert.ok(Math.abs(widest - 4) < 1e-6, `major radius ${widest}, expected 4`);
});

test('an internal thread is the shape a negative() wants', async () => {
  // Written in place with negative(), and hoisted into a difference(): the
  // same nut either way.
  const inPlace = await measure(`${M8}union() {
    cylinder(h = h, r = 7);
    negative() thread(d = d, pitch = p, h = h, internal = true);
  }`);
  const hoisted = await measure(`${M8}difference() {
    cylinder(h = h, r = 7);
    thread(d = d, pitch = p, h = h, internal = true);
  }`);
  assert.ok(Math.abs(inPlace.volume - hoisted.volume) < 1e-9);
});

test('the legacy export is the same solid', async () => {
  const sources = [
    `${M8}thread(d = d, pitch = p, h = h);`,
    `${M8}thread(d = d, pitch = p, h = h, internal = true);`,
    `${M8}thread(d = 8, pitch = 1.25, h = 10, center = true, chamfer = false);`,
    `${M8}thread(d = 12, pitch = 1.75, h = 8, angle = 29, segments = 30);`,
    '$fa = 6; $fs = 0.4;\nthread(d = 6, pitch = 1, h = 6);',
  ];
  for (const source of sources) {
    const expected = await measure(source);
    const legacy = transpileToLegacyScad(parse(source).file, { header: false }).source;
    const actual = await measure(legacy);
    assert.ok(
      Math.abs(actual.volume - expected.volume) < 1e-9 &&
        Math.abs(actual.area - expected.area) < 1e-9,
      `${source}\n  legacy volume ${actual.volume} vs ${expected.volume}` +
        `\n  legacy area ${actual.area} vs ${expected.area}`,
    );
  }
});

test('the ends are shaped, and can be asked not to be', async () => {
  // A chamfered bolt is the smaller solid: its first and last turns run out.
  const shaped = await volume(`${M8}thread(d = d, pitch = p, h = h);`);
  const square = await volume(`${M8}thread(d = d, pitch = p, h = h, chamfer = false);`);
  assert.ok(shaped < square, `chamfered ${shaped} should be less than square ${square}`);

  // An internal one flares instead, so the countersink makes it larger.
  const flared = await volume(`${M8}thread(d = d, pitch = p, h = h, internal = true);`);
  const blunt = await volume(
    `${M8}thread(d = d, pitch = p, h = h, internal = true, chamfer = false);`,
  );
  assert.ok(flared > blunt, `countersunk ${flared} should exceed blunt ${blunt}`);
});

test('center puts the thread on the origin, as cylinder does', async () => {
  const { geometry } = await render(`${M8}thread(d = d, pitch = p, h = h, center = true);`);
  let low = Infinity;
  let high = -Infinity;
  const points = geometry.parts[0].mesh.positions;
  for (let i = 2; i < points.length; i += 3) {
    low = Math.min(low, points[i]);
    high = Math.max(high, points[i]);
  }
  assert.ok(Math.abs(low + 5) < 1e-6 && Math.abs(high - 5) < 1e-6, `spans ${low}..${high}`);
});

test('dimensions that cannot make a thread are errors, not empty results', async () => {
  const cases = [
    ['thread(d = 0, pitch = 1, h = 5);', 'd must be greater than 0'],
    ['thread(d = 8, pitch = 0, h = 5);', 'pitch must be greater than 0'],
    ['thread(d = 8, pitch = 1, h = 0);', 'h must be greater than 0'],
    ['thread(d = 8, pitch = 1, h = 5, angle = 0);', 'angle must be between 0 and 180'],
    ['thread(d = 1, pitch = 4, h = 5);', 'too coarse'],
    ['thread(d = 8, pitch = 1, h = 5, internal = true, clearance = 3);', 'groove closes up'],
  ];
  for (const [source, expected] of cases) {
    const { errors } = await render(source);
    assert.ok(
      errors.some((message) => message.includes(expected)),
      `${source}\n  expected an error mentioning "${expected}", got ${JSON.stringify(errors)}`,
    );
  }
});

test('a very dense thread is reported rather than silently slow', () => {
  // Interpreting is enough: the warning is raised while the scene is built, so
  // the test does not have to pay for the geometry to see it.
  const { diagnostics } = evaluate(parse('thread(d = 40, pitch = 0.5, h = 60, $fn = 120);').file);
  const warnings = diagnostics.items.filter((d) => d.severity === 'warning').map((d) => d.message);
  assert.ok(
    warnings.some((message) => message.includes('slices')),
    `expected a density warning, got ${JSON.stringify(warnings)}`,
  );
});

test('segments floors the sweep even when $fn is coarse', async () => {
  // A thread sampled as coarsely as a $fn = 6 circle is not a thread.
  const coarse = await measure('thread(d = 8, pitch = 1.25, h = 5, $fn = 6);');
  const floored = await measure('thread(d = 8, pitch = 1.25, h = 5, segments = 24);');
  assert.ok(Math.abs(coarse.volume - floored.volume) < 1e-9);
});
