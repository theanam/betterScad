/**
 * `center()`, `centerx()`, `centery()`, `centerz()` and `centerxy()`: every
 * statement inside after the first is moved so its bounding box is centred on
 * the first one's, on the named axes.
 *
 * It moves and does not group: the children land in the enclosing list as if
 * the call were not there. That is the whole point — `hull() center() { … }`
 * hulls, `difference() center() { … }` subtracts — and it is what the legacy
 * export has to reproduce, by splicing `translate()` calls into the same list.
 */

import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { Engine, describeExtensions, parse, toStockScad, usesMeasurements } from '../dist/index.js';

let engine;
before(async () => {
  engine = await Engine.create();
});

/** Renders `source` and returns each part's bounding box, sorted so order is stable. */
async function boxesOf(source) {
  const result = await engine.render(source, { preview: true });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors.map((e) => e.message), [], `render failed for:\n${source}`);
  const boxes = result.geometry.parts.map((part) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const p = part.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[i + axis]);
        max[axis] = Math.max(max[axis], p[i + axis]);
      }
    }
    return [...min, ...max].map((v) => Math.round(v * 1e6) / 1e6);
  });
  return boxes.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

const volume = async (source) => (await engine.render(source)).geometry.stats.volume;
const warnings = async (source) =>
  (await engine.render(source, { preview: true })).diagnostics.filter((d) => d.severity === 'warning');

/** The two sources draw the same model. */
async function sameModel(a, b) {
  assert.deepEqual(await boxesOf(a), await boxesOf(b));
  assert.ok(Math.abs((await volume(a)) - (await volume(b))) < 1e-6, `volumes differ:\n${a}\n---\n${b}`);
}

const PLATE = 'cube([40, 30, 10]);';

// --- what it does ------------------------------------------------------------

test('every later thing is centred on the first, on every axis', async () => {
  assert.deepEqual(await boxesOf(`center() { ${PLATE} cube(4); translate([100, 0, 0]) cube(2); }`), [
    [0, 0, 0, 40, 30, 10],
    [18, 13, 3, 22, 17, 7],
    [19, 14, 4, 21, 16, 6],
  ]);
});

test('one axis at a time, and the pair x and y', async () => {
  const small = 'translate([100, 100, 100]) cube(2);';
  assert.deepEqual((await boxesOf(`centerx() { ${PLATE} ${small} }`))[1], [19, 100, 100, 21, 102, 102]);
  assert.deepEqual((await boxesOf(`centery() { ${PLATE} ${small} }`))[1], [100, 14, 100, 102, 16, 102]);
  assert.deepEqual((await boxesOf(`centerz() { ${PLATE} ${small} }`))[1], [100, 100, 4, 102, 102, 6]);
  // The common case: on the plate, sitting on top of it.
  assert.deepEqual((await boxesOf(`centerxy() { ${PLATE} translatez(10) cube(4); }`))[1], [18, 13, 10, 22, 17, 14]);
});

test('the first thing never moves, wherever it is', async () => {
  assert.deepEqual(await boxesOf('center() { translate([50, 50, 50]) cube(10); cube(2); }'), [
    [50, 50, 50, 60, 60, 60],
    [54, 54, 54, 56, 56, 56],
  ]);
});

test('a statement is one thing: a loop is centred as a whole', async () => {
  // Two cubes spanning x 0..12: the pair is centred, not each cube.
  assert.deepEqual(await boxesOf(`center() { ${PLATE} for (i = [0 : 1]) translate([i * 10, 0, 0]) cube(2); }`), [
    [0, 0, 0, 40, 30, 10],
    [14, 14, 4, 16, 16, 6],
    [24, 14, 4, 26, 16, 6],
  ]);
});

test('flat shapes are centred flat, and centerz() leaves them alone', async () => {
  const result = await engine.render('centerxy() { square([40, 30]); square(4); }');
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  const out = await engine.render('echo(get_position(centerz() { square([40, 30]); translate([5, 5]) square(4); }));', {
    preview: true,
  });
  assert.ok(out.diagnostics.some((d) => d.message === 'ECHO: [0, 0, 0]'));
});

