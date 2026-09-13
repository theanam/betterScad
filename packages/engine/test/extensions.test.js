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

import { describeExtensions, parse, toStockScad } from '../dist/index.js';

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

// --- toStockScad -----------------------------------------------------------

test('a file with no extensions is returned byte for byte', () => {
  // The point of the check: this source has comments, deliberate spacing and
  // unparenthesised arithmetic, all of which the pretty-printer would rewrite.
  const source = [
    '// A bracket.',
    'size = 40;      // [10:80]',
    '',
    'module plate(w, h) {',
    '  /* two holes */',
    '  difference() {',
    '    cube([w, h, 3]);',
    '    for (x = [8, w - 8]) translate([x, h / 2, -1]) cylinder(d = 4, h = 5);',
    '  }',
    '}',
    '',
    'plate(size, size * 0.6);',
    '',
  ].join('\n');

  const result = toStockScad(source, 'bracket.scad');
  assert.equal(result.verbatim, true);
  assert.equal(result.source, source, 'a stock file must not be reformatted');
  assert.deepEqual(result.extensions, []);
  assert.deepEqual(result.rewrites, []);
  assert.deepEqual(result.errors, []);
});

test('stock modifiers are not an extension and do not trigger a rewrite', () => {
  const source = '%cube(1);\n#sphere(2);\n!cylinder(3);\n*cube(4);\n';
  const result = toStockScad(source);
  assert.equal(result.verbatim, true);
  assert.equal(result.source, source);
});

test('a file that uses an extension is rewritten', () => {
  const source = 'cube(10);\nnegative() translate([5,0,0]) cube(10);\n';
  const result = toStockScad(source, 'part.scad');
  assert.equal(result.verbatim, false);
  assert.notEqual(result.source, source);
  // Anchored to a statement: the header comment names the rewrite in prose.
  assert.ok(!/^\s*negative\s*\(/m.test(result.source), 'negative() must not survive');
  assert.ok(/difference\s*\(/.test(result.source), 'it must become a difference()');
  assert.deepEqual(result.extensions.map((e) => e.name), ['negative()']);
  assert.ok(result.rewrites.length > 0);
});

test('the rewritten output is itself stock, so a second pass is a no-op', () => {
  const once = toStockScad('cube(10);\nnegative() cube(5);\n');
  const twice = toStockScad(once.source);
  assert.equal(twice.verbatim, true);
  assert.equal(twice.source, once.source, 'transpiling is idempotent');
});

test('parse errors write nothing and hand back the input untouched', () => {
  const broken = 'cube(10)\nnegative( {{{\n';
  const result = toStockScad(broken, 'broken.scad');
  assert.ok(result.errors.length > 0);
  assert.equal(result.source, broken, 'a file that does not parse must not be mangled');
  assert.equal(result.verbatim, true);
});
