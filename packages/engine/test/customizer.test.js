/**
 * The Customizer's comment conventions.
 *
 * These are OpenSCAD's, not this project's, so "what does OpenSCAD do" settles
 * every question here. Two of them matter more than the rest because getting
 * them wrong is silent: a `[Hidden]` section that does not hide leaks
 * parameters the author meant to keep out of the UI, and a description that
 * does not attach leaves a control labelled with nothing but a variable name.
 *
 * `buildCustomizerModel` is driven directly rather than through a render: it
 * reads comments and literals and never touches geometry, so the kernel would
 * only make the tests slower.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCustomizerModel, parse } from '../dist/index.js';

const model = (source) => buildCustomizerModel(parse(source));
const names = (source) => model(source).parameters.map((p) => p.name);
const describe = (source, name) =>
  model(source).parameters.find((p) => p.name === name)?.description ?? null;

test('a Hidden section hides what follows it, however it is spelled', () => {
  // `[Hidden]` is the documented spelling and `[hidden]` is what people type.
  // Matching only the first meant a file could show every parameter it had
  // asked to conceal, with nothing to say it had gone wrong.
  for (const marker of [
    '/* [Hidden] */',
    '/*[Hidden]*/',
    '/* [hidden] */',
    '/*[hidden]*/',
    '/* [HIDDEN] */',
    '/*[ hidden ]*/',
  ]) {
    assert.deepEqual(names(`shown = 1;\n${marker}\nsecret = 2;\n`), ['shown'], marker);
  }
});

test('hiding starts where the marker is and does not reach back', () => {
  const source = `
    before = 1;
    /* [Box] */
    inside = 2;
    /* [hidden] */
    after = 3;
  `;
  assert.deepEqual(names(source), ['before', 'inside']);
});

test('a section merely containing the word is not the Hidden section', () => {
  // Only the whole name counts, or `[Hidden bolts]` would vanish.
  const source = '/* [Hidden bolts] */\nbolt = 1;\n';
  assert.deepEqual(names(source), ['bolt']);
  assert.equal(model(source).parameters[0].group, 'Hidden bolts');
});

test('a visible section keeps the capitalisation it was written with', () => {
  const source = '/* [Box Shell] */\nw = 1;\n';
  assert.deepEqual(model(source).groups, ['Box Shell']);
});

test('the comment above a parameter becomes its description', () => {
  assert.equal(describe('// Wall thickness\nw = 4;', 'w'), 'Wall thickness');
  // With an annotation on the same line as the parameter, both are read.
  const withBoth = model('// Wall thickness\nw = 4; // [1:10]').parameters[0];
  assert.equal(withBoth.description, 'Wall thickness');
  assert.equal(withBoth.kind, 'slider');
  assert.equal(withBoth.min, 1);
  assert.equal(withBoth.max, 10);
});

test('a description survives the shapes people actually write', () => {
  assert.equal(describe('//Wall thickness\nw = 4;', 'w'), 'Wall thickness', 'no space after //');
  assert.equal(describe('  // Wall thickness\nw = 4;', 'w'), 'Wall thickness', 'indented comment');
  assert.equal(describe('// Wall thickness\n  w = 4;', 'w'), 'Wall thickness', 'indented parameter');
  assert.equal(describe('// Wall of\n// the box\nw = 4;', 'w'), 'Wall of the box', 'two lines');
  assert.equal(describe('// Wall thickness   \nw = 4;', 'w'), 'Wall thickness', 'trailing spaces');
  assert.equal(describe('/* [Box] */\n// Wall thickness\nw = 4;', 'w'), 'Wall thickness', 'after a section');
  assert.equal(describe('a = 1;\n// Wall thickness\nw = 4;', 'w'), 'Wall thickness', 'after a parameter');
  // Brackets in the prose are prose; only a trailing comment is an annotation.
  assert.equal(describe('// Wall thickness [mm]\nw = 4;', 'w'), 'Wall thickness [mm]');
  assert.equal(describe('// Wall thickness\r\nw = 4;\r\n', 'w'), 'Wall thickness', 'CRLF');
});

test('every kind of control can carry one', () => {
  const source = `
// A number
n = 4;
// A boolean
b = true;
// A string
s = "hi";
// A vector
v = [1, 2, 3];
// A dropdown
d = 2; // [1:One, 2:Two]
// A slider
sl = 5; // [0:10]
`;
  const kinds = {};
  for (const p of model(source).parameters) kinds[p.name] = [p.kind, p.description];
  assert.deepEqual(kinds, {
    n: ['number', 'A number'],
    b: ['checkbox', 'A boolean'],
    s: ['text', 'A string'],
    v: ['vector', 'A vector'],
    d: ['dropdown', 'A dropdown'],
    sl: ['slider', 'A slider'],
  });
});

test('a comment that is not attached to the parameter is not its description', () => {
  // Each of these is deliberate, and each matches OpenSCAD. A blank line ends
  // the association, a block comment is a section marker's syntax, and the
  // trailing slot belongs to the annotation.
  assert.equal(describe('// Wall thickness\n\nw = 4;', 'w'), null, 'blank line between');
  assert.equal(describe('/* Wall thickness */\nw = 4;', 'w'), null, 'block comment');
  assert.equal(describe('w = 4; // Wall thickness', 'w'), null, 'trailing on the same line');
});

test('a section marker above a parameter is not read as its description', () => {
  const source = '/* [Box] */\nw = 4;';
  assert.equal(describe(source, 'w'), null);
  assert.equal(model(source).parameters[0].group, 'Box');
});