test('a disabled statement is not there, and a hidden one is still measured', async () => {
  assert.deepEqual(await boxesOf(`center() { ${PLATE} *cube(2); translate([100, 0, 0]) cube(4); }`), [
    [0, 0, 0, 40, 30, 10],
    [18, 13, 3, 22, 17, 7],
  ]);
  // `#` keeps the shape in the model, so it is moved like anything else.
  assert.deepEqual((await boxesOf(`center() { ${PLATE} #translate([100, 0, 0]) cube(4); }`))[1], [18, 13, 3, 22, 17, 7]);
});

test('nested: the inner call lines its own things up, the outer moves them as one', async () => {
  assert.deepEqual(
    await boxesOf(`center() { ${PLATE} centerz() { translatex(100) cube(2); translatex(100) cube(6); } }`),
    [
      [0, 0, 0, 40, 30, 10],
      [17, 12, 2, 23, 18, 8],
      [17, 12, 4, 19, 14, 6],
    ],
  );
});

// --- it moves, it does not group --------------------------------------------

test('difference() sees the centred children as its operands', async () => {
  await sameModel(
    `difference() center() { ${PLATE} cylinder(h = 30, r = 3, center = true, $fn = 16); }`,
    `difference() { ${PLATE} translate([20, 15, 5]) cylinder(h = 30, r = 3, center = true, $fn = 16); }`,
  );
});

test('intersection() and hull() see them too', async () => {
  await sameModel(
    `intersection() center() { ${PLATE} sphere(8, $fn = 24); }`,
    `intersection() { ${PLATE} translate([20, 15, 5]) sphere(8, $fn = 24); }`,
  );
  await sameModel(
    `hull() centerxy() { ${PLATE} translatez(30) sphere(5, $fn = 24); }`,
    `hull() { ${PLATE} translate([20, 15, 30]) sphere(5, $fn = 24); }`,
  );
});

test('a negative() inside reaches the scope around the call, as the braces group nothing', async () => {
  await sameModel(
    `union() { center() { ${PLATE} negative() cylinder(h = 40, r = 3, center = true, $fn = 16); } }`,
    `difference() { ${PLATE} translate([20, 15, 5]) cylinder(h = 40, r = 3, center = true, $fn = 16); }`,
  );
});

test('children() is one thing, centred as a whole on what the module draws', async () => {
  await sameModel(`module on_plate() center() { ${PLATE} children(); } on_plate() cube(4);`, `${PLATE} translate([18, 13, 3]) cube(4);`);
});

test('the braces are a scope for names, as any module call braces are', async () => {
  const result = await engine.render(`s = 10; center() { s = 4; ${PLATE} cube(s); } cube(s);`, { preview: true });
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(await boxesOf(`s = 10; center() { s = 4; ${PLATE} cube(s); } translate([100, 0, 0]) cube(s);`), [
    [0, 0, 0, 40, 30, 10],
    [18, 13, 3, 22, 17, 7],
    [100, 0, 0, 110, 10, 10],
  ]);
});

// --- when there is nothing to do ---------------------------------------------

test('one thing alone has nothing to be centred on, and says so', async () => {
  const found = await warnings(`center() ${PLATE}`);
  assert.ok(found.some((w) => w.code === 'eval.center-alone'), JSON.stringify(found));
  assert.deepEqual(await boxesOf(`center() ${PLATE}`), [[0, 0, 0, 40, 30, 10]]);
});

test('a first thing with no geometry is warned about, and nothing moves', async () => {
  const source = 'center() { for (i = [1 : 0]) cube(1); translate([5, 0, 0]) cube(2); }';
  assert.ok((await warnings(source)).some((w) => w.code === 'eval.center-empty'));
  assert.deepEqual(await boxesOf(source), [[5, 0, 0, 7, 2, 2]]);
});

test('a file with its own module of the name keeps calling it', async () => {
  const source = 'module center() translate([1, 0, 0]) children();\ncenter() cube(2);\n';
  assert.deepEqual(await warnings(source), []);
  assert.deepEqual(await boxesOf(source), [[1, 0, 0, 3, 2, 2]]);
  const legacy = toStockScad(source, 'own.scad');
  assert.equal(legacy.verbatim, true);
  assert.equal(usesMeasurements(parse(source, 'own.scad').file), false);
});

