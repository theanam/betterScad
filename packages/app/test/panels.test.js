/**
 * The panel arrangement: presets, moves, and saved layouts coming back.
 *
 * The layout UI only renders what these functions return, so the rules that
 * matter — every panel is somewhere exactly once, a move lands where the drop
 * indicator was drawn, a damaged or old saved layout still opens — are held
 * here rather than by dragging things around a browser.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  PANEL_IDS,
  PRESETS,
  fromPreset,
  movePanel,
  sanitize,
  shown,
} from '../src/state/panels.ts';
import { Workspace } from '../src/state/workspace.ts';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, value),
  removeItem: (key) => void store.delete(key),
};
beforeEach(() => store.clear());

const everyPanelOnce = (a) => {
  const all = [...a.columns[0], ...a.columns[1]];
  return all.length === PANEL_IDS.length && PANEL_IDS.every((id) => all.includes(id));
};

test('every preset places every panel exactly once', () => {
  for (const preset of PRESETS) {
    assert.ok(everyPanelOnce(fromPreset(preset.id)), preset.id);
  }
});

test('the default is the layout the app has always had', () => {
  const a = fromPreset('default');
  assert.deepEqual(a.columns, [['editor', 'customizer', 'files'], ['viewport', 'console']]);
  assert.deepEqual(shown(a, 0), ['editor']);
  assert.deepEqual(shown(a, 1), ['viewport', 'console']);
  assert.equal(a.split, 0.44);
  assert.equal(a.maximized, null);
});

test('model focus hides the code and nothing else that was showing', () => {
  const a = fromPreset('model');
  assert.equal(a.visible.editor, false);
  assert.equal(a.visible.viewport, true);
  assert.equal(a.visible.console, true);
});

test('a preset is copied, so editing an arrangement cannot edit the preset', () => {
  const a = fromPreset('default');
  a.columns[0].push('viewport');
  a.visible.files = true;
  assert.deepEqual(fromPreset('default').columns[0], ['editor', 'customizer', 'files']);
  assert.equal(fromPreset('default').visible.files, false);
});

test('a move lands at the slot the indicator was drawn at', () => {
  const a = fromPreset('default');
  // Console to the top of the left column.
  assert.deepEqual(movePanel(a, 'console', 0, 0).columns, [
    ['console', 'editor', 'customizer', 'files'],
    ['viewport'],
  ]);
  // Editor to the end of the right column.
  assert.deepEqual(movePanel(a, 'editor', 1, 2).columns, [
    ['customizer', 'files'],
    ['viewport', 'console', 'editor'],
  ]);
  // Within a column, downward: the slot counts the column before the move.
  assert.deepEqual(movePanel(a, 'editor', 0, 3).columns[0], ['customizer', 'files', 'editor']);
  // And upward.
  assert.deepEqual(movePanel(a, 'files', 0, 0).columns[0], ['files', 'editor', 'customizer']);
  for (const [id, column, index] of [['console', 0, 0], ['editor', 1, 2], ['viewport', 0, 1]]) {
    assert.ok(everyPanelOnce(movePanel(a, id, column, index)), `${id} -> ${column}:${index}`);
  }
});

test('a saved layout that is damaged still opens', () => {
  // A panel listed twice, and one missing: the columns go back to the default,
  // but the valid parts of what was saved are kept.
  const repaired = sanitize({
    columns: [['editor', 'editor'], ['viewport', 'console', 'files']],
    visible: { editor: false, viewport: true, console: 'yes' },
    weights: { viewport: 60, console: -5 },
    split: 7,
    maximized: 'nonsense',
  });
  assert.ok(everyPanelOnce(repaired));
  assert.deepEqual(repaired.columns, fromPreset('default').columns);
  assert.equal(repaired.visible.editor, false);
  assert.equal(repaired.visible.console, true, 'a non-boolean keeps the default');
  assert.equal(repaired.weights.viewport, 60);
  assert.equal(repaired.weights.console, fromPreset('default').weights.console);
  assert.equal(repaired.split, 0.88, 'clamped to a usable column');
  assert.equal(repaired.maximized, null);
});

test('a maximized panel that is hidden is not maximized', () => {
  const a = sanitize({ ...fromPreset('default'), maximized: 'files' });
  assert.equal(a.maximized, null);
  const b = sanitize({ ...fromPreset('default'), maximized: 'viewport' });
  assert.equal(b.maximized, 'viewport');
});

test('a session saved before panels could move keeps its layout', () => {
  // The five loose fields the layout used to be stored in.
  store.set(
    'betterscad.workspace.v1',
    JSON.stringify({
      version: 1,
      documents: [],
      layout: {
        editorFraction: 0.3,
        consoleFraction: 0.4,
        customizerVisible: true,
        consoleVisible: false,
        filesVisible: true,
        showGrid: false,
      },
    }),
  );
  const workspace = new Workspace();
  assert.ok(workspace.restore());
  const { panels } = workspace.layout;
  assert.equal(panels.split, 0.3);
  assert.equal(panels.visible.customizer, true);
  assert.equal(panels.visible.console, false);
  assert.equal(panels.visible.files, true);
  assert.ok(Math.abs(panels.weights.console / (panels.weights.console + panels.weights.viewport) - 0.4) < 1e-9);
  assert.equal(workspace.layout.showGrid, false, 'other settings are untouched');
  // Read once, into the arrangement, and not carried forward.
  assert.equal('consoleVisible' in workspace.layout, false);
});

test('an arrangement survives a reload', () => {
  const workspace = new Workspace();
  workspace.layout.panels = { ...movePanel(fromPreset('tune'), 'files', 0, 0), maximized: 'viewport' };
  workspace.persist();
  const reloaded = new Workspace();
  assert.ok(reloaded.restore());
  assert.deepEqual(reloaded.layout.panels, workspace.layout.panels);
});

test('a new workspace does not share the default arrangement', () => {
  const workspace = new Workspace();
  workspace.layout.panels.visible.files = true;
  assert.equal(new Workspace().layout.panels.visible.files, false);
});
