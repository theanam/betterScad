/**
 * The drawing board's booleans: the cell under a click, and a group's
 * material once its cuts are taken out.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { clipPolygons, loadKernel } from '../dist/index.js';

let api;
before(async () => {
  api = await loadKernel();
});

const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const area = (polygons) => polygons.reduce((sum, poly) => sum + poly.reduce((a, [x1, y1], i) => { const [x2, y2] = poly[(i + 1) % poly.length]; return a + (x1 * y2 - x2 * y1); }, 0) / 2, 0);

test('region: the overlap of two squares, minus a third', () => {
  const a = square(0, 0, 10);
  const b = square(5, 0, 10);
  const lens = clipPolygons(api, { op: 'region', inside: [[a], [b]], outside: [] });
  assert.ok(Math.abs(area(lens) - 50) < 1e-6);
  const nicked = clipPolygons(api, { op: 'region', inside: [[a], [b]], outside: [[square(5, 0, 2)]] });
  assert.ok(Math.abs(area(nicked) - 46) < 1e-6);
});

test('material: islands union, holes stay holes, cuts are taken out', () => {
  const plate = [square(0, 0, 20), square(5, 5, 4)];
  const other = [square(15, 0, 10)];
  const whole = clipPolygons(api, { op: 'material', inside: [plate, other], outside: [] });
  assert.ok(Math.abs(area(whole) - 434) < 1e-6, `area ${area(whole)}`);
  const cut = clipPolygons(api, { op: 'material', inside: [plate, other], outside: [[square(0, 0, 10)]] });
  assert.ok(Math.abs(area(cut) - 350) < 1e-6, `area ${area(cut)}`);
  // A cut with a hole in it leaves the hole's material standing.
  const ringCut = clipPolygons(api, { op: 'material', inside: [[square(0, 0, 20)]], outside: [[square(2, 2, 10), square(4, 4, 2)]] });
  assert.ok(Math.abs(area(ringCut) - (400 - 100 + 4)) < 1e-6, `area ${area(ringCut)}`);
});

test('nothing in gives nothing out', () => {
  assert.deepEqual(clipPolygons(api, { op: 'region', inside: [], outside: [] }), []);
});
