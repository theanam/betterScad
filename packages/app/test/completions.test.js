/**
 * Autocomplete call forms.
 *
 * Most builtins here have more than one way of being written, and offering only
 * one of them means everybody who wanted a different one deletes the suggestion
 * before typing what they meant. So every form is offered, under one name, in a
 * fixed order.
 *
 * Two things have to hold for that to work, and neither is obvious from reading
 * the table: CodeMirror drops a completion that matches another on label,
 * detail, type, apply *and* boost, so forms that are not distinct enough simply
 * vanish; and it sorts on `match score + boost`, so the order only holds while
 * the boosts within a group stay ordered and inside the gap between categories.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { currentBuiltins, setRoundMeasure } from '../src/editor/completions.ts';

/** Every completion offered under one name, in the order they are ranked. */
function formsOf(label) {
  return currentBuiltins()
    .filter((c) => c.label === label)
    .sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
}

const LABELS = [...new Set(currentBuiltins().map((c) => c.label))];

test('a builtin with several call forms offers all of them', () => {
  // The one that prompted this: typing `cylinder` used to give the radius form
  // and nothing else, so anyone working in diameters deleted it every time.
  const details = formsOf('cylinder').map((c) => c.detail);
  assert.ok(details.includes('cylinder(h, d)'), `no diameter form: ${details}`);
  assert.ok(details.includes('cylinder(h, r)'), `no radius form: ${details}`);
  assert.ok(
    details.some((d) => d.startsWith('cylinder(h, d1, d2)')),
    `no cone form: ${details}`,
  );
});

test('the commonest form is the one ranked first', () => {
  const expected = {
    cylinder: 'cylinder(h, d)',
    sphere: 'sphere(d)',
    circle: 'circle(d)',
    cube: 'cube(size)',
    translate: 'translate([x, y, z])',
    thread: 'thread(d, pitch, h)  — BetterSCAD',
    for: 'for (var = [from : to])',
  };
  for (const [label, detail] of Object.entries(expected)) {
    assert.equal(formsOf(label)[0]?.detail, detail, `${label} leads with the wrong form`);
  }
});

test('forms are ranked in the order the table writes them', () => {
  for (const label of LABELS) {
    const forms = currentBuiltins().filter((c) => c.label === label);
    for (let i = 1; i < forms.length; i++) {
      assert.ok(
        (forms[i].boost ?? 0) < (forms[i - 1].boost ?? 0),
        `${label}: form ${i} does not rank below the one before it`,
      );
    }
  }
});

test('no form is close enough to another to be dropped', () => {
  // CodeMirror discards a completion matching the previous one on all of
  // these, so a duplicated detail would silently lose a form.
  const seen = new Set();
  for (const c of currentBuiltins()) {
    const key = `${c.label} ${c.detail} ${c.type}`;
    assert.ok(!seen.has(key), `two completions share label and detail: ${c.label} ${c.detail}`);
    seen.add(key);
  }
});

test('extra forms never outrank a different kind of name', () => {
  // Modules sit above keywords above functions, by one. A group deep enough to
  // eat that gap would push a module's last form below an unrelated keyword.
  for (const label of LABELS) {
    const boosts = formsOf(label).map((c) => c.boost ?? 0);
    const spread = Math.max(...boosts) - Math.min(...boosts);
    assert.ok(spread < 1, `${label} spans ${spread} of boost, which crosses into the next category`);
  }
});

test('every form is a snippet that can actually be applied', () => {
  for (const c of currentBuiltins()) {
    // Constants are inserted as their own name, so they carry no snippet.
    if (c.type === 'constant') continue;
    assert.equal(typeof c.apply, 'function', `${c.label} (${c.detail}) has no snippet to apply`);
    assert.ok(c.detail, `${c.label} has a form with no detail to tell it apart by`);
  }
});

test('the round-dimensions setting decides which measurement leads', () => {
  // Radius and diameter are both right, so this is asked rather than guessed.
  // Everything else about the list has to stay where it was.
  try {
    setRoundMeasure('radius');
    assert.deepEqual(
      formsOf('cylinder').map((c) => c.detail),
      [
        'cylinder(h, r)',
        'cylinder(h, r1, r2)  — a cone',
        'cylinder(h, d)',
        'cylinder(h, d, center)',
        'cylinder(h, d1, d2)  — a cone',
        'cylinder(h, d, $fn)',
      ],
    );
    assert.equal(formsOf('sphere')[0].detail, 'sphere(r)');
    assert.equal(formsOf('circle')[0].detail, 'circle(r)');

    // A builtin with nothing to do with circles is untouched by the setting.
    assert.equal(formsOf('cube')[0].detail, 'cube(size)');

    setRoundMeasure('diameter');
    assert.equal(formsOf('cylinder')[0].detail, 'cylinder(h, d)');
    assert.equal(formsOf('sphere')[0].detail, 'sphere(d)');
    assert.equal(formsOf('circle')[0].detail, 'circle(d)');
    assert.equal(formsOf('cube')[0].detail, 'cube(size)');
  } finally {
    setRoundMeasure('diameter');
  }
});

test('switching the setting keeps every form, and keeps them ordered', () => {
  try {
    for (const measure of ['radius', 'diameter']) {
      setRoundMeasure(measure);
      const forms = formsOf('cylinder');
      assert.equal(forms.length, 6, `${measure} lost a form`);
      assert.equal(new Set(forms.map((c) => c.detail)).size, 6, `${measure} duplicated a form`);
      for (let i = 1; i < forms.length; i++) {
        assert.ok(forms[i].boost < forms[i - 1].boost, `${measure}: forms are not ranked`);
      }
    }
  } finally {
    setRoundMeasure('diameter');
  }
});
