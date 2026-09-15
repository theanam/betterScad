/**
 * `npm run specimens` — renders a preview of every font in the Google catalogue.
 *
 * The font picker could not show you a font until you had loaded it, which is
 * the wrong way round: loading it is the decision the preview is supposed to
 * inform. Previewing by downloading is not an option here — the catalogue is
 * served as raw `.ttf` from GitHub, so there is no subsetting, and rendering
 * forty-eight specimens would mean pulling tens of megabytes of font to draw
 * eleven characters each.
 *
 * So the specimens are drawn once, here, and shipped as outlines.
 *
 * **SVG paths rather than images.** They are a fraction of the size of a
 * bitmap, they stay sharp at any zoom, and `fill: currentColor` means one file
 * serves the light theme and the dark one. A PNG would have needed two, at 2x,
 * and would still have been soft on a 3x display.
 *
 * Downloads are cached in `.font-cache/`, so a re-run costs nothing and the
 * network is only needed when the catalogue changes. The output is committed;
 * the app never generates it.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import opentype from 'opentype.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'packages/app/public/fonts/google-fonts-index.json');
const OUT = join(ROOT, 'packages/app/public/fonts/specimens.json');
const CACHE = join(ROOT, '.font-cache');
const CDN = 'https://raw.githubusercontent.com/google/fonts/main/';

/**
 * What the preview says.
 *
 * Both cases and the figures, in eleven characters. `G` and `g` earn their
 * place: the double- or single-storey `g` and the spur on the `G` are where two
 * faces differ most visibly, and a specimen of `AaBbCc` alone can leave two
 * quite different fonts looking alike.
 */
const SPECIMEN = 'AaBbGg 0123';

/** Em size the outlines are drawn at. The app scales the result by height. */
const EM = 100;

/**
 * Decimals kept in the path data.
 *
 * None: at an em of 100 a whole unit is one percent of the em, which at the
 * twenty-odd pixels these are drawn at is a fifth of a pixel. Keeping one
 * decimal made the file 50% larger and looked identical.
 */
const PRECISION = 0;

const checkOnly = process.argv.includes('--check');

async function fontBytes(entry) {
  const cached = join(CACHE, entry.path.replace(/[^\w.-]/g, '_'));
  if (existsSync(cached)) return readFile(cached);

  const response = await fetch(CDN + entry.path);
  if (!response.ok) throw new Error(`${entry.family}: ${response.status} fetching ${entry.path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, bytes);
  return bytes;
}

/**
 * One specimen, as a path and the box it sits in.
 *
 * The box runs from the font's own ascender to its own descender, so every
 * preview shares a baseline and fonts keep their real relative size — a face
 * with a small x-height should look smaller, because it is.
 */
function specimen(font) {
  const scale = EM / font.unitsPerEm;
  const ascender = font.ascender * scale;
  const descender = font.descender * scale;

  // opentype draws in SVG's own coordinates, y down from the baseline given.
  const path = font.getPath(SPECIMEN, 0, ascender, EM);
  const d = path.toPathData(PRECISION);
  if (!d) return undefined;

  const width = font.getAdvanceWidth(SPECIMEN, EM);
  return {
    d,
    width: Number(width.toFixed(PRECISION)),
    height: Number((ascender - descender).toFixed(PRECISION)),
  };
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));

  // `--check` never downloads. The risk it guards against is a family added to
  // the catalogue without regenerating, and that is answerable from the two
  // files alone — pulling forty-eight fonts to confirm it would make the check
  // need the network, which is the last thing a CI step should need.
  if (checkOnly) {
    if (!existsSync(OUT)) {
      console.error('specimens.json is missing. Run `npm run specimens`.');
      process.exitCode = 1;
      return;
    }
    const sheet = JSON.parse(await readFile(OUT, 'utf8'));
    const missing = catalog.filter((entry) => !sheet.fonts?.[entry.family]).map((e) => e.family);
    const extra = Object.keys(sheet.fonts ?? {}).filter(
      (family) => !catalog.some((entry) => entry.family === family),
    );
    if (missing.length > 0 || extra.length > 0) {
      console.error('specimens.json does not match the catalogue. Run `npm run specimens`.');
      for (const family of missing) console.error(`  - no specimen for ${family}`);
      for (const family of extra) console.error(`  - ${family} is no longer in the catalogue`);
      process.exitCode = 1;
      return;
    }
    console.log(`${catalog.length} specimens, one per catalogue family.`);
    return;
  }

  const specimens = {};
  const problems = [];

  for (const entry of catalog) {
    try {
      const bytes = await fontBytes(entry);
      // opentype wants a real ArrayBuffer, and a Buffer's may be a slice of a
      // larger pool — so the bytes are copied rather than handed over.
      const font = opentype.parse(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      const drawn = specimen(font);
      if (!drawn) {
        problems.push(`${entry.family}: produced no outline`);
        continue;
      }
      specimens[entry.family] = drawn;
    } catch (err) {
      problems.push(`${entry.family}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const payload = `${JSON.stringify({ text: SPECIMEN, em: EM, fonts: specimens }, null, 0)}\n`;
  await writeFile(OUT, payload);

  const missing = catalog.filter((entry) => !specimens[entry.family]).length;
  console.log(
    `${Object.keys(specimens).length} of ${catalog.length} specimens` +
      `${missing ? `, ${missing} missing` : ''}, ${(payload.length / 1024).toFixed(0)} kB`,
  );

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

await main();
