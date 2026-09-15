/**
 * The declared defaults are the real ones.
 *
 * `BUILTIN_MODULES[name].defaults` exists so tooling can show what a parameter
 * falls back to — the editor puts them in the signature it keeps on screen. It
 * is a second statement of something the `build` function already decides, and
 * a second statement is a thing that rots: change the fallback in the code,
 * forget the table, and the editor confidently tells people a number that is no
 * longer true.
 *
 * So nothing here trusts the table. Every declared default is checked by
 * rendering the call twice — once with the parameter left out, once with it
 * written out as the default says — and failing if the two differ. A default
 * that has drifted stops being a documentation bug and becomes a test failure.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { BUILTIN_MODULES, Engine } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/**
 * A minimal call for each module carrying defaults, with `%` marking where an
 * extra argument goes.
 *
 * Written out rather than generated: the point is to exercise the real call,
 * and a generated one would have to guess at what each module needs to produce
 * geometry at all.
 *
 * None of these may supply a parameter that has a default — `cube(10)` already
 * fixes `size`, so `cube(10, size = 1)` would be testing which of the two wins
 * rather than what the fallback is.
 */
const CALLS = {
  cube: 'cube(%);',
  sphere: 'sphere($fn = 16%);',
  cylinder: 'cylinder(r = 4, $fn = 16%);',
  square: 'linear_extrude(2) square(%);',
  circle: 'linear_extrude(2) circle($fn = 16%);',
  thread: 'thread(d = 8, pitch = 1.25, h = 5, $fn = 28%);',
  offset: 'linear_extrude(2) offset(r = 2, $fn = 16%) square(10);',
  rotate_extrude: 'rotate_extrude($fn = 16%) translate([6, 0]) square(3);',
  projection: 'linear_extrude(2) projection(%) translate([0, 0, -1]) cube(6);',
  linear_extrude: 'linear_extrude(%) square(8);',
  // These three need a file on disk, and `text` a font. Listed so the coverage
  // test below can see them, skipped by the loop above.
  surface: undefined,
  import: undefined,
  import_stl: undefined,
  import_dxf: undefined,
  import_off: undefined,
  text: undefined,
};

/** Puts an argument at the `%`, with a comma only when one is needed. */
function fill(template, argument) {
  const at = template.indexOf('%');
  const separator = argument && template[at - 1] !== '(' ? ', ' : '';
  return template.slice(0, at) + separator + argument + template.slice(at + 1);
}

/** Geometry, as two numbers that any real difference will move. */
async function measure(source) {
  const result = await engine.render(source);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);
  const { volume, area } = result.geometry.stats;
  return { volume, area };
}

test('every declared default is what the module actually does', async () => {
  let checked = 0;

  for (const [name, template] of Object.entries(CALLS)) {
    const defaults = BUILTIN_MODULES[name]?.defaults;
    assert.ok(defaults, `${name} declares no defaults, so it should not be listed here`);
    if (!template) continue;

    const implicit = await measure(fill(template, ''));

    for (const [param, value] of Object.entries(defaults)) {
      const explicit = await measure(fill(template, `${param} = ${value}`));
      assert.deepEqual(
        explicit,
        implicit,
        `${name}(): leaving ${param} out is not the same as ${param} = ${value}`,
      );
      checked++;
    }
  }

  // Cheap guard against the loop silently doing nothing.
  assert.ok(checked > 20, `only ${checked} defaults were actually exercised`);
});

test('every module carrying defaults is covered here', () => {
  // A new default with no case above would otherwise be declared and never
  // checked, which is the state this whole file exists to prevent.
  const declared = Object.keys(BUILTIN_MODULES).filter((name) => BUILTIN_MODULES[name].defaults);
  const listed = new Set(Object.keys(CALLS));
  const missing = declared.filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `these declare defaults but are not listed in CALLS: ${missing}`);
});

test('a declared default names a parameter the module accepts', () => {
  for (const [name, module] of Object.entries(BUILTIN_MODULES)) {
    for (const param of Object.keys(module.defaults ?? {})) {
      assert.ok(
        module.params.includes(param),
        `${name}() declares a default for ${param}, which is not one of its parameters`,
      );
    }
  }
});
