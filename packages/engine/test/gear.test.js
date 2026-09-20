/**
 * `gear()`: the mesh, the ring, the hand, and the guard rails.
 *
 * The claim this shape makes is narrower than "it looks like a gear": two gears
 * that share a module and a pressure angle **must** run together, at the centre
 * distance their pitch radii give, without fouling each other at any point in
 * the rotation. That is one property, and it is checked directly — the pair is
 * turned through a full tooth and the overlap measured at every step — rather
 * than by eyeballing a render of the two sitting still.
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

const PAIR = '$fn = 120;\nm = 2; h = 5;\n';

/**
 * The worst overlap between two meshing gears, turned through one whole tooth.
 *
 * Standing still proves very little: a pair can clear at the one position where
 * the teeth are symmetric about the line of centres and still jam a few degrees
 * either side. So the driver is stepped through a full angular pitch and the
 * driven gear turned back by the ratio, which is the motion the pair is for.
 */
async function worstOverlap(build, z1, z2, steps = 16) {
  const centres = (2 * (z1 + z2)) / 2;
  let worst = 0;
  for (let i = 0; i < steps; i++) {
    const turn = (360 / z1) * (i / steps);
    worst = Math.max(
      worst,
      await volume(`${PAIR}intersection() {
        rotate([0, 0, ${turn}]) ${build(z1, false)}
        translate([${centres}, 0, 0]) rotate([0, 0, ${180 - 180 / z2 - (turn * z1) / z2}])
          ${build(z2, true)}
      }`),
    );
  }
  return worst;
}

const spur = (teeth) => `gear(m = m, teeth = ${teeth}, h = h);`;

test('two gears of the same module mesh, and keep meshing as they turn', async () => {
  // Nothing was shared between the two but `m`: no pair was built together, and
  // the centre distance is the sum of the pitch radii and nothing else.
  for (const [z1, z2] of [
    [20, 20],
    [16, 31],
    [12, 45],
  ]) {
    const overlap = await worstOverlap(spur, z1, z2);
    assert.ok(overlap < 1e-6, `${z1} and ${z2} teeth foul by ${overlap} somewhere in the turn`);
  }
});

test('the centre distance is the one the pitch radii give, and not a nearby one', async () => {
  // Without this the test above would pass for a gear of any size: it is the
  // pair binding when moved that says the pitch circle is where it claims.
  const overlap = await volume(`${PAIR}intersection() {
    gear(m = m, teeth = 20, h = h);
    translate([${2 * 20 - 0.6}, 0, 0]) rotate([0, 0, ${180 - 180 / 20}])
      gear(m = m, teeth = 20, h = h);
  }`);
  assert.ok(overlap > 0.1, `brought 0.6 closer the pair should bind, overlapped by ${overlap}`);
});

test('a pinion runs inside the ring its own internal gear cuts', async () => {
  const [z1, z2] = [20, 48];
  const centres = (2 * (z2 - z1)) / 2;
  const blank = (2 * z2) / 2 + 4;
  let worst = 0;
  for (let i = 0; i < 16; i++) {
    // An internal pair turns the same way, so the ring follows the pinion
    // rather than opposing it — which is also why their helices share a hand.
    const turn = (360 / z1) * (i / 16);
    worst = Math.max(
      worst,
      await volume(`${PAIR}intersection() {
        translate([${centres}, 0, 0]) rotate([0, 0, ${turn}]) gear(m = m, teeth = ${z1}, h = h);
        rotate([0, 0, ${(turn * z1) / z2}]) difference() {
          cylinder(h = h, r = ${blank});
          gear(m = m, teeth = ${z2}, h = h, internal = true);
        }
      }`),
    );
  }
  assert.ok(worst < 1e-6, `pinion and ring foul by ${worst}`);
});

test('an internal gear is the shape a negative() wants', async () => {
  const inPlace = await measure(`${PAIR}union() {
    cylinder(h = h, r = 52);
    negative() gear(m = m, teeth = 48, h = h, internal = true);
  }`);
  const hoisted = await measure(`${PAIR}difference() {
    cylinder(h = h, r = 52);
    gear(m = m, teeth = 48, h = h, internal = true);
  }`);
  assert.ok(Math.abs(inPlace.volume - hoisted.volume) < 1e-9);
});

