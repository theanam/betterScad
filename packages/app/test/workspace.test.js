/**
 * Workspace session handling.
 *
 * Document ids are the app's only handle on a tab: `active`, `selectDocument`
 * and `closeDocument` all look one up by id. Two documents sharing one is
 * therefore not a cosmetic fault — it makes two tabs into one, and that is what
 * these tests are here to stop happening again.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { Workspace } from '../src/state/workspace.ts';

/** Enough of `localStorage` for `persist` and `restore`. */
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, value),
  removeItem: (key) => void store.delete(key),
};

const STORAGE_KEY = 'betterscad.workspace.v1';

const duplicateIds = (workspace) =>
  workspace.documents.length - new Set(workspace.documents.map((d) => d.id)).size;

beforeEach(() => store.clear());

test('new documents get distinct ids', () => {
  const workspace = new Workspace();
  workspace.createDocument('a.scad', '');
  workspace.createDocument('b.scad', '');
  workspace.createDocument('c.scad', '');
  assert.equal(duplicateIds(workspace), 0);
});

test('a restored session with a gap in its ids still mints unique ones', () => {
  // Closing a tab before reloading is what puts the gap there: the session has
  // two documents whose highest id is 3, and counting them says 2.
  let workspace = new Workspace();
  workspace.createDocument('one.scad', '');
  workspace.createDocument('two.scad', '');
  workspace.createDocument('three.scad', '');
  workspace.closeDocument('doc-2');
  workspace.persist();

  workspace = new Workspace();
  assert.equal(workspace.restore(), true);
  workspace.createDocument('four.scad', '');
  workspace.createDocument('five.scad', '');

  assert.equal(duplicateIds(workspace), 0);
  assert.equal(workspace.documents.length, 4);
});

test('restoring repairs a session whose ids already collide', () => {
  // What the old rule left in people's browsers. Restoring it unchanged would
  // reinstate two tabs that behave as one, so the damage has to be undone on
  // the way in rather than merely not repeated.
  store.set(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      activeId: 'doc-2',
      documents: [
        { id: 'doc-2', name: 'shim.bscad', text: '', savedText: '' },
        { id: 'doc-2', name: 'untitled.bscad', text: '', savedText: '' },
        { id: 'doc-3', name: 'untitled 2.bscad', text: '', savedText: '' },
      ],
    }),
  );

  const workspace = new Workspace();
  assert.equal(workspace.restore(), true);
  assert.equal(workspace.documents.length, 3);
  assert.equal(duplicateIds(workspace), 0);
  // The first of a colliding pair keeps its id, so the active tab is still the
  // one that was active.
  assert.equal(workspace.activeId, 'doc-2');
  assert.equal(workspace.active?.name, 'shim.bscad');

  workspace.createDocument('another.bscad', '');
  assert.equal(duplicateIds(workspace), 0);
});

test('each document is reachable by its own id', () => {
  const workspace = new Workspace();
  workspace.createDocument('one.scad', '');
  workspace.createDocument('two.scad', '');
  workspace.persist();

  const restored = new Workspace();
  restored.restore();
  restored.createDocument('three.scad', '');

  for (const doc of restored.documents) {
    restored.activeId = doc.id;
    assert.equal(restored.active?.name, doc.name);
  }
});

test('closing a tab removes that tab and no other', () => {
  const workspace = new Workspace();
  workspace.createDocument('one.scad', '');
  workspace.createDocument('two.scad', '');
  workspace.persist();

  const restored = new Workspace();
  restored.restore();
  const added = restored.createDocument('three.scad', '');

  restored.closeDocument(added.id);
  assert.deepEqual(
    restored.documents.map((d) => d.name),
    ['one.scad', 'two.scad'],
  );
});
