/**
 * Tracing a mask into outlines.
 *
 * Masks are drawn here as pixels, so the shapes are known exactly: a box
 * should come back as four lines, a disc as a few curves, a frame as a ring
 * with a hole in it, and a speck as nothing at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSketch } from '../src/sketch/doc.js';
import { flattenSketch } from '../src/sketch/flatten.js';
import { simplifyRun, traceLoops, vectorizeMask } from '../src/sketch/trace/vectorize.js';

function mask(width, height, inside) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = inside(x, y) ? 255 : 0;
  return { data, width, height };
}

const identity = { toBoard: (x, y) => [x, y] };

test('a filled box traces to one closed line run with four corners', () => {
  const m = mask(40, 30, (x, y) => x >= 5 && x < 25 && y >= 5 && y < 20);
  const nodes = vectorizeMask(m, identity);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'poly');
  assert.equal(nodes[0].points.length, 4);
  const xs = nodes[0].points.map((p) => p[0]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [5, 25]);
});

test('a disc traces to a curved path, not a polygon of pixels', () => {
  const m = mask(100, 100, (x, y) => Math.hypot(x + 0.5 - 50, y + 0.5 - 50) <= 30);
  const nodes = vectorizeMask(m, identity);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'path');
  assert.ok(nodes[0].anchors.length <= 10, `few anchors, not ${nodes[0].anchors.length}`);
  assert.ok(nodes[0].anchors.some((a) => a.out), 'it is made of curves');
  // The area of what it encloses is close to the disc's.
  const ring = flattenSketch(normalizeSketch({ nodes })).rings[0];
  assert.ok(Math.abs(Math.abs(ring.area) - Math.PI * 900) < Math.PI * 900 * 0.03, `area ${ring.area}`);
});

test('a frame gives a ring and its hole, and the hole is read as one', () => {
  const m = mask(60, 60, (x, y) => x >= 5 && x < 55 && y >= 5 && y < 55 && !(x >= 20 && x < 40 && y >= 20 && y < 40));
  const nodes = vectorizeMask(m, identity);
  assert.equal(nodes.length, 2);
  const { rings } = flattenSketch(normalizeSketch({ nodes }));
  assert.deepEqual(rings.map((r) => r.status).sort(), ['hole', 'solid']);
});

test('specks are dropped and two regions touching at a corner stay two', () => {
  const m = mask(30, 30, (x, y) => (x === 2 && y === 2) || (x < 10 && y < 10 && x >= 4 && y >= 4) || (x >= 10 && y >= 10 && x < 16 && y < 16));
  const loops = traceLoops(m);
  assert.equal(loops.length, 3);
  assert.equal(vectorizeMask(m, identity).length, 2);
});

test('the board mapping flips y and scales', () => {
  const m = mask(20, 20, (x, y) => x >= 0 && x < 10 && y >= 0 && y < 10);
  const nodes = vectorizeMask(m, { toBoard: (x, y) => [x * 2, (20 - y) * 2] });
  const ys = nodes[0].points.map((p) => p[1]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [20, 40]);
});

test('simplification keeps a straight run to its ends', () => {
  const run = Array.from({ length: 50 }, (_, i) => [i, i % 2 === 0 ? 0 : 0.4]);
  assert.equal(simplifyRun(run, 1).length, 2);
});

test('ink: a two-tone picture splits at its dark tone, and the marks are the mask', async () => {
  const { inkMask } = await import('../src/sketch/trace/ink.js');
  const width = 40;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const dark = i % width < 10;
    data.set([dark ? 0 : 255, dark ? 0 : 255, dark ? 0 : 255, 255], i * 4);
  }
  const mask = inkMask({ data, width, height });
  assert.equal(mask.data[0], 255);
  assert.equal(mask.data[20], 0);
  assert.equal(vectorizeMask(mask, identity).length, 1);
});

test('a loop whose curves would cross comes back as a polygon, never a crossing path', () => {
  // A disc with a slot one pixel wide: the fit around the notch is where overshoot happens.
  const m = mask(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 45 && !(x === 60 && y > 60));
  const nodes = vectorizeMask(m, identity);
  assert.equal(nodes.length, 1);
  const ring = flattenSketch(normalizeSketch({ nodes })).rings[0];
  assert.notEqual(ring.status, 'crossing');
});
