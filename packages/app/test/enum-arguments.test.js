/**
 * Completion for arguments that take one of a fixed set of values.
 *
 * Two things are worth holding. That the editor offers them at all — typing
 * `fillet_style = ` used to be answered with every global name in the language.
 * And that what it offers is what the engine accepts: a suggestion the engine
 * then rejects is worse than no suggestion, because it reads as authoritative.
 */

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';

import { Engine } from '@betterscad/engine';
import { ENUM_ARGUMENTS, parameterCompletions } from '../src/editor/signature.ts';

/** Runs the completion source at `|` in the given source. */
function completeAt(source) {
  const pos = source.indexOf('|');
  assert.ok(pos >= 0, 'mark the cursor with |');
  const doc = source.slice(0, pos) + source.slice(pos + 1);
  const state = EditorState.create({ doc });
  return parameterCompletions(new CompletionContext(state, pos, true));
}

const labels = (result) => (result ? result.options.map((o) => o.label) : null);

test('a fixed-set argument offers its values, not the whole language', () => {
  assert.deepEqual(labels(completeAt('cylinder(h = 10, r = 4, fillet_style = |);')), [
    '"round"',
    '"chamfer"',
  ]);
});

test('the values are offered once the quote is open, and filter as you type', () => {
  const result = completeAt('cylinder(h = 10, r = 4, fillet_style = "ch|");');
  assert.deepEqual(labels(result), ['"round"', '"chamfer"']);
  // Replacing from the quote, so the completion cannot nest a second one.
  assert.equal(result.from, 'cylinder(h = 10, r = 4, fillet_style = '.length);
});

test('a closing quote already in the document is not duplicated', () => {
  const result = completeAt('cylinder(h = 10, r = 4, fillet_style = "|");');
  assert.ok(result.options.every((o) => o.apply.endsWith('round') || o.apply.endsWith('chamfer')),
    `expected no trailing quote, got ${result.options.map((o) => o.apply)}`);

  const open = completeAt('cylinder(h = 10, r = 4, fillet_style = |);');
  assert.ok(open.options.every((o) => o.apply.endsWith('"')), 'expected a closing quote to be added');
});

test('text alignment and direction are offered too', () => {
  assert.deepEqual(labels(completeAt('text("hi", halign = |);')), ['"left"', '"center"', '"right"']);
  assert.deepEqual(labels(completeAt('text("hi", direction = |);')),
    ['"ltr"', '"rtl"', '"ttb"', '"btt"']);
});

test('an argument with no fixed set says nothing', () => {
  assert.equal(completeAt('cylinder(h = |);'), null);
  assert.equal(completeAt('cube(size = |);'), null);
});

test('the parameter list is still offered where a parameter goes', () => {
  const result = completeAt('cylinder(h = 10, |);');
  assert.ok(labels(result).includes('fillet_style'), 'expected parameter names, not values');
});

test('every value offered is one the engine accepts', async () => {
  // The catalogue above is hand-written; this is what stops it drifting from
  // the engine that has to honour it.
  const engine = await Engine.create();
  const CALLS = {
    cylinder: (arg, value) => `cylinder(h = 10, r = 4, fillet = 1, ${arg} = "${value}");`,
    text: (arg, value) => `text("Ag", ${arg} = "${value}");`,
  };

  for (const [module, args] of Object.entries(ENUM_ARGUMENTS)) {
    for (const [arg, values] of Object.entries(args)) {
      for (const { value } of values) {
        const source = CALLS[module](arg, value);
        const result = await engine.render(source, { preview: false });
        const complaints = result.diagnostics.filter(
          (d) => (d.severity === 'error' || d.severity === 'warning') && d.message.includes(arg),
        );
        assert.deepEqual(complaints.map((d) => d.message), [], `${source} was rejected`);
      }
    }
  }
});

test('a value the engine would reject is not in the catalogue', async () => {
  // The other direction: proof the test above could actually fail.
  const engine = await Engine.create();
  const result = await engine.render('cylinder(h = 10, r = 4, fillet = 1, fillet_style = "bevel");');
  assert.ok(
    result.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('fillet_style')),
    'expected the engine to complain about an unknown style',
  );
});
