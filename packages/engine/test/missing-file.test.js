/**
 * A diagnostic about a file that is not there says which file.
 *
 * The app puts an "Add file" button on these, and it needs the path to know
 * what to ask for and what to store the answer as.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

async function missing(source) {
  const result = await engine.render(source, {
    file: 'main.scad',
    preview: false,
    resolveInclude: async () => undefined,
    assets: { read: async () => undefined },
  });
  return result.diagnostics.filter((d) => d.missingFile).map((d) => d.missingFile);
}

test('import() names the file it could not read', async () => {
  assert.deepEqual(await missing('import("parts/logo.svg");'), ['parts/logo.svg']);
});

test('use <> and include <> name the library they could not find', async () => {
  assert.deepEqual(await missing('use <MCAD/gears.scad>'), ['MCAD/gears.scad']);
  assert.deepEqual(await missing('include <box.scad>'), ['box.scad']);
});
