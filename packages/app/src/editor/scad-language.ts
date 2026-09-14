/**
 * OpenSCAD language support for CodeMirror 6 (spec feature 4).
 *
 * A `StreamLanguage` rather than a Lezer grammar: highlighting needs only
 * token classification, and the engine already owns the authoritative parser.
 * Two parsers with the same grammar is exactly the kind of duplication that
 * drifts, so this one stays deliberately shallow.
 *
 * Token names are mapped through an explicit `tokenTable`, so the highlight
 * theme below binds to tags this file defines rather than to whatever the
 * legacy-mode name table happens to contain.
 */

import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  StringStream,
  syntaxHighlighting,
} from '@codemirror/language';
import { Tag, tags as t } from '@lezer/highlight';

const KEYWORDS = new Set([
  'module', 'function', 'if', 'else', 'for', 'intersection_for', 'let', 'each',
  'include', 'use', 'true', 'false', 'undef',
]);

const TRANSFORMS = new Set([
  'translate', 'rotate', 'scale', 'resize', 'mirror', 'multmatrix', 'color',
  'offset', 'hull', 'minkowski', 'linear_extrude', 'rotate_extrude',
  'projection', 'render', 'union', 'difference', 'intersection', 'group',
  // BetterSCAD additions.
  'negative',
  'translatex', 'translatey', 'translatez',
  'rotatex', 'rotatey', 'rotatez',
  'mirrorx', 'mirrory', 'mirrorz',
]);

const PRIMITIVES = new Set([
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon',
  'text', 'import', 'surface', 'children', 'import_stl', 'import_dxf', 'import_off',
  // BetterSCAD additions.
  'rounded_square', 'rounded_cube', 'regular_polygon', 'thread',
]);

/**
 * `PI` is the only constant stock OpenSCAD defines. Infinity and NaN come from
 * arithmetic (`1 / 0`), not from identifiers, so they are not listed here.
 */
const CONSTANTS = new Set(['PI']);

const BUILTIN_FUNCTIONS = new Set([
  'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'floor',
  'round', 'ceil', 'ln', 'log', 'pow', 'sqrt', 'exp', 'min', 'max', 'norm',
  'cross', 'concat', 'lookup', 'len', 'search', 'str', 'chr', 'ord', 'rands',
  'is_undef', 'is_bool', 'is_num', 'is_string', 'is_list', 'is_function',
  'is_range', 'version', 'version_num', 'echo', 'assert',
]);

/** Tags for the token classes that have no natural equivalent in `@lezer/highlight`. */
export const scadTags = {
  specialVariable: Tag.define(),
  debugModifier: Tag.define(),
  primitive: Tag.define(),
  transform: Tag.define(),
  builtinFunction: Tag.define(),
  constant: Tag.define(),
  userCall: Tag.define(),
  includePath: Tag.define(),
};

/** Token names this parser emits, mapped to the tags above. */
const tokenTable: Record<string, Tag> = {
  scadSpecialVar: scadTags.specialVariable,
  scadModifier: scadTags.debugModifier,
  scadPrimitive: scadTags.primitive,
  scadTransform: scadTags.transform,
  scadBuiltin: scadTags.builtinFunction,
  scadConstant: scadTags.constant,
  scadCall: scadTags.userCall,
  scadIncludePath: scadTags.includePath,
};

interface ScadState {
  /** True while inside a `/* ... *​/` comment that spans lines. */
  inComment: boolean;
}

/** `StringStream.match` returns `boolean | RegExpMatchArray | null`; narrow it. */
function matchText(stream: StringStream, pattern: RegExp): string | undefined {
  const result = stream.match(pattern);
  return Array.isArray(result) ? result[0] : undefined;
}

