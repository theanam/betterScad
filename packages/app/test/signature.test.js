/**
 * Knowing which call the cursor is inside.
 *
 * Everything the signature tooltip and the parameter suggestions do rests on
 * `callAt` being right about a half-typed file, so most of this is about the
 * ways a `(` can look like something it is not: inside a string, inside a
 * comment, nested in another call, or a plain grouping bracket with no name.
 *
 * `|` marks the cursor in these fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { activeParam, callAt, signatureFor } from '../src/editor/signature.ts';

/** Splits a fixture on `|` into the text and the cursor offset. */
function at(fixture) {
  const pos = fixture.indexOf('|');
  assert.notEqual(pos, -1, 'fixture needs a | for the cursor');
  return callAt(fixture.replace('|', ''), pos);
}

test('the call the cursor is inside', () => {
  const call = at('thread(d = 8, |');
  assert.equal(call?.name, 'thread');
  assert.equal(call.argument, 1);
  assert.deepEqual(call.named, ['d']);
  assert.equal(call.atArgumentStart, true);
});

test('the line that prompted this', () => {
  // A finished call, a comma added on the end, and the question "what else can
  // go here" — which is what every part of this has to answer.
  const call = at(
    'thread(d = batt_d + wall2, pitch = thread_pitch, h = batt_h, internal = internal, |);',
  );
  assert.equal(call?.name, 'thread');
  assert.deepEqual(call.named, ['d', 'pitch', 'h', 'internal']);
  assert.equal(call.atArgumentStart, true);

  const signature = signatureFor('thread', '');
  const left = signature.params.filter((p) => !call.named.includes(p.name)).map((p) => p.name);
  assert.deepEqual(left, ['clearance', 'angle', 'chamfer', 'center', 'segments', '$fn', '$fa', '$fs']);
});

test('a partial name is still the start of an argument', () => {
  const call = at('thread(d = 8, cham|');
  assert.equal(call.atArgumentStart, true);
  assert.deepEqual(call.named, ['d']);
});

test('writing a value is not choosing a parameter', () => {
  // `d = ba|` wants variables, not parameter names.
  assert.equal(at('thread(d = ba|').atArgumentStart, false);
  assert.equal(at('thread(8 + |').atArgumentStart, false);
  assert.equal(at('thread(d = 8, angle = 6|').atArgumentStart, false);
});

test('the innermost call wins', () => {
  const call = at('thread(d = max(a, |');
  assert.equal(call.name, 'max');
  assert.equal(call.argument, 1);

  // ...and a closed inner call hands the cursor back to the outer one.
  const outer = at('thread(d = max(a, b), |');
  assert.equal(outer.name, 'thread');
  assert.deepEqual(outer.named, ['d']);
});

test('commas inside a vector do not count as arguments', () => {
  const call = at('translate([1, 2, 3], |');
  assert.equal(call.name, 'translate');
  assert.equal(call.argument, 1);
});

test('brackets in strings and comments are not calls', () => {
  assert.equal(at('echo("cylinder(") ; foo|'), undefined);
  assert.equal(at('// cylinder(\nfoo|'), undefined);
  assert.equal(at('/* thread( */ foo|'), undefined);
  // And a real call after a decoy comment is still found.
  assert.equal(at('// thread(\ncube(|').name, 'cube');
});

test('comparisons are not named arguments', () => {
  assert.deepEqual(at('foo(a == b, |').named, []);
  assert.deepEqual(at('foo(a >= b, |').named, []);
  assert.deepEqual(at('foo(a != b, |').named, []);
  assert.deepEqual(at('foo(a <= b, |').named, []);
});

test('a bare grouping bracket names nothing', () => {
  const call = at('x = (1 + |');
  assert.equal(call.name, '');
  assert.equal(signatureFor(call.name, ''), undefined);
});

test('calls spanning several lines', () => {
  const call = at('thread(\n  d = 8,\n  pitch = 1.25,\n  |\n);');
  assert.equal(call.name, 'thread');
  assert.deepEqual(call.named, ['d', 'pitch']);
  assert.equal(call.atArgumentStart, true);
});

test('signatures come from the engine, not a second copy', () => {
  // The interpreter reads arguments from these same tables, so a suggestion
  // cannot name a parameter the interpreter would ignore.
  const names = (name) => signatureFor(name, '').params.map((p) => p.name);
  assert.deepEqual(names('cylinder').slice(0, 8), [
    'h', 'r', 'r1', 'r2', 'center', 'd', 'd1', 'd2',
  ]);
  assert.equal(signatureFor('rands', '').kind, 'function');
  assert.deepEqual(names('rands'), ['min_value', 'max_value', 'value_count', 'seed']);
  assert.equal(signatureFor('not_a_thing', ''), undefined);
});

test('a parameter carries the default it falls back to', () => {
  // The values come from the engine, where `defaults.test.js` checks each one
  // by rendering with the parameter left out and again with it set.
  const defaults = Object.fromEntries(
    signatureFor('thread', '').params.map((p) => [p.name, p.default]),
  );
  assert.deepEqual(defaults, {
    d: undefined,
    pitch: undefined,
    h: undefined,
    internal: 'false',
    clearance: '0.2',
    angle: '60',
    chamfer: 'true',
    center: 'false',
    segments: undefined,
    $fn: undefined,
    $fa: undefined,
    $fs: undefined,
  });

  // A string default keeps its quotes, because it is the source you would type.
  const text = Object.fromEntries(signatureFor('text', '').params.map((p) => [p.name, p.default]));
  assert.equal(text.halign, '"left"');
  assert.equal(text.size, '10');
  assert.equal(text.text, undefined, 'a required parameter has no default');
});

test("a module in the document, and one that shadows a builtin", () => {
  const source = 'module bracket(width, height = 10, depth = 4) { }\nmodule cube(mine) { }';
  // Whatever was written after the `=` is the default, verbatim — no table
  // needed, and nothing to drift from.
  assert.deepEqual(signatureFor('bracket', source).params, [
    { name: 'width' },
    { name: 'height', default: '10' },
    { name: 'depth', default: '4' },
  ]);
  assert.equal(signatureFor('bracket', source).kind, 'user module');
  // The interpreter lets a user module shadow a builtin; so does this.
  assert.deepEqual(signatureFor('cube', source).params, [{ name: 'mine' }]);
});

test('a default that is an expression survives intact', () => {
  const source = 'module plate(size = [40, 20], r = wall * 2, name = "top") { }';
  assert.deepEqual(signatureFor('plate', source).params, [
    { name: 'size', default: '[40, 20]' },
    { name: 'r', default: 'wall * 2' },
    { name: 'name', default: '"top"' },
  ]);
});

test('the signature points at the parameter being filled in', () => {
  const signature = signatureFor('thread', '');

  // By position, while the arguments are positional.
  assert.equal(activeParam(at('thread(|'), signature), 0);
  assert.equal(activeParam(at('thread(8, |'), signature), 1);

  // By name once one is named, because named arguments are unordered and the
  // position stops meaning anything.
  const indexOf = (name) => signature.params.findIndex((p) => p.name === name);
  assert.equal(activeParam(at('thread(d = 8, angle = |'), signature), indexOf('angle'));
  assert.equal(activeParam(at('thread(d = 8, chamfer = |'), signature), indexOf('chamfer'));

  // Nothing to point at between a named argument and the next name.
  assert.equal(activeParam(at('thread(d = 8, |'), signature), -1);
});

test('outside any call there is nothing to report', () => {
  assert.equal(at('cube(10);\n|'), undefined);
  assert.equal(at('|'), undefined);
  assert.equal(at('x = 1;\ny = |'), undefined);
});