test('clearance is what opens the gap, and both gears give up half of it', async () => {
  // An external gear loses tooth to it and an internal one gains, which is the
  // same statement twice: the space between a mating pair grows either way.
  const external = async (c) => volume(`${PAIR}gear(m = m, teeth = 20, h = h, clearance = ${c});`);
  const internal = async (c) =>
    volume(`${PAIR}gear(m = m, teeth = 48, h = h, internal = true, clearance = ${c});`);

  const [none, some, more] = [await external(0), await external(0.2), await external(0.5)];
  assert.ok(some < none && more < some, `external gear should thin: ${none}, ${some}, ${more}`);

  const [zero, wider, widest] = [await internal(0), await internal(0.2), await internal(0.5)];
  assert.ok(zero < wider && wider < widest, `cut solid should grow: ${zero}, ${wider}, ${widest}`);
});

test('a zero-clearance pair is still assembled, exactly touching', async () => {
  const overlap = await worstOverlap(
    (teeth) => `gear(m = m, teeth = ${teeth}, h = h, clearance = 0);`,
    20,
    31,
  );
  assert.ok(overlap < 1e-6, `an exact pair should touch, not overlap; overlapped by ${overlap}`);
});

test('the tip diameter is the one the module and the tooth count give', async () => {
  // The tip is an arc, not a chord across the tooth: closing it straight would
  // plane the tip flat and quietly make the gear undersized.
  const { geometry } = await render('$fn = 120;\ngear(m = 2, teeth = 20, h = 5);');
  let widest = 0;
  const points = geometry.parts[0].mesh.positions;
  for (let i = 0; i < points.length; i += 3) {
    widest = Math.max(widest, Math.hypot(points[i], points[i + 1]));
  }
  // m * (teeth + 2) / 2 — one module of addendum past the pitch circle.
  assert.ok(Math.abs(widest - 22) < 1e-5, `tip radius ${widest}, expected 22`);
});

test('there are as many teeth as were asked for', async () => {
  // Counted off the mesh rather than off the parameter: the tips are the only
  // points out at the tip radius, so they cluster into exactly one group per
  // tooth once the list is sorted by angle.
  const teeth = 17;
  const { geometry } = await render(`$fn = 120;\ngear(m = 2, teeth = ${teeth}, h = 4);`);
  const points = geometry.parts[0].mesh.positions;
  const angles = [];
  for (let i = 0; i < points.length; i += 3) {
    if (Math.hypot(points[i], points[i + 1]) > 19 - 1e-3) {
      angles.push(Math.atan2(points[i + 1], points[i]));
    }
  }
  angles.sort((a, b) => a - b);
  // A gap bigger than half the angular pitch separates one tip from the next.
  const gap = Math.PI / teeth;
  let groups = 1;
  for (let i = 1; i < angles.length; i++) if (angles[i] - angles[i - 1] > gap) groups++;
  assert.equal(groups, teeth, `found ${groups} tips at the tip radius, expected ${teeth}`);
});

test('a helix has a hand, and the hand is what decides which gears pair', async () => {
  // An external pair turns opposite ways, so their helices must be opposite to
  // stay in step up the tooth; an internal pair turns the same way and theirs
  // must match. It is one formula either way — only the mate changes.
  const helical = (angle) => (teeth) =>
    `gear(m = m, teeth = ${teeth}, h = h, helix = ${angle});`;

  const opposed = await worstOverlap(
    (teeth, driven) => helical(driven ? -20 : 20)(teeth),
    20,
    24,
  );
  assert.ok(opposed < 1e-6, `opposite hands should mesh, fouled by ${opposed}`);

  const alike = await worstOverlap((teeth) => helical(20)(teeth), 20, 24, 4);
  assert.ok(alike > 1, `the same hand should bind, overlapped by only ${alike}`);
});

test('a helical gear is the same gear, wound up the axis', async () => {
  // A twist shears the solid without changing any cross-section, so the only
  // thing that can move the volume is the flat slicing between them — and at a
  // sane slice count that is a rounding error rather than a different gear.
  const spurVolume = await volume(`${PAIR}gear(m = m, teeth = 20, h = h);`);
  const helical = await volume(`${PAIR}gear(m = m, teeth = 20, h = h, helix = 25);`);
  assert.ok(
    Math.abs(helical - spurVolume) / spurVolume < 1e-3,
    `${helical} vs ${spurVolume} is more than the slicing can account for`,
  );

  // Right-handed for a positive angle, as a thread is: follow a tip up and the
  // angle increases. h * tan(25) / r of rise, in degrees.
  const { geometry } = await render(`${PAIR}gear(m = m, teeth = 20, h = h, helix = 25);`);
  const points = geometry.parts[0].mesh.positions;
  // Where the teeth sit within one angular pitch, averaged over every tip point
  // at that height. Averaging matters: the tip is an arc, so picking a single
  // point would measure the end of the arc rather than the tooth.
  const tipAngle = (atHeight) => {
    const pitch = 360 / 20;
    const phases = [];
    for (let i = 0; i < points.length; i += 3) {
      const [x, y, z] = [points[i], points[i + 1], points[i + 2]];
      if (Math.abs(z - atHeight) > 1e-6 || Math.hypot(x, y) < 22 - 1e-3) continue;
      const angle = (Math.atan2(y, x) * 180) / Math.PI;
      phases.push(angle - pitch * Math.round(angle / pitch));
    }
    assert.ok(phases.length >= 20, `expected tips to follow at z = ${atHeight}`);
    return phases.reduce((sum, a) => sum + a, 0) / phases.length;
  };
  const rise = ((5 * Math.tan((25 * Math.PI) / 180)) / 20) * (180 / Math.PI);
  assert.ok(Math.abs(tipAngle(5) - tipAngle(0) - rise) < 0.5, `turned ${tipAngle(5) - tipAngle(0)}, expected ${rise}`);
});

