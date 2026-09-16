/**
 * The zip round-trip.
 *
 * The writer has been in the tree since 3MF, but it only ever had to satisfy
 * slicers, which are forgiving about what they will open. Now it writes an
 * archive a person unzips, so the two halves are checked against each other —
 * and against a zip this project did not produce, because an archive that only
 * our own reader can read is not a zip.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, readZip, safePath } from '../dist/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('what the writer writes, the reader reads', async () => {
  const entries = [
    { path: 'model.scad', data: encoder.encode('cube(10);\n') },
    { path: 'MCAD/gears.scad', data: encoder.encode('module gear() {}\n') },
    { path: 'logo.svg', data: encoder.encode('<svg/>') },
  ];

  const files = await readZip(createZip(entries));

  assert.deepEqual(
    files.map((f) => f.path),
    ['model.scad', 'MCAD/gears.scad', 'logo.svg'],
  );
  assert.equal(decoder.decode(files[1].data), 'module gear() {}\n');
});

test('binary entries survive byte for byte', async () => {
  // Every byte value, so a decoding step slipped in anywhere would show up.
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  const [file] = await readZip(createZip([{ path: 'bytes.bin', data }]));
  assert.deepEqual([...file.data], [...data]);
});

test('an empty archive reads as no files', async () => {
  assert.deepEqual(await readZip(createZip([])), []);
});

test('a truncated archive is refused rather than half-read', async () => {
  const archive = createZip([{ path: 'a.txt', data: encoder.encode('a') }]);
  await assert.rejects(() => readZip(archive.slice(0, archive.length - 8)));
});

test('directory entries and deflated entries both come back', async (t) => {
  // Built by the system `zip`, which stores directories as their own entries
  // and deflates anything compressible — neither of which our writer produces,
  // so neither would be covered by a round-trip through it.
  const dir = mkdtempSync(join(tmpdir(), 'bscad-zip-'));
  writeFileSync(join(dir, 'model.scad'), 'x'.repeat(4096));
  execFileSync('mkdir', ['-p', join(dir, 'MCAD')]);
  writeFileSync(join(dir, 'MCAD', 'gears.scad'), 'module gear() {}\n');

  try {
    execFileSync('zip', ['-r', 'project.zip', 'model.scad', 'MCAD'], { cwd: dir });
  } catch {
    t.skip('no zip command available');
    return;
  }

  const files = await readZip(new Uint8Array(readFileSync(join(dir, 'project.zip'))));
  const byPath = new Map(files.map((f) => [f.path, f]));

  // The directory entry is dropped; the two files are not.
  assert.deepEqual([...byPath.keys()].sort(), ['MCAD/gears.scad', 'model.scad']);
  assert.equal(decoder.decode(byPath.get('model.scad').data), 'x'.repeat(4096));
  assert.equal(decoder.decode(byPath.get('MCAD/gears.scad').data), 'module gear() {}\n');
});

test('a path cannot climb out of the directory it is read into', () => {
  assert.equal(safePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(safePath('/absolute/thing.svg'), 'absolute/thing.svg');
  assert.equal(safePath('lib\\win\\gears.scad'), 'lib/win/gears.scad');
  assert.equal(safePath('./a/./b.scad'), 'a/b.scad');
  assert.equal(safePath('../'), '');
});
