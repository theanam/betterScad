/**
 * Inch entry, in a language whose only unit is the millimetre.
 *
 * OpenSCAD has no units. Every number is a millimetre by convention, and the
 * whole ecosystem — printers, slicers, hardware tables — agrees. That leaves
 * anyone working from an imperial drawing doing arithmetic in their head, or
 * littering the file with `* 25.4`, which is a thing to get wrong once and then
 * never notice.
 *
 * So the editor accepts the arithmetic instead: type `5in` and it becomes
 * `127` as soon as the measurement is finished. The file that results is
 * ordinary millimetres, which matters more than the convenience — nothing about
 * the saved model depends on this feature, and a file written here opens in
 * OpenSCAD with no idea it was ever typed in inches.
 */

import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** Millimetres in an inch. Exact, by definition, since 1959. */
const MM_PER_INCH = 25.4;

/**
 * A measurement, anchored at the end of the text it was found in.
 *
 * Anchored rather than searched because of what a partial word looks like:
 * `5in` is a complete measurement and also the first three characters of
 * `5inch`. Converting the moment the letters match would turn `5inch` into
 * `127ch`, so nothing is converted until the token is *finished* — which is
 * what the anchor, plus a terminator typed after it, establishes.
 */
const TRAILING_INCHES = /(\d*\.?\d+)[ \t]*(?:in|inch|inches)$/i;

/** Characters that can sit inside a number or a name, and so cannot end one. */
const WORD = /[A-Za-z0-9_$.]/;

export interface Measurement {
  /** Offset of the first digit, within the text searched. */
  from: number;
  /** The millimetre value, formatted for insertion. */
  millimetres: string;
  /** What was written, for the announcement. */
  original: string;
}

/**
 * Millimetres, rounded off the float noise and with no trailing zeros.
 *
 * `5 * 25.4` is 126.99999999999999 in binary floating point, and a file full of
 * numbers like that is worse than one full of `* 25.4`.
 */
export function inchesToMillimetres(inches: number): string {
  return String(Math.round(inches * MM_PER_INCH * 1e6) / 1e6);
}

/**
 * The measurement `text` ends with, if it ends with one.
 *
 * The character before the number has to be one that cannot continue a name,
 * or `pin5in` — a perfectly good variable — would have its tail rewritten.
 */
export function inchesAtEnd(text: string): Measurement | undefined {
  const match = TRAILING_INCHES.exec(text);
  if (!match) return undefined;

  const before = text[match.index - 1];
  if (before !== undefined && WORD.test(before)) return undefined;

  const inches = Number(match[1]);
  if (!Number.isFinite(inches)) return undefined;

  return { from: match.index, millimetres: inchesToMillimetres(inches), original: match[0] };
}

/**
 * Whether a column of a line sits inside a string or a comment.
 *
 * `5in` in a comment is prose and `"5in"` is a label; neither is a measurement.
 * Single-line and deliberately cheap — this runs on every keystroke, and the
 * cost of being wrong about a block comment spanning lines is one conversion
 * that should not have happened, in text that is not geometry either way.
 */
function insideStringOrComment(line: string, column: number): boolean {
  const before = line.slice(0, column);
  if (before.includes('//')) return true;
  let quotes = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '"' && before[i - 1] !== '\\') quotes++;
  }
  return quotes % 2 === 1;
}

/** Marks a conversion that just happened, so it can be flashed. */
const showConversion = StateEffect.define<{ from: number; to: number }>();

const converted = Decoration.mark({ class: 'cm-unitConverted' });

/**
 * Holds the flash for one conversion.
 *
 * A number changing under the cursor with no acknowledgement reads as a bug the
 * first time it happens. The mark carries a CSS animation that fades itself
 * out; the field drops it on the next document change, so it never has to be
 * cleaned up on a timer that could outlive the document it decorated.
 */
const conversionFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(showConversion)) {
        return Decoration.set([converted.range(effect.value.from, effect.value.to)]);
      }
    }
    return tr.docChanged ? Decoration.none : marks.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Converts a measurement as soon as the user finishes typing it.
 *
 * Implemented as a transaction filter so the conversion rides along with the
 * keystroke that completed it. It is a *second* transaction rather than an
 * edit folded into the first, which is what makes undo step back to `5in`
 * rather than swallowing the typing as well: someone who meant the letters
 * gets them back with one undo.
 */
function convertOnInput(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent('input')) return tr;

    const head = tr.newSelection.main.head;
    const line = tr.newDoc.lineAt(head);
    const column = head - line.from;

    // The terminator the user just typed is what says the token is finished,
    // so the text to examine is everything before it.
    const terminator = line.text[column - 1];
    if (terminator === undefined || WORD.test(terminator)) return tr;

    const measurement = inchesAtEnd(line.text.slice(0, column - 1));
    if (!measurement) return tr;
    if (insideStringOrComment(line.text, measurement.from)) return tr;

    const from = line.from + measurement.from;
    const to = from + measurement.original.length;
    const spec: TransactionSpec = {
      changes: { from, to, insert: measurement.millimetres },
      effects: showConversion.of({ from, to: from + measurement.millimetres.length }),
      // These offsets were measured against the document the keystroke
      // produced. Without this they would be read against the document as it
      // was *before* it, and the replacement would land a character early.
      sequential: true,
    };
    return [tr, spec];
  });
}

/** The editor extension. Absent entirely when the setting is off. */
export function inchEntry(): Extension {
  return [conversionFlash, convertOnInput()];
}
