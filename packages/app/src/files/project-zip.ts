/**
 * The project as a zip, and back.
 *
 * A model that depends on files is not one file any more, and every way of
 * getting it out of the app until now handed over only the text. The zip is the
 * folder the model always assumed it was sitting in: unzip it and the paths in
 * the script resolve, in OpenSCAD as much as here.
 *
 * Which is why it is built from what the render actually resolved rather than
 * from everything in the directory. A zip that carried the whole project would
 * be a backup; this is a copy of one model.
 */

import { createZip, parseFontSpec, readZip, safePath, type ZipEntry } from '@betterscad/engine';

import type { Dependency } from '../render/protocol.js';
import { kindOf, type ProjectFile } from './project-files.js';

/**
 * The note that goes in beside the fonts.
 *
 * Fonts are the one dependency a zip cannot actually satisfy: `text(font =
 * "Orbitron")` names a family, and OpenSCAD looks for families in its font
 * path, not next to the file it is opening. Shipping the file is still worth
 * doing — without it the recipient cannot get the font at all — but shipping it
 * silently would leave them with a folder that renders in the wrong typeface
 * and a directory whose purpose is a guess.
 */
const NOTE_PATH = 'READ ME.txt';
const NOTE_MARKER = 'This model uses fonts that travel with it.';

function fontNote(families: string[]): string {
  return [
    NOTE_MARKER,
    '',
    families.map((family) => `  · ${family}`).join('\n'),
    '',
    'The files are in fonts/. BetterSCAD picks them up if you add them to the',
    'Files panel; OpenSCAD reads fonts from its own font path, so install them',
    'there (or into your system fonts) before opening the model.',
    '',
    'Everything else in this folder resolves as it stands — the paths in the',
    'script are relative to this directory.',
    '',
  ].join('\n');
}

export interface ProjectZipInput {
  /** The document's file name; it lands at the root of the zip. */
  documentName: string;
  /** Already serialised, so `.bscad` metadata is written exactly as Save writes it. */
  documentText: string;
  /** What the last render resolved. */
  dependencies: Dependency[];
  /** Font specs the model asked for, as `fontsUsed` reports them. */
  fontsUsed: string[];
  /** Text of an open tab, by tab name. */
  tabText(name: string): string | undefined;
  projectFile(path: string): ProjectFile | undefined;
  /** Every project file, for matching a used family back to the file supplying it. */
  files: readonly ProjectFile[];
}

export interface ProjectZip {
  data: Uint8Array;
  /** Everything packaged, for the toast and the confirmation dialog. */
  paths: string[];
}

/** Builds the archive. With no dependencies this is just the document, zipped. */
export function buildProjectZip(input: ProjectZipInput): ProjectZip {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { path: input.documentName, data: encoder.encode(input.documentText) },
  ];

  for (const dependency of input.dependencies) {
    if (dependency.source === 'tab') {
      const text = input.tabText(dependency.path);
      // A tab that closed between the render and the zip: skip it rather than
      // writing an empty file the recipient would have to debug.
      if (text !== undefined) entries.push({ path: dependency.path, data: encoder.encode(text) });
    } else {
      const file = input.projectFile(dependency.path);
      if (file) entries.push({ path: file.path, data: file.data });
    }
  }

  // Fonts, which arrive by family rather than by path. Only fonts the user
  // added: a Google family the app downloaded on the model's behalf is one the
  // recipient's copy will download too, and the licence is the upstream
  // project's to hand over, not ours.
  const families: string[] = [];
  for (const spec of input.fontsUsed) {
    const family = parseFontSpec(spec).family;
    if (!family || families.includes(family)) continue;
    const file = input.files.find(
      (f) => f.kind === 'font' && f.family?.toLowerCase() === family.toLowerCase(),
    );
    if (!file) continue;
    families.push(family);
    entries.push({ path: `fonts/${file.path.split('/').pop()}`, data: file.data });
  }

  if (families.length > 0) {
    entries.push({ path: NOTE_PATH, data: encoder.encode(fontNote(families)) });
  }

  // A path can arrive twice — a library open in a tab *and* sitting in the
  // directory, say — and a zip with two entries under one name is a zip whose
  // contents depend on which the reader keeps.
  const seen = new Set<string>();
  const unique = entries.filter((entry) => !seen.has(entry.path) && seen.add(entry.path));

  return { data: createZip(unique), paths: unique.map((e) => e.path) };
}

// ---------------------------------------------------------------------------

export interface OpenedProject {
  /** Root-level `.scad`/`.bscad`, which become tabs. */
  documents: { name: string; text: string }[];
  /** Everything else, which goes into the project directory. */
  files: { path: string; data: Uint8Array }[];
}

/**
 * Reads a zip back into documents and project files.
 *
 * The split is by depth, not by extension: a `.scad` at the root is the model,
 * a `.scad` in a folder is a library it includes. Opening thirty tabs because
 * someone zipped MCAD alongside their bracket would be the wrong reading of the
 * same archive this app writes.
 */
export async function openProjectZip(archive: Uint8Array): Promise<OpenedProject> {
  const decoder = new TextDecoder();
  const documents: OpenedProject['documents'] = [];
  const files: OpenedProject['files'] = [];

  for (const entry of await readZip(archive)) {
    const path = safePath(entry.path);
    if (!path) continue;
    // Skip macOS's resource-fork sidecars, which every zip made on a Mac
    // carries and which mean nothing to anybody.
    if (path.startsWith('__MACOSX/') || path.split('/').pop()?.startsWith('._')) continue;

    const nested = path.includes('/');
    if (!nested && kindOf(path) === 'library') {
      documents.push({ name: path, text: decoder.decode(entry.data) });
      continue;
    }
    // Our own font note, coming back in. Matched on its first line rather than
    // its name alone, so a `READ ME.txt` somebody wrote themselves is kept.
    if (path === NOTE_PATH && decoder.decode(entry.data.subarray(0, NOTE_MARKER.length)) === NOTE_MARKER) {
      continue;
    }
    files.push({ path, data: entry.data });
  }

  return { documents, files };
}
