/**
 * "Vary colours": every item its own colour, so two that touch can be told
 * apart in the preview.
 *
 * An item is a top-level shape, or everything one `union()` holds — the source
 * saying "these are one thing". A colour the source sets is the model's and
 * stays. Off, nothing changes at all.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { DEFAULT_COLOR, Engine, ITEM_COLORS } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

const key = (c) => c.join(',');

async function colors(source, options = {}) {
  const result = await engine.render(source, { preview: true, varyColors: true, ...options });
  return result.geometry.parts.map((p) => key(p.color));
}

test('two touching shapes get two colours, in the order they are written', async () => {
  assert.deepEqual(await colors('cube(10);\ntranslate([10,0,0]) cube(10);\n'), [
    key(ITEM_COLORS[0]),
    key(ITEM_COLORS[1]),
  ]);
});

test('everything in one union() is one item', async () => {
  const got = await colors('union() { cube(10); translate([10,0,0]) sphere(4); }\ncylinder(h=5, r=2);\n');
  assert.equal(got.length, 3);
  assert.equal(got[0], got[1]);
  assert.notEqual(got[0], got[2]);
});

test('the outermost union() wins over one inside it', async () => {
  const got = await colors('union() { union() { cube(1); sphere(1); } cylinder(h=1, r=1); }\n');
  assert.equal(new Set(got).size, 1);
});

test('a union() stays one item through transforms and a difference', async () => {
  const got = await colors(
    'difference() {\n  translate([0,0,1]) union() { cube(10); translate([10,0,0]) cube(10); }\n  sphere(3);\n}\ncube(2);\n',
  );
  assert.equal(got.length, 3);
  assert.equal(got[0], got[1]);
  assert.notEqual(got[0], got[2]);
});

test('a plain group is not a union: its shapes are items of their own', async () => {
  const got = await colors('translate([0,0,0]) { cube(1); sphere(1); }\n');
  assert.notEqual(got[0], got[1]);
});

test('a colour the source sets is kept', async () => {
  const got = await colors('color("red") cube(10);\ntranslate([10,0,0]) cube(10);\n');
  assert.equal(got[0], key([1, 0, 0, 1]));
  // The first item without a colour of its own still starts the palette.
  assert.equal(got[1], key(ITEM_COLORS[0]));
});

test('off by default: every shape keeps the default colour', async () => {
  const result = await engine.render('cube(10);\ntranslate([10,0,0]) cube(10);\n', { preview: true });
  assert.deepEqual(
    result.geometry.parts.map((p) => key(p.color)),
    [key(DEFAULT_COLOR), key(DEFAULT_COLOR)],
  );
});

test('a final render keeps the items apart instead of merging them into one', async () => {
  const got = await colors('cube(10);\ntranslate([5,0,0]) cube(10);\n', { preview: false });
  assert.equal(got.length, 2);
  assert.notEqual(got[0], got[1]);
});

test('flat shapes are varied too', async () => {
  const result = await engine.render('square(10);\ntranslate([10,0]) circle(3);\n', { varyColors: true });
  const got = result.geometry.contours2d.map((c) => key(c.color));
  assert.deepEqual(got, [key(ITEM_COLORS[0]), key(ITEM_COLORS[1])]);
});

test('an extruded union() is still one item', async () => {
  const got = await colors('linear_extrude(2) union() { square(5); translate([5,0]) square(5); }\ncube(1);\n');
  assert.equal(got.length, 3);
  assert.equal(got[0], got[1]);
  assert.notEqual(got[0], got[2]);
});