export const scadStreamParser = StreamLanguage.define<ScadState>({
  name: 'openscad',
  tokenTable,

  startState: () => ({ inComment: false }),

  token(stream: StringStream, state: ScadState): string | null {
    if (state.inComment) {
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.inComment = false;
          return 'comment';
        }
        stream.next();
      }
      return 'comment';
    }

    if (stream.eatSpace()) return null;

    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inComment = true;
      return 'comment';
    }

    // `include <path>` / `use <path>` — the angle brackets delimit a path, not
    // a comparison. This is the one place highlighting needs real context.
    if (matchText(stream, /^(?:include|use)\s*</) !== undefined) {
      stream.eatWhile((ch) => ch !== '>');
      stream.eat('>');
      return 'scadIncludePath';
    }

    if (matchText(stream, /^"(?:[^"\\]|\\.)*"?/) !== undefined) return 'string';
    if (matchText(stream, /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/) !== undefined) return 'number';
    if (matchText(stream, /^\$[A-Za-z_][A-Za-z0-9_]*/) !== undefined) return 'scadSpecialVar';

    const word = matchText(stream, /^[A-Za-z_][A-Za-z0-9_]*/);
    if (word !== undefined) {
      if (KEYWORDS.has(word)) return 'keyword';
      if (CONSTANTS.has(word)) return 'scadConstant';
      if (PRIMITIVES.has(word)) return 'scadPrimitive';
      if (TRANSFORMS.has(word)) return 'scadTransform';
      if (BUILTIN_FUNCTIONS.has(word)) return 'scadBuiltin';
      // A name followed by `(` is a call to a user module or function;
      // anything else is a variable reference.
      return /^\s*\(/.test(stream.string.slice(stream.pos)) ? 'scadCall' : 'variableName';
    }

    // `% # ! *` are modifiers only in statement position. The stream parser
    // cannot know for sure, so it checks what precedes them on the line, which
    // is right for every realistic formatting.
    if (matchText(stream, /^[%#!*](?=\s*[A-Za-z_{])/) !== undefined) {
      const before = stream.string.slice(0, stream.pos - 1).trimEnd();
      const atStatementStart = before === '' || /[;{})]$/.test(before) || /\b(?:else|for|if)\s*$/.test(before);
      return atStatementStart ? 'scadModifier' : 'operator';
    }

    if (matchText(stream, /^(?:<=|>=|==|!=|&&|\|\||[+\-*/%^<>=!?:])/) !== undefined) return 'operator';
    if (matchText(stream, /^[[\]{}(),;.]/) !== undefined) return 'punctuation';

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[}\])]$/,
    wordChars: '$_',
  },
});

/**
 * Highlight theme.
 *
 * Every colour resolves to a brand token, so the editor cannot drift from the
 * rest of the UI and both light and dark work without reconfiguring CodeMirror.
 */
export const scadHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: 'var(--bs-syntax-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--bs-syntax-keyword)', fontWeight: '600' },
  { tag: t.number, color: 'var(--bs-syntax-number)' },
  { tag: t.string, color: 'var(--bs-syntax-string)' },
  { tag: t.operator, color: 'var(--bs-text-muted)' },
  { tag: t.punctuation, color: 'var(--bs-text-muted)' },
  { tag: t.variableName, color: 'var(--bs-text)' },

  { tag: scadTags.primitive, color: 'var(--bs-syntax-type)', fontWeight: '600' },
  { tag: scadTags.transform, color: 'var(--bs-syntax-transform)' },
  { tag: scadTags.builtinFunction, color: 'var(--bs-syntax-builtin)' },
  { tag: scadTags.userCall, color: 'var(--bs-syntax-call)' },
  { tag: scadTags.specialVariable, color: 'var(--bs-syntax-special)' },
  { tag: scadTags.constant, color: 'var(--bs-syntax-special)' },
  { tag: scadTags.includePath, color: 'var(--bs-syntax-number)', fontStyle: 'italic' },
  // Debug modifiers change what renders, so they are shouted, not whispered.
  { tag: scadTags.debugModifier, color: 'var(--bs-syntax-modifier)', fontWeight: '700' },
]);

export function openscad(): LanguageSupport {
  return new LanguageSupport(scadStreamParser, [syntaxHighlighting(scadHighlightStyle)]);
}