test('without a kernel nothing moves, with a warning', async () => {
  const { evaluate } = await import('../dist/index.js');
  const result = evaluate(parse(`center() { ${PLATE} cube(2); }`).file);
  assert.ok(result.diagnostics.items.some((d) => d.code === 'eval.measure-no-kernel'));
});

// --- legacy export -----------------------------------------------------------

async function legacy(source, parameters) {
  const compiled = await engine.compile(source, { file: 'part.scad', parameters });
  return toStockScad(source, 'part.scad', { measurements: compiled.measurements });
}

test('the export is translate() by the measured move, spliced into the list', async () => {
  const source = `difference() centerxy() {\n  ${PLATE}\n  cylinder(h = 30, r = 3, center = true, $fn = 16);\n}\n`;
  const out = await legacy(source);
  assert.deepEqual(out.errors, []);
  assert.match(out.source, /difference\(\)\n\{\n  cube\(\[40, 30, 10\]\);\n  translate\(\[20, 15, 0\]\) \/\* centerxy\(\) \*\/\n    cylinder/);
  assert.ok(out.extensions.some((e) => e.name === 'centerxy()' && e.lines[0] === 1));
  assert.ok(out.rewrites.some((r) => r.startsWith('centerxy() written as')));
  await sameModel(out.source, source);
});

test('the exported file draws the same model, in every position it can be written', async () => {
  for (const source of [
    `center() { ${PLATE} cube(4); }`,
    `hull() centerxy() { ${PLATE} translatez(30) sphere(5, $fn = 24); }`,
    `intersection() center() { ${PLATE} sphere(8, $fn = 24); }`,
    `union() { center() { ${PLATE} negative() cylinder(h = 40, r = 3, center = true, $fn = 16); } }`,
    `if (true) center() { ${PLATE} cube(4); }`,
    `for (i = [0 : 1]) translate([0, 0, i * 20]) center() { ${PLATE} cube(4); }`,
    `module part() center() { ${PLATE} cube(4); }\npart();\ntranslate([50, 0, 0]) part();`,
    `module on_plate() center() { ${PLATE} children(); }\non_plate() cube(4);`,
    `center() { ${PLATE} centerz() { translatex(100) cube(2); translatex(100) cube(6); } }`,
    `center() { ${PLATE} for (i = [0 : 1]) translate([i * 10, 0, 0]) cube(2); }`,
    `center() { ${PLATE} *cube(2); #translate([100, 0, 0]) cube(4); }`,
    `center() ${PLATE}`,
  ]) {
    const out = await legacy(source);
    assert.deepEqual(out.errors, [], source);
    // No call survives: the comments say where the moves came from, the code does not.
    const code = out.source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/\/\*.*?\*\//g, '');
    assert.ok(!/center[xyz]*\(\)/.test(code), out.source);
    await sameModel(out.source, source);
  }
});

test('an assignment inside the braces stays theirs: a let() on each statement', async () => {
  const source = `s = 10;\ncenter() { s = 4; ${PLATE} cube(s); }\ntranslate([100, 0, 0]) cube(s);\n`;
  const out = await legacy(source);
  assert.deepEqual(out.errors, []);
  assert.match(out.source, /let \(s = 4\)/);
  await sameModel(out.source, source);
});

test('a call that moves things differently from run to run is refused, naming the line', async () => {
  const out = await legacy('module m(w) center() { cube([w, 10, 10]); cube(2); }\nm(20);\nm(30);\n');
  assert.equal(out.verbatim, true);
  assert.equal(out.errors[0].code, 'transpile.measure-varies');
  assert.match(out.errors[0].message, /center\(\) on line 1/);
});

test('without measurements the export refuses rather than guess', () => {
  const out = toStockScad(`center() { ${PLATE} cube(2); }\n`, 'part.scad');
  assert.equal(out.errors[0].code, 'transpile.measure-unmeasured');
});

test('the Info tab knows the call needs a render', () => {
  assert.equal(usesMeasurements(parse(`center() { ${PLATE} cube(2); }`).file), true);
  const uses = describeExtensions(parse(`centerx() { ${PLATE} cube(2); }\ncenterx() { ${PLATE} cube(3); }`).file);
  assert.deepEqual(uses.find((u) => u.name === 'centerx()').lines, [1, 2]);
});
