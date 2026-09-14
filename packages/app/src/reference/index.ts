/**
 * The reference catalogue: the whole of the Help & Reference view, the whole of
 * `docs/reference.md`, and the list of screenshots to render, all from here.
 *
 * **Adding a new element is a three-line change plus a command.** Put the entry
 * in the group it belongs to, give its example an `image` id, and run
 * `npm run reference`. The screenshot, the document and the Help view all pick
 * it up; nothing else has to be touched, and nothing can be updated in one
 * place and forgotten in another.
 */

import { FLAT_SHAPES, SOLIDS } from './openscad-shapes.js';
import { BOOLEANS, EXTRUSIONS, TRANSFORMS } from './openscad-transforms.js';
import { FLOW, MODIFIERS, OTHER, SPECIAL_VARIABLES, SYNTAX } from './openscad-language.js';
import { LISTS_AND_STRINGS, MATH, TYPES } from './openscad-functions.js';
import {
  LANGUAGE_ADDITIONS,
  NEGATIVE_SPACE,
  NEW_SHAPES,
  PORTABILITY,
  SHORTHAND,
} from './betterscad.js';
import type { ReferenceEntry, ReferenceSection } from './types.js';

export * from './types.js';

export const SECTIONS: ReferenceSection[] = [
  {
    id: 'openscad',
    title: 'OpenSCAD',
    blurb:
      'The whole OpenSCAD language, which BetterSCAD implements in full. Every file that uses ' +
      'only what is on this page opens unchanged in OpenSCAD itself.',
    groups: [
      SOLIDS,
      FLAT_SHAPES,
      TRANSFORMS,
      BOOLEANS,
      EXTRUSIONS,
      SYNTAX,
      FLOW,
      MODIFIERS,
      SPECIAL_VARIABLES,
      MATH,
      LISTS_AND_STRINGS,
      TYPES,
      OTHER,
    ],
  },
  {
    id: 'betterscad',
    title: 'BetterSCAD additions',
    blurb:
      'What BetterSCAD adds on top, under one rule: every addition has a defined way back to ' +
      'plain `.scad`. Each entry says what it becomes when you save as OpenSCAD.',
    groups: [NEW_SHAPES, NEGATIVE_SPACE, SHORTHAND, LANGUAGE_ADDITIONS, PORTABILITY],
  },
];

/** Every entry, in the order they appear, with the section and group they sit in. */
export function allEntries(): {
  section: ReferenceSection;
  group: { id: string; title: string };
  entry: ReferenceEntry;
}[] {
  const out = [];
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      for (const entry of group.entries) out.push({ section, group, entry });
    }
  }
  return out;
}

/** An entry by id, for cross-references. */
export function entryById(id: string): ReferenceEntry | undefined {
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      const found = group.entries.find((entry) => entry.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Text an entry can be found by: everything visible, plus its keywords.
 *
 * Built once per entry and cached, because the search runs on every keystroke
 * over every entry in the catalogue.
 */
const searchCache = new WeakMap<ReferenceEntry, string>();

export function searchText(entry: ReferenceEntry): string {
  let text = searchCache.get(entry);
  if (text === undefined) {
    text = [
      entry.id,
      entry.name,
      entry.signature ?? '',
      entry.plain,
      ...(entry.details ?? []),
      ...(entry.keywords ?? []),
      ...(entry.params ?? []).map((p) => p.name),
    ]
      .join(' ')
      .toLowerCase();
    searchCache.set(entry, text);
  }
  return text;
}

/** Where a screenshot lives, relative to the app and to `docs/`. */
export const IMAGE_DIR = 'reference';