test('the legacy export is the same solid', async () => {
  const sources = [
    `${PAIR}gear(m = m, teeth = 20, h = h);`,
    `${PAIR}gear(m = m, teeth = 48, h = h, internal = true);`,
    // Past 42 teeth the root circle clears the base circle and the flank is
    // involute the whole way down, which is a different branch of the profile.
    `${PAIR}gear(m = 1.5, teeth = 47, h = 4, clearance = 0.35);`,
    `${PAIR}gear(m = m, teeth = 13, h = h, helix = 20, center = true);`,
    '$fa = 6; $fs = 0.5;\ngear(m = 1, teeth = 30, h = 3, pressure_angle = 25, segments = 200);',
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

test('center puts the gear on the origin, as cylinder does', async () => {
  const { geometry } = await render('$fn = 80;\ngear(m = 2, teeth = 20, h = 6, center = true);');
  let low = Infinity;
  let high = -Infinity;
  const points = geometry.parts[0].mesh.positions;
  for (let i = 2; i < points.length; i += 3) {
    low = Math.min(low, points[i]);
    high = Math.max(high, points[i]);
  }
  assert.ok(Math.abs(low + 3) < 1e-6 && Math.abs(high - 3) < 1e-6, `spans ${low}..${high}`);
});

test('segments floors the profile even when $fn is coarse', async () => {
  // A gear sampled as coarsely as a $fn = 6 circle is not a gear: the floor is
  // four facets per tooth, so the two below are the same shape.
  const coarse = await measure('gear(m = 2, teeth = 20, h = 4, $fn = 6);');
  const floored = await measure('gear(m = 2, teeth = 20, h = 4, segments = 80);');
  assert.ok(Math.abs(coarse.volume - floored.volume) < 1e-9);
});

test('dimensions that cannot make a gear are errors, not empty results', async () => {
  const cases = [
    ['gear(m = 0, teeth = 20, h = 5);', 'm must be greater than 0'],
    ['gear(m = 2, teeth = 2, h = 5);', 'teeth must be at least 3'],
    ['gear(m = 2, teeth = 20, h = 0);', 'h must be greater than 0'],
    ['gear(m = 2, teeth = 20, h = 5, pressure_angle = 0);', 'pressure_angle must be between'],
    ['gear(m = 2, teeth = 20, h = 5, pressure_angle = 60);', 'pressure_angle must be between'],
    ['gear(m = 2, teeth = 20, h = 5, helix = 90);', 'helix must be between'],
    ['gear(m = 2, teeth = 20, h = 5, clearance = 8);', 'the tooth vanishes'],
    ['gear(m = 2, teeth = 3, h = 5, pressure_angle = 40);', 'comes to a point'],
  ];
  for (const [source, expected] of cases) {
    const { errors } = await render(source);
    assert.ok(
      errors.some((message) => message.includes(expected)),
      `${source}\n  expected an error mentioning "${expected}", got ${JSON.stringify(errors)}`,
    );
  }
});

test('a very dense gear is reported rather than silently slow', () => {
  // Interpreting is enough: the warning is raised while the scene is built, so
  // the test does not have to pay for the geometry to see it.
  const { diagnostics } = evaluate(
    parse('gear(m = 1, teeth = 90, h = 40, helix = 35, $fn = 900);').file,
  );
  const warnings = diagnostics.items.filter((d) => d.severity === 'warning').map((d) => d.message);
  assert.ok(
    warnings.some((message) => message.includes('points of geometry')),
    `expected a density warning, got ${JSON.stringify(warnings)}`,
  );
});

test('an ordinary gear says nothing at all', async () => {
  const { warnings } = await render('$fn = 120;\ngear(m = 1, teeth = 60, h = 10);');
  assert.deepEqual(warnings, []);
});
