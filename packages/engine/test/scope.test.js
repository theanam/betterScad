/**
 * Variable scope: which braces own their names and which do not.
 *
 * OpenSCAD's rule, which BetterSCAD follows: a module call's children, `if`,
 * `for`, `let` and a module body are scopes; a bare `{ … }` written as a
 * statement is not, so what it assigns belongs to the scope around it. Within
 * a scope, assignments are gathered before anything runs, and the last one to
 * a name wins.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** What a source echoes, and what it warns, as plain strings. */
async function run(source, options = {}) {
  const result = await engine.render(source, options);
  return {
    echoes: result.diagnostics.filter((d) => d.message.startsWith('ECHO')).map((d) => d.message),
    warnings: result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
    volume: result.geometry.stats.volume,
  };
}

test('a bare block is not a scope: its variable is used outside it', async () => {
  const { volume, warnings } = await run('{ size = 4; } cube(size, center = true);');
  assert.deepEqual(warnings, []);
  assert.ok(Math.abs(volume - 64) < 1e-9, `a 4 mm cube, got ${volume}`);
});

test('nested blocks are not scopes either', async () => {
  const { echoes } = await run('{ { a = 2; } echo(inner = a); } echo(outer = a);');
  assert.deepEqual(echoes, ['ECHO: inner = 2', 'ECHO: outer = 2']);
});

test('the last assignment in the scope wins, block or not', async () => {
  assert.deepEqual((await run('a = 1; { a = 5; } echo(a);')).echoes, ['ECHO: 5']);
  // Gathered before anything runs, so it does not matter which comes first.
  assert.deepEqual((await run('echo(a); { a = 3; }')).echoes, ['ECHO: 3']);
});

test('a module call, if, for and let still own their variables', async () => {
  for (const source of [
    'translate([1, 0, 0]) { t = 3; } echo(t);',
    'if (true) { t = 3; } echo(t);',
    'for (k = [1]) { t = 3; } echo(t);',
    'let (k = 1) { t = 3; } echo(t);',
  ]) {
    const { echoes, warnings } = await run(source);
    assert.deepEqual(echoes, ['ECHO: undef'], source);
    assert.ok(warnings.some((w) => w.includes('`t` is not defined')), source);
  }
});

test('a block inside a scope lends its variable to that scope, and no further', async () => {
  const { echoes } = await run('translate([1, 0, 0]) { { b = 4; } echo(inside = b); } echo(outside = b);');
  assert.deepEqual(echoes, ['ECHO: inside = 4', 'ECHO: outside = undef']);
});

test('a module declared in a block can be called outside it', async () => {
  const { volume } = await run('{ module part() cube(3); } part();');
  assert.ok(Math.abs(volume - 27) < 1e-9);
});

test('a block disabled with * lends nothing, as if commented out', async () => {
  const { echoes } = await run('size = 2; *{ size = 9; } echo(size);');
  assert.deepEqual(echoes, ['ECHO: 2']);
});

test('the Customizer sets top-level assignments, not ones inside a block', async () => {
  const parameters = { width: 7 };
  assert.deepEqual((await run('width = 3; echo(width);', { parameters })).echoes, ['ECHO: 7']);
  assert.deepEqual((await run('{ width = 3; } echo(width);', { parameters })).echoes, ['ECHO: 3']);
});
