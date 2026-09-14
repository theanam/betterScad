/**
 * `npm run reference` — regenerates everything the reference catalogue implies.
 *
 *  1. Renders a screenshot for every example that names one, into
 *     `docs/images/reference/`.
 *  2. Runs every example that declares console output and **fails** if the
 *     engine does not print what the catalogue claims. A reference that quietly
 *     drifts from the implementation is worse than no reference.
 *  3. Writes `docs/reference.md` from the same catalogue, so the document and
 *     the app's Help view cannot disagree.
 *
 * Run it after touching anything in `packages/app/src/reference/`. The
 * contributing rule is that a new element is not finished until this has run.
 *
 * `--check` writes nothing. It still renders every example — so a model that
 * has stopped producing geometry is caught — and reports any screenshot or
 * document that is missing or stale. That is what CI runs.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { build } from 'esbuild';

import { encodePng } from './png.mjs';
import { FRONT_VIEW, ISO_VIEW, PLAN_VIEW, TOP_VIEW, renderGeometry } from './raster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = join(ROOT, 'packages/app/src/reference/index.ts');
const IMAGE_DIR = join(ROOT, 'docs/images/reference');
const DOC = join(ROOT, 'docs/reference.md');

const checkOnly = process.argv.includes('--check');

/**
 * Loads the catalogue, which is TypeScript the app compiles and this script
 * does not.
 *
 * Bundled with esbuild into one throwaway module rather than run through `tsc`:
 * the catalogue is pure data with no runtime dependencies, and a build step
 * whose output has to be kept anywhere is a build step that goes stale.
 */
