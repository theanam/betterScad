/**
 * Language-level tests: lexer, parser, value semantics and the evaluator.
 *
 * These run against the built `dist/`, i.e. exactly what an embedder consumes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCustomizerModel,
  compile,
  lex,
  parse,
  parseBscad,
  serializeBscad,
  transpileToLegacyScad,
  describeExtensions,
} from '../dist/index.js';

/** Compiles and returns just the echo lines, which is how most of these assert. */
async function echoes(source) {
  const result = await compile(source);
  return result.diagnostics
    .filter((d) => d.severity === 'echo')
    .map((d) => d.message.replace(/^ECHO: /, ''));
}

async function errorsOf(source) {
  const result = await compile(source);
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
}

// ---------------------------------------------------------------------------

test('lexer handles numbers, strings, escapes and comments', () => {
  const { tokens, diagnostics } = lex('a = 1e3; b = .5; s = "x\\ny"; /* c */ // trailing');
  assert.equal(diagnostics.length, 0);
  const numbers = tokens.filter((t) => t.kind === 'number').map((t) => t.value);
  assert.deepEqual(numbers, [1000, 0.5]);
  const string = tokens.find((t) => t.kind === 'string');
  assert.equal(string.text, 'x\ny');
});

test('lexer scans include paths, not comparisons', () => {
  const { tokens } = lex('include <lib/foo.scad>\nx = a < b;');
  assert.equal(tokens[1].kind, 'include-path');
  assert.equal(tokens[1].text, 'lib/foo.scad');
  assert.ok(tokens.some((t) => t.kind === 'punct' && t.text === '<'));
});

test('parser recovers from an error and keeps going', () => {
  const { file, diagnostics } = parse('x = ;\ny = 2;\ncube(1);');
  assert.ok(diagnostics.some((d) => d.severity === 'error'));
  // `y = 2` and the cube must still be parsed despite the earlier failure.
  assert.ok(file.body.some((s) => s.kind === 'assign' && s.name === 'y'));
  assert.ok(file.body.some((s) => s.kind === 'module-call' && s.name === 'cube'));
});

test('operator precedence and associativity', async () => {
  assert.deepEqual(
    await echoes('echo(1 + 2 * 3, (1 + 2) * 3, 2 ^ 3 ^ 2, -2 ^ 2, 10 % 3);'),
    ['7, 9, 512, -4, 1'],
  );
});

test('ternary and short-circuit evaluation', async () => {
  assert.deepEqual(
    await echoes('echo(true ? "a" : "b", false || 1, 0 && 1, !undef);'),
    ['"a", true, false, true'],
  );
});

test('assignments are scope-wide: the last one wins', async () => {
  // This is OpenSCAD's defining scoping surprise.
  assert.deepEqual(await echoes('a = 1;\necho(a);\na = 2;'), ['2']);
});

test('assignments evaluate in source order, so earlier reads see earlier values', async () => {
  assert.deepEqual(await echoes('a = 1;\nb = a;\na = 2;\necho(b, a);'), ['1, 2']);
});

test('$-variables are dynamically scoped, plain variables lexically', async () => {
  const source = `
    $depth = 1;
    plain = 1;
    module inner() { echo($depth, plain); }
    module outer() { $depth = 2; plain = 2; inner(); }
    outer();
  `;
  // $depth follows the call chain; `plain` resolves where inner() was defined.
  assert.deepEqual(await echoes(source), ['2, 1']);
});

test('module parameters, defaults and named arguments', async () => {
  const source = `
    module m(a, b = 10, c = 20) { echo(a, b, c); }
    m(1);
    m(1, 2);
    m(1, c = 3);
    m(c = 3, a = 1);
  `;
  assert.deepEqual(await echoes(source), ['1, 10, 20', '1, 2, 20', '1, 10, 3', '1, 10, 3']);
});

test('recursive functions and list comprehensions', async () => {
  const source = `
    function fib(n) = n < 2 ? n : fib(n - 1) + fib(n - 2);
    echo([for (i = [0:9]) fib(i)]);
    echo([for (i = [1:5]) if (i % 2 == 1) i]);
    echo([each [1,2], each [3], 4]);
    echo([for (i = [0:2]) let (d = i * 2) d + 1]);
    echo([for (a = [0:1], b = [0:1]) [a, b]]);
  `;
  assert.deepEqual(await echoes(source), [
    '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]',
    '[1, 3, 5]',
    '[1, 2, 3, 4]',
    '[1, 3, 5]',
    '[[0, 0], [0, 1], [1, 0], [1, 1]]',
  ]);
});

test('C-style list comprehension', async () => {
  assert.deepEqual(
    await echoes('echo([for (i = 0; i < 5; i = i + 2) i]);'),
    ['[0, 2, 4]'],
  );
});

