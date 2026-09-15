/**
 * The one place the version is changed.
 *
 *   npm run bump -- minor      # an editor, language or extension change
 *   npm run bump -- patch      # a release with no new capability
 *   npm run bump -- 1.4.0      # or say it outright
 *   npm run version:check      # CI: everything still agrees
 *
 * The number lives in ten places — five `package.json` files, a literal in the
 * engine's public API, and four entries in the lock file — and the rule that it
 * gets bumped is only as good as the chance of remembering all of them. So it
 * is not remembered: it is done here, and `--check` fails the build when any of
 * them drifts.
 *
 * Semver, under this project's reading of it:
 *
 *   minor  anything a user can see in the editor, the language, or an
 *          extension: a new element, a new panel, a changed behaviour.
 *   patch  a release that adds no capability — fixes, docs, chores.
 *   major  reserved for a break in the language or the file format.
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `package.json` carrying the project version. */
const MANIFESTS = [
  'package.json',
  'packages/engine/package.json',
  'packages/app/package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
];

/**
 * The engine reports its own version through its public API, and a literal is
 * the only way to do that without a build step that generates a source file.
 * So the literal stays, and this keeps it honest.
 */
const ENGINE_SOURCE = 'packages/engine/src/index.ts';
const ENGINE_PATTERN = /(export const ENGINE_VERSION = ')(\d+\.\d+\.\d+)(')/;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function bump(version, release) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`"${version}" is not a version this project can bump.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (release === 'major') return `${major + 1}.0.0`;
  if (release === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version each source currently claims, for reporting and for `--check`. */
async function readVersions() {
  const found = [];

  for (const file of MANIFESTS) {
    const text = await readFile(join(ROOT, file), 'utf8');
    const match = /"version":\s*"([^"]+)"/.exec(text);
    found.push({ file, version: match?.[1] });
  }

  const engine = await readFile(join(ROOT, ENGINE_SOURCE), 'utf8');
  found.push({ file: ENGINE_SOURCE, version: ENGINE_PATTERN.exec(engine)?.[2] });

  // The lock file records the workspaces' versions too, and `npm ci` refuses to
  // install when they disagree with the manifests — so a bump that skips it
  // fails CI at the first step, before anything it could explain itself in.
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  found.push({ file: 'package-lock.json (version)', version: lock.version });
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key !== '' && !key.startsWith('packages/')) continue;
    if (!entry.version) continue;
    found.push({ file: `package-lock.json (${key || 'root'})`, version: entry.version });
  }

  return found;
}

async function replaceIn(file, pattern, replacement) {
  const path = join(ROOT, file);
  const text = await readFile(path, 'utf8');
  if (!pattern.test(text)) throw new Error(`No version found in ${file}.`);
  // Only the first match: a manifest's dependency versions are not this one.
  await writeFile(path, text.replace(pattern, replacement));
}

async function main() {
  const argument = process.argv[2];

  if (argument === '--check' || argument === undefined) {
    const found = await readVersions();
    const missing = found.filter((entry) => !entry.version);
    const versions = new Set(found.map((entry) => entry.version));

    if (missing.length > 0 || versions.size > 1) {
      console.error('The version does not agree across the project:\n');
      for (const entry of found) console.error(`  ${entry.version ?? '(not found)'}  ${entry.file}`);
      console.error('\nRun `npm run bump -- <major|minor|patch>` rather than editing these by hand.');
      process.exitCode = 1;
      return;
    }

    console.log(`Version ${[...versions][0]}, consistent across ${found.length} places.`);
    return;
  }

  const current = (await readVersions())[0].version;
  const next = SEMVER.test(argument) ? argument : bump(current, argument);
  if (!['major', 'minor', 'patch'].includes(argument) && !SEMVER.test(argument)) {
    throw new Error(`Expected major, minor, patch or a version; got "${argument}".`);
  }

  for (const file of MANIFESTS) {
    await replaceIn(file, /"version":\s*"[^"]+"/, `"version": "${next}"`);
  }
  await replaceIn(ENGINE_SOURCE, ENGINE_PATTERN, `$1${next}$3`);

  // npm owns the lock file's shape; rewriting it by hand is how a lock file
  // stops matching what npm would have produced.
  execFileSync('npm', ['install', '--package-lock-only', '--silent'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  console.log(`${current} -> ${next}`);
  console.log('Remember the reference: a new element also needs `npm run reference`.');
}

await main();
