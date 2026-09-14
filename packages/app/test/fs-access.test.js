/**
 * Save outcomes.
 *
 * `saveTextAs` and `saveBinaryAs` used to answer with a handle or nothing, and
 * nothing meant two opposite things: the user cancelled the picker, or this
 * browser has no picker and downloaded the file instead. Every caller read it
 * as the second. Cancelling Save As therefore announced a save, and — the part
 * that actually loses work — marked the document clean, taking the dirty dot
 * and the unsaved-changes warning with it.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

/** A picker that behaves the way Chrome's does, per test. */
function stubWindow({ cancel = false, writeFails = false } = {}) {
  const written = [];
  globalThis.window = {
    showOpenFilePicker: () => {},
    showSaveFilePicker: async () => {
      if (cancel) throw new DOMException('The user aborted a request.', 'AbortError');
      return {
        name: 'chosen.bscad',
        queryPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (value) => {
            if (writeFails) throw new Error('disk full');
            written.push(value);
          },
          close: async () => {},
        }),
      };
    },
  };
  globalThis.document = undefined;
  return written;
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

/** Imported fresh each time: the module reads `window` at load to probe support. */
async function load() {
  return import(`../src/files/fs-access.ts?${Math.random()}`);
}

test('cancelling the picker reports a cancellation, not a save', async () => {
  const written = stubWindow({ cancel: true });
  const { saveTextAs, wroteAFile } = await load();

  const outcome = await saveTextAs('untitled.bscad', 'cube(10);');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(wroteAFile(outcome), false);
  assert.deepEqual(written, []);
});

test('a completed save reports the handle it wrote to', async () => {
  const written = stubWindow();
  const { saveTextAs, wroteAFile } = await load();

  const outcome = await saveTextAs('untitled.bscad', 'cube(10);');
  assert.equal(outcome.status, 'saved');
  assert.equal(outcome.handle?.name, 'chosen.bscad');
  assert.equal(wroteAFile(outcome), true);
  assert.deepEqual(written, ['cube(10);']);
});

test('a picker that succeeds but a write that fails is not a save', async () => {
  // Permission can be withdrawn, or the disk fill, between choosing the file
  // and writing to it. This used to return the handle regardless.
  stubWindow({ writeFails: true });
  const { saveTextAs, wroteAFile } = await load();

  const outcome = await saveTextAs('untitled.bscad', 'cube(10);');
  assert.equal(outcome.status, 'failed');
  assert.equal(wroteAFile(outcome), false);
});

test('cancelling a binary save reports a cancellation', async () => {
  stubWindow({ cancel: true });
  const { saveBinaryAs, wroteAFile } = await load();

  const outcome = await saveBinaryAs('model.stl', new Uint8Array([1, 2, 3]), 'model/stl');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(wroteAFile(outcome), false);
});
