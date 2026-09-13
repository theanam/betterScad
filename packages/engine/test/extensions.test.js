/**
 * `describeExtensions()`: what a file uses that stock OpenSCAD does not have.
 *
 * Two callers depend on this being both complete and quiet — the legacy `.scad`
 * export, which warns before rewriting, and opening a `.scad`, which warns that
 * the file is not really OpenSCAD. A false positive nags on every plain file;
 * a false negative ships a `.scad` that will not open elsewhere.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeExtensions, parse } from '../dist/index.js';

const extensionsIn = (source) => describeExtensions(parse(source).file);
const names = (source) => extensionsIn(source).map((e) => e.name).sort();

test('a stock OpenSCAD file reports nothing', () => {
  assert.deepEqual(
    names(`
      module holey(d) { difference() { cube(20, center = true); cylinder(d = d, h = 40, center = true); } }
      for (i = [0:2]) translate([i * 25, 0, 0]) holey(6 + i);
      %cube(1); #sphere(2);
      x = [for (i = [0:5]) if (i % 2 == 0) i * 2];
    `),
    [],
  );
});

test('negative() and C-style for are both reported', () => {
  assert.deepEqual(names('cube(10); negative() cube(5); for (i = 0; i < 3; i = i + 1) cube(i);'), [
    'C-style for(...)',
    'negative()',
  ]);
});

test('each use is reported once, with every line it appears on', () => {
  const [use] = extensionsIn(['cube(10);', 'negative() cube(1);', '', 'negative() cube(2);'].join('\n'));
  assert.equal(use.name, 'negative()');
  assert.deepEqual(use.lines, [2, 4]);
  assert.ok(use.downgrade.length > 0, 'every extension must describe its downgrade');
});

test('lines come back in source order however the tree is walked', () => {
  // The cutter on line 6 is found inside a module body, which the traversal
  // reaches after the top-level call on line 2 but before the one on line 8.
  const [use] = extensionsIn(
    [
      'cube(20);', // 1
      'negative() cube(1);', // 2
      '', // 3
      'module m() {', // 4
      '  cube(5);', // 5
      '  negative() cube(2);', // 6
      '}', // 7
      'negative() cube(3);', // 8
    ].join('\n'),
  );
  assert.deepEqual(use.lines, [2, 6, 8]);
});

test('extensions nested inside wrappers are still found', () => {
  // The warning must not depend on where in the tree the extension sits: a
  // negative buried under a transform inside a for is exactly the case a user
  // will not spot by eye.
  for (const source of [
    'union() { cube(10); translate([1,0,0]) negative() cube(1); }',
    'for (i = [0:2]) negative() cube(1);',
    'if (true) negative() cube(1); else cube(2);',
    'if (false) cube(2); else negative() cube(1);',
    'let (x = 1) negative() cube(x);',
    'module m() { negative() cube(1); }',
    'intersection_for (i = [0:1]) negative() cube(1);',
    'echo("hi") negative() cube(1);',
  ]) {
    assert.deepEqual(names(source), ['negative()'], `missed the extension in: ${source}`);
  }
});
