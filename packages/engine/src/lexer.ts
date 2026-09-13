/**
 * Hand-written lexer for the OpenSCAD language (and the BetterSCAD superset).
 *
 * Written from scratch — no grammar, tables or code derived from the original
 * OpenSCAD project (spec feature 3).
 *
 * Two context-sensitive details are resolved here rather than in the parser:
 *  - `include <path>` / `use <path>` scan an angle-bracket path as one token,
 *    because `<` and `>` are otherwise comparison operators.
 *  - `%`, `#`, `!` and `*` are emitted as ordinary operator tokens; the parser
 *    decides whether a given occurrence is a debug modifier or arithmetic,
 *    since that depends purely on statement-vs-expression position.
 */

import { Diagnostic, Position, SourceSpan, position } from './diagnostics.js';

export enum T {
  Number = 'number',
  String = 'string',
  Identifier = 'identifier',
  Keyword = 'keyword',
  Punct = 'punct',
  IncludePath = 'include-path',
  EOF = 'eof',
}

export interface Token {
  kind: T;
  /** Raw lexeme for puncts/identifiers/keywords; decoded value for strings. */
  text: string;
  /** Parsed numeric value, only for `T.Number`. */
  value?: number;
  span: SourceSpan;
}

export const KEYWORDS = new Set([
  'module',
  'function',
  'if',
  'else',
  'for',
  'intersection_for',
  'let',
  'each',
  'true',
  'false',
  'undef',
  'include',
  'use',
]);

/**
 * Multi-character operators, longest first so that greedy matching is correct
 * (`<=` must win over `<`, `&&` over a stray `&`).
 */
const PUNCTUATORS = [
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '#',
  '<',
  '>',
  '=',
  '?',
  ':',
  ';',
  ',',
  '.',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
  /**
   * Raw `//`-comment lines with their source offsets, kept for the Customizer,
   * which reads parameter annotations out of comments (spec feature 8).
   */
  lineComments: { text: string; span: SourceSpan }[];
  /** `/* ... *\/` comments, which carry the Customizer's `[Section]` markers. */
  blockComments: { text: string; span: SourceSpan }[];
}

export function lex(source: string, file = '<input>'): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const lineComments: { text: string; span: SourceSpan }[] = [];
  const blockComments: { text: string; span: SourceSpan }[] = [];

  let i = 0;
  let line = 1;
  let col = 1;

  const here = (): Position => position(i, line, col);

  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const spanFrom = (start: Position): SourceSpan => ({ file, start, end: here() });

  const push = (kind: T, text: string, start: Position, value?: number): void => {
    tokens.push({ kind, text, value, span: spanFrom(start) });
  };

  /** True when the previous significant token was `include` or `use`. */
  const expectingIncludePath = (): boolean => {
    const prev = tokens[tokens.length - 1];
    return !!prev && prev.kind === T.Keyword && (prev.text === 'include' || prev.text === 'use');
  };

  while (i < source.length) {
    const c = source[i];

    // --- whitespace ---
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      advance();
      continue;
    }

    // --- comments ---
    if (c === '/' && source[i + 1] === '/') {
      const start = here();
      let text = '';
      while (i < source.length && source[i] !== '\n') {
        text += source[i];
        advance();
      }
      lineComments.push({ text, span: spanFrom(start) });
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const start = here();
      advance(2);
      let closed = false;
      let body = '';
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          advance(2);
          closed = true;
          break;
        }
        body += source[i];
        advance();
      }
      blockComments.push({ text: body, span: spanFrom(start) });
      if (!closed) {
        diagnostics.push({
          severity: 'error',
          message: 'Unterminated block comment.',
          span: spanFrom(start),
          code: 'lex.unterminated-comment',
        });
      }
      continue;
    }

    // --- include/use paths: `<some/file.scad>` ---
    if (c === '<' && expectingIncludePath()) {
      const start = here();
      advance();
      let path = '';
      while (i < source.length && source[i] !== '>' && source[i] !== '\n') {
        path += source[i];
        advance();
      }
      if (source[i] !== '>') {
        diagnostics.push({
          severity: 'error',
          message: 'Unterminated include path; expected `>`.',
          span: spanFrom(start),
          code: 'lex.unterminated-include',
        });
      } else {
        advance();
      }
      push(T.IncludePath, path, start);
      continue;
    }

    // --- numbers ---
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const start = here();
      let text = '';
      while (i < source.length && isDigit(source[i])) {
        text += source[i];
        advance();
      }
      if (source[i] === '.') {
        text += '.';
        advance();
        while (i < source.length && isDigit(source[i])) {
          text += source[i];
          advance();
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        // Only consume the exponent if it is well-formed; otherwise `1eggs`
        // should lex as `1` followed by an identifier.
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j++;
        if (isDigit(source[j])) {
          while (i < j) {
            text += source[i];
            advance();
          }
          while (i < source.length && isDigit(source[i])) {
            text += source[i];
            advance();
          }
        }
      }
      push(T.Number, text, start, Number.parseFloat(text));
      continue;
    }

    // --- strings ---
    if (c === '"') {
      const start = here();
      advance();
      let out = '';
      let closed = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '"') {
          advance();
          closed = true;
          break;
        }
        if (ch === '\n') break; // unterminated: strings do not span lines
        if (ch === '\\') {
          advance();
          const esc = source[i];
          switch (esc) {
            case 'n':
              out += '\n';
              advance();
              break;
            case 't':
              out += '\t';
              advance();
              break;
            case 'r':
              out += '\r';
              advance();
              break;
            case '\\':
              out += '\\';
              advance();
              break;
            case '"':
              out += '"';
              advance();
              break;
            case 'u':
            case 'U': {
              // \u{1F600} and the fixed-width \uXXXX / \UXXXXXXXX forms.
              const width = esc === 'u' ? 4 : 6;
              advance();
              let hex = '';
              if (source[i] === '{') {
                advance();
                while (i < source.length && source[i] !== '}') {
                  hex += source[i];
                  advance();
                }
                if (source[i] === '}') advance();
              } else {
                for (let k = 0; k < width && /[0-9a-fA-F]/.test(source[i] ?? ''); k++) {
                  hex += source[i];
                  advance();
                }
              }
              const cp = Number.parseInt(hex, 16);
              out += Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
              break;
            }
            default:
              // OpenSCAD keeps unknown escapes literally, backslash included.
              out += '\\';
              break;
          }
          continue;
        }
        out += ch;
        advance();
      }
      if (!closed) {
        diagnostics.push({
          severity: 'error',
          message: 'Unterminated string literal.',
          span: spanFrom(start),
          code: 'lex.unterminated-string',
        });
      }
      push(T.String, out, start);
      continue;
    }

    // --- identifiers and keywords ---
    if (isIdentStart(c)) {
      const start = here();
      let text = '';
      while (i < source.length && isIdentPart(source[i])) {
        text += source[i];
        advance();
      }
      push(KEYWORDS.has(text) ? T.Keyword : T.Identifier, text, start);
      continue;
    }

    // --- operators and punctuation ---
    const matched = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (matched) {
      const start = here();
      advance(matched.length);
      push(T.Punct, matched, start);
      continue;
    }

    // --- anything else ---
    const start = here();
    advance();
    diagnostics.push({
      severity: 'error',
      message: `Unexpected character ${JSON.stringify(c)}.`,
      span: spanFrom(start),
      code: 'lex.unexpected-char',
    });
  }

  const end = here();
  tokens.push({ kind: T.EOF, text: '<eof>', span: { file, start: end, end } });
  return { tokens, diagnostics, lineComments, blockComments };
}
