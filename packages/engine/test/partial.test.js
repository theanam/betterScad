/**
 * A line half-way through being typed, and the rest of the model.
 *
 * Every keystroke re-renders, so most renders happen with one line unfinished.
 * If any error blanked the model, it would vanish while you type and come back
 * at the `;`. A partial render instead leaves the broken line out and draws
 * the rest — which needs more than parser recovery, because recovery skips to
 * the next `;` and an unfinished `sphere(` takes the whole next line with it.
 *
 * The errors still stand: the diagnostics are the file's as written, and a
 * render that is not partial (Export, the CLI) still refuses to draw.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, compile, parse } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** The outermost operations the scene ended up with, in order, groups flattened. */
function ops(scene) {
  const names = [];
  const walk = (n) => {
    if (n.op !== 'group') names.push(n.op);
    else n.children.forEach(walk);
  };
  walk(scene);
  return names;
}

async function calls(source) {
  return ops((await compile(source)).scene);
}

test('the broken line is the one the statement starts on, not the one the error is on', () => {
  const parsed = parse('cube(10);\nsphere(\ntranslate([5,0,0]) cube(3);\n');
  assert.equal(parsed.diagnostics[0].span.start.line, 3);
  assert.deepEqual(parsed.brokenLines, [2]);
});

test('an unfinished call leaves out its own line and keeps the next one', async () => {
  const result = await compile('cube(10);\nsphere(\ntranslate([5,0,0]) cube(3);\n');
  assert.deepEqual(result.omittedLines, [2]);
  assert.deepEqual(await calls('cube(10);\nsphere(\ntranslate([5,0,0]) cube(3);\n'), [
    'cube',
    'transform',
  ]);
  // The error is still reported, where the parser found it.
  assert.ok(result.diagnostics.some((d) => d.severity === 'error' && d.span.start.line === 3));
});

test('a half-typed module name, a half-typed argument and a missing `;` at the end', async () => {
  const kept = ['cube', 'sphere'];
  assert.deepEqual(await calls('cube(10);\ntranslate([20,0,0]) cy\nsphere(3);\n'), kept);
  assert.deepEqual(await calls('cube(10);\ntranslate([20,0,0]) cylinder(h=\nsphere(3);\n'), kept);
  assert.deepEqual(await calls('cube(10);\nsphere(3)\n'), ['cube']);
});

test('a broken line inside a block leaves the block standing', async () => {
  const source = 'difference() {\n  cube(10);\n  sphe\n}\nsphere(3);\n';
  const result = await compile(source);
  assert.deepEqual(result.omittedLines, [3]);
  assert.deepEqual(ops(result.scene), ['difference', 'sphere']);
  const difference = result.scene.children.find((n) => n.op === 'difference');
  assert.deepEqual(difference.children.flatMap(ops), ['cube']);
});

test('a file that parses leaves nothing out', async () => {
  assert.deepEqual((await compile('cube(10);\nsphere(3);\n')).omittedLines, []);
});

test('omitting a line keeps every later position where it was', async () => {
  const source = 'cube(10);\nsphere(\nundefined_module();\n';
  const result = await compile(source);
  const warning = result.diagnostics.find((d) => /undefined_module/.test(d.message));
  assert.ok(warning, 'the evaluator still reports on the line after the broken one');
  assert.equal(warning.span.start.line, 3);
});

test('a partial render draws the rest; a normal one still refuses', async () => {
  const source = 'cube(10);\nsphere(\ntranslate([20,0,0]) cube(3);\n';
  const partial = await engine.render(source, { partial: true });
  assert.ok(partial.geometry.parts.length > 0);
  assert.ok(partial.geometry.stats.volume > 1000);
  assert.ok(partial.diagnostics.some((d) => d.severity === 'error'));

  const strict = await engine.render(source);
  assert.equal(strict.geometry.parts.length, 0);
});

test('a partial render forgives parse errors only', async () => {
  // A failed assert is the model saying it is wrong, not a line still being typed.
  const result = await engine.render('cube(10);\nassert(false);\n', { partial: true });
  assert.ok(result.diagnostics.some((d) => d.severity === 'error'));
  assert.equal(result.geometry.parts.length, 0);
});
