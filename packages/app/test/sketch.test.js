/**
 * The drawing tool's document, and the SVG it becomes.
 *
 * The SVG is checked by reading it back through the engine's import, because
 * that is the only reader that matters: what the file says it is has to be
 * what `import()` makes of it.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '@betterscad/engine';

import { digestSketch, normalizeSketch, scaleNode, translateNode } from '../src/sketch/doc.js';
import { boundsOfSketch, flattenSketch } from '../src/sketch/flatten.js';
import { gripsOf, isSmooth, moveGrip } from '../src/sketch/nodes.js';
import { exactBounds, fromContours, fromSvg, toSvg } from '../src/sketch/svg.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function areaOf(svg) {
  const result = await engine.render('linear_extrude(1) import("d.svg");', {
    file: 'main.scad',
    preview: false,
    assets: { read: async () => new TextEncoder().encode(svg) },
  });
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), []);
  return result.geometry.stats.volume;
}

const plate = { kind: 'rect', x: 0, y: 0, w: 40, h: 20, r: 0 };
const hole = { kind: 'circle', cx: 10, cy: 10, r: 3 };

test('normalize rounds, clamps a radius, and rejects what is not a drawing', () => {
  const doc = normalizeSketch({ nodes: [{ kind: 'rect', x: 0.00049, y: 0, w: 10, h: 4, r: 9 }] });
  assert.deepEqual(doc.nodes[0], { kind: 'rect', x: 0, y: 0, w: 10, h: 4, r: 2 });
  assert.throws(() => normalizeSketch({ nodes: [{ kind: 'blob' }] }), /Unknown outline/);
  assert.throws(() => normalizeSketch({ nodes: [{ kind: 'circle', cx: 'a', cy: 0, r: 1 }] }), /not a number/);
});

test('a ring inside a ring is a hole; inside two it is material again', () => {
  const doc = normalizeSketch({
    nodes: [plate, hole, { kind: 'circle', cx: 10, cy: 10, r: 1 }, { kind: 'poly', points: [[0, 0], [5, 5]], closed: false }],
  });
  const { rings, islands } = flattenSketch(doc);
  assert.deepEqual(rings.map((r) => r.status), ['solid', 'hole', 'solid', 'open']);
  assert.equal(islands.length, 2);
  assert.deepEqual(islands[0].holes.map((h) => h.node), [1]);
  assert.deepEqual(boundsOfSketch(doc), { minX: 0, minY: 0, maxX: 40, maxY: 20 });
});

test('a figure of eight is crossing, not tiny', () => {
  const doc = normalizeSketch({ nodes: [{ kind: 'poly', points: [[0, 0], [10, 10], [10, 0], [0, 10]], closed: true }] });
  assert.equal(flattenSketch(doc).rings[0].status, 'crossing');
});

test('the SVG round-trips the document exactly', () => {
  const doc = normalizeSketch({
    nodes: [
      { kind: 'rect', x: -5, y: 2, w: 30, h: 12, r: 2.5 },
      { kind: 'path', anchors: [{ x: 0, y: 0, out: [5, 5] }, { x: 20, y: 0, in: [-5, 5] }], closed: true },
    ],
  });
  const { text, width, height } = toSvg(doc);
  assert.deepEqual(fromSvg(text), doc);
  assert.equal(digestSketch(fromSvg(text)), digestSketch(doc));
  assert.ok(text.includes('width="30mm"'), 'declares its size in millimetres');
  assert.equal(width, 30);
  assert.equal(height, 14);
  assert.equal(fromSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0h1v1z"/></svg>'), undefined);
});

test('import() reads the file as the drawing: holes cut, overlaps merge', async () => {
  const framed = toSvg(normalizeSketch({ nodes: [plate, hole] }));
  assert.ok(Math.abs((await areaOf(framed.text)) - (800 - Math.PI * 9)) < 0.5);

  const overlapping = toSvg(normalizeSketch({ nodes: [plate, { kind: 'rect', x: 30, y: 0, w: 20, h: 20, r: 0 }] }));
  assert.ok(Math.abs((await areaOf(overlapping.text)) - 1000) < 1e-6);

  // A rounded box loses its four corners: each is a square minus a quarter circle.
  const rounded = toSvg(normalizeSketch({ nodes: [{ kind: 'rect', x: 0, y: 0, w: 40, h: 20, r: 4 }] }));
  assert.ok(Math.abs((await areaOf(rounded.text)) - (800 - (4 - Math.PI) * 16)) < 0.5);

  // A leaf drawn with the pen: its area is what the curves enclose, not the
  // triangle between its points.
  const leaf = toSvg(
    normalizeSketch({
      nodes: [{ kind: 'path', anchors: [{ x: 0, y: 0, out: [0, 10] }, { x: 20, y: 0, in: [0, 10] }], closed: true }],
    }),
  );
  assert.ok((await areaOf(leaf.text)) > 100);
});

test('bounds are exact for curves, and the viewBox contains the whole circle', () => {
  const circle = { kind: 'circle', cx: 0, cy: 0, r: 50 };
  assert.deepEqual(exactBounds([circle]), { minX: -50, minY: -50, maxX: 50, maxY: 50 });
  const bulge = exactBounds([{ kind: 'path', anchors: [{ x: 0, y: 0, out: [0, 10] }, { x: 10, y: 0, in: [0, 10] }], closed: true }]);
  assert.ok(bulge.maxY > 7 && bulge.maxY < 8, `a symmetric cubic peaks at three quarters of its handles: ${bulge.maxY}`);
  assert.equal(toSvg(normalizeSketch({ nodes: [circle] })).width, 100);
});

test('moving and scaling keep handles as offsets', () => {
  const path = normalizeSketch({ nodes: [{ kind: 'path', anchors: [{ x: 1, y: 1, out: [2, 0] }], closed: false }] }).nodes[0];
  assert.deepEqual(translateNode(path, 5, 5).anchors[0], { x: 6, y: 6, out: [2, 0] });
  assert.deepEqual(scaleNode(path, 2, [0, 0]).anchors[0], { x: 2, y: 2, out: [4, 0] });
  const rect = scaleNode({ kind: 'rect', x: 10, y: 10, w: 10, h: 10, r: 1 }, 0.5, [10, 10]);
  assert.deepEqual(rect, { kind: 'rect', x: 10, y: 10, w: 5, h: 5, r: 0.5 });
});

test('foreign contours become closed polylines', () => {
  const doc = fromContours([[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 0]]]);
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].kind, 'poly');
});

test('groups: nesting is judged within a group, and groups union with each other', () => {
  const doc = normalizeSketch({
    nodes: [
      { kind: 'rect', x: 0, y: 0, w: 40, h: 20, r: 0, group: 'a' },
      { kind: 'circle', cx: 10, cy: 10, r: 3, group: 'a' },
      { kind: 'circle', cx: 30, cy: 10, r: 3 },
    ],
  });
  const { rings, islands } = flattenSketch(doc);
  assert.deepEqual(rings.map((r) => r.status), ['solid', 'hole', 'solid']);
  assert.equal(islands.length, 2);
  const { text } = toSvg(doc);
  assert.equal((text.match(/<path/g) ?? []).length, 2);
});

test('erased regions: normalised, kept out of material, and resolved through the clip', async () => {
  const doc = normalizeSketch({
    nodes: [
      { kind: 'rect', x: 0, y: 0, w: 20, h: 20, r: 0, group: 'g' },
      { kind: 'poly', points: [[5, 5], [15, 5], [15, 15], [5, 15]], closed: true, cut: true, group: 'g' },
    ],
  });
  assert.equal(doc.nodes[1].cut, true);
  assert.throws(() => normalizeSketch({ nodes: [{ kind: 'circle', cx: 0, cy: 0, r: 1, cut: true }] }), /closed polygon/);
  const { rings } = flattenSketch(doc);
  assert.deepEqual(rings.map((r) => r.status), ['solid', 'cut']);
  assert.deepEqual(boundsOfSketch(doc), { minX: 0, minY: 0, maxX: 20, maxY: 20 });

  // A clip that stands in for the kernel: it reports what it was asked.
  const asked = [];
  const clip = async (op, inside, outside) => {
    asked.push({ op, inside: inside.length, outside: outside.length });
    return [[[0, 0], [20, 0], [20, 20], [0, 20]], [[5, 5], [5, 15], [15, 15], [15, 5]]];
  };
  const { resolveCuts } = await import('../src/sketch/svg.js');
  const resolved = await resolveCuts(doc, clip);
  assert.deepEqual(asked, [{ op: 'material', inside: 1, outside: 1 }]);
  const { text } = toSvg(doc, resolved);
  assert.ok(text.includes('fill-rule="nonzero"'), 'resolved geometry is written as the kernel made it');
  assert.equal((text.match(/<path/g) ?? []).length, 1);
  assert.ok(Math.abs((await areaOf(text)) - 300) < 1e-6, 'the import sees the plate with its middle gone');
  // The editable document survives, cut and all.
  assert.deepEqual(fromSvg(text), doc);
});

test('a curve offers its handles as grips, and a smooth point keeps its handles in line', () => {
  const path = normalizeSketch({
    nodes: [{ kind: 'path', anchors: [{ x: 0, y: 0, in: [-5, 0], out: [5, 0] }, { x: 20, y: 0, in: [-3, 4], out: [2, 2] }], closed: true }],
  }).nodes[0];
  const grips = gripsOf(path);
  assert.deepEqual(grips.filter((g) => g.handle).map((g) => g.id), ['i0', 'o0', 'i1', 'o1']);
  assert.ok(grips.findIndex((g) => g.id === 'o0') < grips.findIndex((g) => g.id === 'a0'), 'handles win a click over their anchor');
  assert.equal(isSmooth(path.anchors[0]), true);
  assert.equal(isSmooth(path.anchors[1]), false);

  // Pull the out handle of the smooth point upward: the in handle turns to stay opposite, keeping its length.
  const smooth = moveGrip(path, 'o0', [0, 5]);
  assert.deepEqual(smooth.anchors[0].out, [0, 5]);
  assert.deepEqual(smooth.anchors[0].in, [0, -5]);
  // Breaking it leaves the other handle where it was.
  const corner = moveGrip(path, 'o0', [0, 5], true);
  assert.deepEqual(corner.anchors[0].in, [-5, 0]);
  // A corner's handles are independent either way.
  const independent = moveGrip(path, 'i1', [18, 6]);
  assert.deepEqual(independent.anchors[1].in, [-2, 6]);
  assert.deepEqual(independent.anchors[1].out, [2, 2]);
});

test('every anchor of a long traced path is a grip', () => {
  const anchors = Array.from({ length: 60 }, (_, i) => ({ x: Math.cos(i / 10) * 50, y: Math.sin(i / 10) * 50, in: [-1, 0], out: [1, 0] }));
  const path = normalizeSketch({ nodes: [{ kind: 'path', anchors, closed: true }] }).nodes[0];
  assert.equal(gripsOf(path).filter((g) => !g.handle).length, 60);
});
