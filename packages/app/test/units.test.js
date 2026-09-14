/**
 * Inch entry.
 *
 * The risk in rewriting what someone typed is rewriting the wrong thing, so
 * most of this is about what must be left alone: names that happen to end in
 * `in`, tokens that are not finished yet, and text that is prose rather than
 * geometry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { inchesAtEnd, inchesToMillimetres } from '../src/editor/units.ts';

test('inches convert to millimetres', () => {
  assert.equal(inchesAtEnd('h = 5in')?.millimetres, '127');
  assert.equal(inchesAtEnd('h = 1in')?.millimetres, '25.4');
  assert.equal(inchesAtEnd('h = 2.5in')?.millimetres, '63.5');
  assert.equal(inchesAtEnd('h = .5in')?.millimetres, '12.7');
  assert.equal(inchesAtEnd('h = 0.001in')?.millimetres, '0.0254');
});

test('every spelling of the unit is accepted', () => {
  for (const source of ['h = 3in', 'h = 3inch', 'h = 3inches', 'h = 3 in', 'h = 3\tin']) {
    assert.equal(inchesAtEnd(source)?.millimetres, '76.2', source);
  }
  // Written as it is in the language, whatever case it is typed in.
  assert.equal(inchesAtEnd('h = 3IN')?.millimetres, '76.2');
});

test('the result is a number, not a float artefact', () => {
  // 5 * 25.4 is 126.99999999999999 in binary floating point, and a file full of
  // those is worse than a file full of `* 25.4`.
  assert.equal(inchesToMillimetres(5), '127');
  assert.equal(inchesToMillimetres(3), '76.2');
  assert.ok(!inchesToMillimetres(0.3).includes('9999'), inchesToMillimetres(0.3));
});

test('a name that merely ends in the unit is left alone', () => {
  // All real things somebody might call a variable.
  for (const source of ['pin5in', 'x = margin', 'min', 'a = bolt2in']) {
    assert.equal(inchesAtEnd(source), undefined, source);
  }
});

test('an unfinished token is not converted', () => {
  // `5in` is a complete measurement and also the first three characters of
  // `5inch`. Converting on sight would turn `5inch` into `127ch`, so nothing is
  // converted until a terminator says the token is done — which is what the
  // editor checks before calling this at all.
  assert.equal(inchesAtEnd('h = 5i'), undefined);
  assert.equal(inchesAtEnd('h = 5'), undefined);
  assert.equal(inchesAtEnd('h = 5inc'), undefined);
});

test('the measurement knows where it starts and what it replaced', () => {
  const found = inchesAtEnd('cylinder(h = 12.5inches');
  assert.equal(found?.original, '12.5inches');
  assert.equal(found?.from, 'cylinder(h = '.length);
  assert.equal(found?.millimetres, '317.5');
});

test('scientific notation is left alone rather than half-read', () => {
  // `1e3in` would otherwise convert the `3` and leave the exponent behind.
  assert.equal(inchesAtEnd('h = 1e3in'), undefined);
});