async function loadCatalog() {
  const bundled = await build({
    entryPoints: [CATALOG],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const source = bundled.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const VIEWS = { iso: ISO_VIEW, top: TOP_VIEW, front: FRONT_VIEW, plan: PLAN_VIEW };

async function main() {
  const { SECTIONS, allEntries } = await loadCatalog();
  const { Engine, FontRegistry } = await import(join(ROOT, 'packages/engine/dist/index.js'));

  // text() needs a real font, and the bundled one is what the app defaults to,
  // so the screenshots match what a reader will see on their own screen.
  const fonts = new FontRegistry();
  const fontFile = join(ROOT, 'packages/app/public/fonts/NotoSans.ttf');
  if (existsSync(fontFile)) fonts.register(await readFile(fontFile));

  const engine = await Engine.create({ fonts });

  if (!checkOnly) await mkdir(IMAGE_DIR, { recursive: true });

  const problems = [];
  const rendered = new Set();
  let images = 0;
  let checks = 0;

  for (const { entry, group } of allEntries()) {
    for (const example of entry.examples ?? []) {
      if (example.norender) continue;
      if (!example.image && !example.output) continue;

      const where = `${group.id}/${entry.id}`;
      let result;
      try {
        // `$preview = false`: these are pictures of what the model *is*, which
        // is what the final render and every export produce. A model that reads
        // `$preview` and simplifies itself would otherwise be documented by its
        // draft version.
        result = await engine.render(example.code, { file: `${entry.id}.scad`, preview: false });
      } catch (err) {
        problems.push(`${where}: render threw — ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'error') problems.push(`${where}: ${diagnostic.message}`);
      }

      if (example.output !== undefined) {
        checks++;
        const actual = result.diagnostics
          .filter((d) => d.severity === 'echo')
          .map((d) => d.message)
          .join('\n');
        if (actual !== example.output) {
          problems.push(
            `${where}: console output does not match.\n    catalogue: ${JSON.stringify(example.output)}\n    engine:    ${JSON.stringify(actual)}`,
          );
        }
      }

      if (!example.image) continue;

      if (rendered.has(example.image)) {
        problems.push(`${where}: image id "${example.image}" is used twice.`);
        continue;
      }
      rendered.add(example.image);

      // Rendered even under `--check`, and the result thrown away. It costs a
      // few seconds and it is what catches an example that has stopped
      // producing geometry because the engine moved under it — which a
      // file-exists check never would.
      const image = renderGeometry(result.geometry, {
        view: VIEWS[example.view ?? 'iso'],
        zoom: example.zoom,
      });
      if (!image) {
        problems.push(`${where}: produced no geometry, so no screenshot. Drop the image id or fix the example.`);
        continue;
      }

      const file = join(IMAGE_DIR, `${example.image}.png`);
      if (checkOnly) {
        // Deliberately not a byte comparison against the committed file. The
        // rasteriser is floating-point and the PNG goes through whichever zlib
        // the runner has, so identical geometry can encode to different bytes
        // on a different machine — a check that fails for that reason is worse
        // than no check.
        if (!existsSync(file)) problems.push(`${where}: ${example.image}.png has not been rendered.`);
        continue;
      }

      await writeFile(file, encodePng(image.rgba, image.width, image.height));
      images++;
    }
  }

  // A renamed entry leaves its old screenshot behind, and nothing else would
  // ever notice: the catalogue is the only thing that names these files.
  if (existsSync(IMAGE_DIR)) {
    for (const name of await readdir(IMAGE_DIR)) {
      if (!name.endsWith('.png')) continue;
      if (rendered.has(name.slice(0, -4))) continue;
      if (checkOnly) problems.push(`${name} is not referenced by any example.`);
      else await rm(join(IMAGE_DIR, name));
    }
  }

  const markdown = renderDocument(SECTIONS);
  if (checkOnly) {
    const current = existsSync(DOC) ? await readFile(DOC, 'utf8') : '';
    if (current !== markdown) problems.push('docs/reference.md is out of date. Run `npm run reference`.');
  } else {
    await writeFile(DOC, markdown);
  }

  const entries = allEntries().length;
  if (checkOnly) {
    console.log(`Checked ${entries} entries, ${rendered.size} screenshots and ${checks} console outputs.`);
  } else {
    console.log(
      `Rendered ${images} screenshot${images === 1 ? '' : 's'}, verified ${checks} console output${checks === 1 ? '' : 's'}, wrote docs/reference.md (${entries} entries).`,
    );
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** GitHub's own heading-anchor rule, for the group headings in the contents. */
function anchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Entries get an explicit HTML anchor rather than relying on the heading one.
 *
 * Half of them would not survive the derivation: `#` and `%` reduce to nothing
 * at all, and `$children` and `children()` both reduce to `children`, leaving
 * one of them silently pointing at the other.
 */
function entryAnchor(entry) {
  return `entry-${entry.id}`;
}

function renderDocument(sections) {
  const out = [];

  out.push('<!-- Generated by `npm run reference` from packages/app/src/reference/. Do not edit. -->');
  out.push('');
  out.push('# Reference');
  out.push('');
  out.push(
    'Every element of the language, explained plainly, with a picture of what each one makes.',
  );
  out.push('');
  out.push(
    'This is the same content as the app’s **Help & Reference** view — the button between Fonts ' +
      'and the theme switch, or `F1` from anywhere. The two are generated from one catalogue, so ' +
      'they cannot disagree.',
  );
  out.push('');
  out.push(
    'Screenshots are rendered by the engine itself, from the code shown beside them. Where a ' +
      'faint grey ghost appears, that is the "before" — a `%` shape marking where the solid ' +
      'started.',
  );
  out.push('');

  // The additions are the shorter half and they come second, so anyone here to
  // find out what BetterSCAD adds would otherwise be scrolling past the whole
  // of OpenSCAD to reach them.
  const additions = sections.find((section) => section.id === 'betterscad');
  if (additions) {
    const count = additions.groups.reduce((n, group) => n + group.entries.length, 0);
    out.push(
      `**Only want what BetterSCAD adds?** Jump to [${additions.title}](#${anchor(additions.title)}) — ` +
        `${count} entries, each saying what it becomes when you save as plain \`.scad\`.`,
    );
    out.push('');
  }

  // Contents
  for (const section of sections) {
    out.push(`**${section.title}** — ${section.groups.map((g) => `[${g.title}](#${anchor(g.title)})`).join(' · ')}`);
    out.push('');
  }

  for (const section of sections) {
    out.push('---');
    out.push('');
    out.push(`# ${section.title}`);
    out.push('');
    out.push(`${section.blurb}`);
    out.push('');

    for (const group of section.groups) {
      out.push(`## ${group.title}`);
      out.push('');
      if (group.blurb) {
        out.push(group.blurb);
        out.push('');
      }

      for (const entry of group.entries) {
        out.push(`<a id="${entryAnchor(entry)}"></a>`);
        out.push('');
        out.push(`### ${entry.name}`);
        out.push('');
        if (entry.signature) {
          out.push('```');
          out.push(entry.signature);
          out.push('```');
          out.push('');
        }
        out.push(entry.plain);
        out.push('');

        for (const example of entry.examples ?? []) {
          out.push('```scad');
          out.push(example.code);
          out.push('```');
          out.push('');
          if (example.image) {
            const alt = (example.caption ?? entry.name).replace(/[`[\]]/g, '');
            out.push(`<img src="images/reference/${example.image}.png" alt="${alt}" width="420">`);
            out.push('');
          }
          if (example.output) {
            out.push('```');
            out.push(example.output);
            out.push('```');
            out.push('');
          }
          if (example.caption) {
            out.push(`*${example.caption}*`);
            out.push('');
          }
        }

        if (entry.params?.length) {
          out.push('| Argument | |');
          out.push('| --- | --- |');
          for (const param of entry.params) {
            out.push(`| \`${param.name}\` | ${param.description} |`);
          }
          out.push('');
        }

        for (const detail of entry.details ?? []) {
          out.push(detail);
          out.push('');
        }

        if (entry.downgrade) {
          out.push(`**Saved as OpenSCAD \`.scad\`:** ${entry.downgrade}`);
          out.push('');
        }

        if (entry.see?.length) {
          const links = entry.see
            .map((id) => {
              const target = findEntry(sections, id);
              return target ? `[\`${target.name}\`](#${entryAnchor(target)})` : `\`${id}\``;
            })
            .join(' · ');
          out.push(`See also: ${links}`);
          out.push('');
        }
      }
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function findEntry(sections, id) {
  for (const section of sections) {
    for (const group of section.groups) {
      const found = group.entries.find((entry) => entry.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

await main();