test('function literals are first-class values', async () => {
  const source = `
    f = function (x) x * 2;
    function apply(g, v) = g(v);
    echo(f(21), apply(f, 5), apply(function (x) x + 1, 1));
  `;
  assert.deepEqual(await echoes(source), ['42, 10, 2']);
});

test('children() with indices and $children', async () => {
  const source = `
    module pick(i) { echo($children); children(i); }
    pick(1) { echo("zero"); echo("one"); echo("two"); }
  `;
  assert.deepEqual(await echoes(source), ['3', '"one"']);
});

test('PI is a built-in constant, and an assignment shadows it', async () => {
  // PI is the only constant stock OpenSCAD defines.
  assert.deepEqual(await echoes('echo(PI);'), ['3.14159']);
  assert.deepEqual(await echoes('echo(2 * PI);'), ['6.28319']);

  // It resolves inside modules and functions, which is where it is actually used.
  assert.deepEqual(
    await echoes('function circ(r) = 2 * PI * r;\nmodule m() { echo(circ(10)); }\nm();'),
    ['62.8319'],
  );

  // Constants sit below every user scope, so a script may redefine PI.
  assert.deepEqual(await echoes('PI = 3;\necho(PI);'), ['3']);

  // And using it must not warn about an undefined variable.
  const result = await compile('echo(PI);');
  assert.equal(
    result.diagnostics.filter((d) => d.severity === 'warning').length,
    0,
    'PI should not warn',
  );
});

test('infinity and NaN come from arithmetic, not identifiers', async () => {
  // OpenSCAD has no `inf`/`nan` literals; adding them would be an extension.
  assert.deepEqual(await echoes('echo(1/0, -1/0, 0/0);'), ['inf, -inf, nan']);
  const result = await compile('echo(inf);');
  assert.ok(result.diagnostics.some((d) => d.severity === 'warning' && /`inf` is not defined/.test(d.message)));
});

test('builtin functions behave as documented', async () => {
  const source = `
    echo(len("abc"), len([1,2]), concat([1],[2],3));
    echo(str("n=", 1.5), chr(65, 66), ord("A"));
    echo(norm([3,4]), cross([1,0,0],[0,1,0]));
    echo(round(2.5), round(-2.5), sign(-3), pow(2,10));
    echo(lookup(1.5, [[0,0],[1,10],[2,20]]));
    echo(search("b", "abc"), search([3], [[1,"a"],[3,"c"]]));
    echo(min([4,2,9]), max(1, 7, 3));
  `;
  assert.deepEqual(await echoes(source), [
    '3, 2, [1, 2, 3]',
    '"n=1.5", "AB", 65',
    '5, [0, 0, 1]',
    '3, -3, -1, 1024',
    '15',
    '[1], [1]',
    '2, 7',
  ]);
});

test('sin/cos snap to exact zero at the cardinal angles', async () => {
  assert.deepEqual(await echoes('echo(sin(180), cos(90), sin(0));'), ['0, 0, 0']);
});

test('vector and matrix arithmetic', async () => {
  const source = `
    echo([1,2] + [3,4], [1,2] * 3, [1,2] * [3,4]);
    echo([[1,2],[3,4]] * [1,1]);
    echo([[1,0],[0,1]] * [[2,0],[0,2]]);
  `;
  assert.deepEqual(await echoes(source), [
    '[4, 6], [3, 6], 11',
    '[3, 7]',
    '[[2, 0], [0, 2]]',
  ]);
});

test('ranges, including negative steps and non-integer steps', async () => {
  const source = `
    echo([for (i = [0:2:6]) i]);
    echo([for (i = [5:-1:3]) i]);
    echo([for (i = [0:0.5:1]) i]);
  `;
  assert.deepEqual(await echoes(source), ['[0, 2, 4, 6]', '[5, 4, 3]', '[0, 0.5, 1]']);
});

test('assert failure is an error with the supplied message', async () => {
  const errors = await errorsOf('assert(1 == 2, "must match");');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Assertion failed: must match/);
});

test('undefined variables warn and evaluate to undef', async () => {
  const result = await compile('echo(nope);');
  assert.ok(result.diagnostics.some((d) => d.severity === 'warning' && /not defined/.test(d.message)));
  assert.ok(result.diagnostics.some((d) => d.severity === 'echo' && d.message.includes('undef')));
});

test('runaway recursion is stopped rather than crashing', async () => {
  const errors = await errorsOf('module m() { m(); } m();');
  assert.ok(errors.some((e) => /recursion depth/.test(e)));
});

test('include and use are resolved through the host resolver', async () => {
  const library = `
    LIB_CONST = 7;
    module lib_box() { cube(1); }
    function lib_double(x) = x * 2;
  `;
  const resolveInclude = async (path) => (path === 'lib.scad' ? library : undefined);

  const included = await compile('include <lib.scad>\necho(LIB_CONST, lib_double(4));', {
    resolveInclude,
  });
  assert.ok(
    included.diagnostics.some((d) => d.severity === 'echo' && d.message.includes('7, 8')),
    'include should expose variables and functions',
  );

  // `use` imports definitions but NOT variables.
  const used = await compile('use <lib.scad>\necho(lib_double(4), is_undef(LIB_CONST));', {
    resolveInclude,
  });
  assert.ok(used.diagnostics.some((d) => d.severity === 'echo' && d.message.includes('8, true')));
});

test('customizer extracts annotated parameters and groups', () => {
  const source = [
    '/* [Dimensions] */',
    '// Width of the plate',
    'width = 30; // [10:100]',
    'height = 5; // [1:0.5:20]',
    'rounded = true;',
    'label = "hi";',
    'style = "a"; // [a, b, c]',
    'mode = 1; // [0:Off, 1:On]',
    'offsetXY = [1, 2];',
    '/* [Hidden] */',
    'secret = 99;',
    'computed = width * 2;',
  ].join('\n');

  const model = buildCustomizerModel(parse(source));
  const byName = Object.fromEntries(model.parameters.map((p) => [p.name, p]));

  assert.equal(byName.width.kind, 'slider');
  assert.equal(byName.width.min, 10);
  assert.equal(byName.width.max, 100);
  assert.equal(byName.width.description, 'Width of the plate');
  assert.equal(byName.width.group, 'Dimensions');
  assert.equal(byName.height.step, 0.5);
  assert.equal(byName.rounded.kind, 'checkbox');
  assert.equal(byName.label.kind, 'text');
  assert.equal(byName.style.kind, 'dropdown');
  assert.deepEqual(byName.style.options.map((o) => o.value), ['a', 'b', 'c']);
  assert.deepEqual(byName.mode.options.map((o) => o.label), ['Off', 'On']);
  assert.equal(byName.offsetXY.kind, 'vector');
  assert.equal(byName.secret, undefined, 'the Hidden section must be excluded');
  assert.equal(byName.computed, undefined, 'non-literal defaults are not customizable');
});

test('customizer values override top-level assignments', async () => {
  const result = await compile('w = 10;\necho(w);', { parameters: { w: 42 } });
  assert.ok(result.diagnostics.some((d) => d.severity === 'echo' && d.message.includes('42')));
});

test('.bscad metadata round-trips and stays valid .scad', () => {
  const metadata = { version: 1, layout: { split: 0.4 }, presets: { small: { w: 1 } } };
  const text = serializeBscad('cube(10);\n', metadata);
  const parsed = parseBscad(text);

  assert.equal(parsed.hadMetadata, true);
  assert.equal(parsed.source, 'cube(10);\n');
  assert.deepEqual(parsed.metadata.layout, { split: 0.4 });

  // The whole file must still parse as OpenSCAD, metadata comment included.
  assert.equal(parse(text).diagnostics.filter((d) => d.severity === 'error').length, 0);

  const plain = parseBscad('cube(10);\n');
  assert.equal(plain.hadMetadata, false);
});

test('negative() transpiles to difference() for legacy export', () => {
  const source = 'union() {\n  cube(10);\n  negative() { sphere(6); }\n}\n';
  const parsed = parse(source);

  const extensions = describeExtensions(parsed.file);
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].name, 'negative()');

  const { source: legacy, rewrites } = transpileToLegacyScad(parsed.file, { header: false });
  assert.ok(rewrites.some((r) => /negative/.test(r)));
  assert.ok(legacy.includes('difference()'));
  assert.ok(!/\bnegative\s*\(/.test(legacy), 'no negative() may survive into legacy output');

  // The rewritten output must itself be valid OpenSCAD.
  assert.equal(parse(legacy).diagnostics.filter((d) => d.severity === 'error').length, 0);
});

test('transpiler round-trips stock constructs, modifiers included', () => {
  const source = [
    'module m(a = 1) { for (i = [0:2]) translate([i, 0, 0]) cube(a); }',
    '%cube(1);',
    '#sphere(2);',
    '*cylinder(3);',
    'if (true) cube(1); else sphere(1);',
    'x = [for (i = [1:3]) each [i, -i]];',
  ].join('\n');

  const { source: printed } = transpileToLegacyScad(parse(source).file);
  const reparsed = parse(printed);
  assert.equal(reparsed.diagnostics.filter((d) => d.severity === 'error').length, 0);
  assert.ok(printed.includes('%cube'));
  assert.ok(printed.includes('#sphere'));
  assert.ok(printed.includes('*cylinder'));
  assert.ok(printed.includes('each'));
});
