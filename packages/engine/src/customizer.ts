/**
 * Customizer (spec feature 8).
 *
 * Reads OpenSCAD's parameter annotation conventions out of the comments around
 * top-level assignments and produces a UI descriptor the app turns into
 * sliders, dropdowns, checkboxes and text fields.
 *
 * The conventions implemented here:
 *
 *   x = 5;    // [0:100]          slider, min:max
 *   x = 5;    // [0:0.5:100]      slider, min:step:max
 *   x = 5;    // [10]             max only (or max string length)
 *   s = "a";  // [a, b, c]        dropdown of literal values
 *   n = 1;    // [0:None, 1:One]  dropdown of value:label pairs
 *   // A description                      -> label text for the control below
 *   /* [Section] *​/                       -> groups the controls that follow
 *   /* [Hidden] *​/                        -> hides everything after it
 */

import { Expr, ScadFile, Statement } from './ast.js';
import { ParseResult } from './parser.js';
import { RangeValue, Value } from './values.js';

export type ControlKind =
  | 'number'
  | 'slider'
  | 'checkbox'
  | 'text'
  | 'dropdown'
  | 'vector'
  | 'unsupported';

export interface DropdownOption {
  value: Value;
  label: string;
}

export interface CustomizerParameter {
  name: string;
  kind: ControlKind;
  /** The value written in the script, used as the reset target. */
  defaultValue: Value;
  description?: string;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  /** Maximum string length, from the `// [n]` form on a string parameter. */
  maxLength?: number;
  options?: DropdownOption[];
  /** Component count for vector parameters. */
  size?: number;
  line: number;
}

export interface CustomizerModel {
  parameters: CustomizerParameter[];
  groups: string[];
}

const HIDDEN_GROUP = 'Hidden';
const DEFAULT_GROUP = 'Parameters';

/**
 * Extracts the customizable parameters from a parsed file.
 *
 * Only *top-level* assignments with literal values are customizable, which is
 * the same restriction OpenSCAD applies: a parameter has to have a concrete
 * default the UI can show and reset to.
 */
export function buildCustomizerModel(parsed: ParseResult): CustomizerModel {
  const sections = collectSections(parsed);
  const trailing = indexTrailingComments(parsed);
  const descriptions = indexDescriptions(parsed);

  const parameters: CustomizerParameter[] = [];
  const groups: string[] = [];

  for (const stmt of parsed.file.body) {
    if (stmt.kind !== 'assign') continue;
    // `$`-variables are engine settings, not model parameters.
    if (stmt.name.startsWith('$')) continue;

    const line = stmt.span.start.line;
    const group = sectionAt(sections, stmt.span.start.offset);
    if (group === HIDDEN_GROUP) continue;

    const literal = literalValue(stmt.value);
    if (literal === NOT_LITERAL) continue;

    const annotation = trailing.get(line);
    const parameter = describeParameter(
      stmt.name,
      literal,
      annotation,
      descriptions.get(line),
      group,
      line,
    );
    if (parameter.kind === 'unsupported') continue;

    parameters.push(parameter);
    if (!groups.includes(parameter.group)) groups.push(parameter.group);
  }

  return { parameters, groups };
}

// ---------------------------------------------------------------------------
// Comment indexing
// ---------------------------------------------------------------------------

interface Section {
  name: string;
  offset: number;
}

function collectSections(parsed: ParseResult): Section[] {
  const sections: Section[] = [];
  for (const comment of parsed.blockComments) {
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(comment.text);
    if (match) sections.push({ name: match[1].trim(), offset: comment.span.start.offset });
  }
  return sections.sort((a, b) => a.offset - b.offset);
}

function sectionAt(sections: Section[], offset: number): string {
  let current = DEFAULT_GROUP;
  for (const section of sections) {
    if (section.offset < offset) current = section.name;
    else break;
  }
  return current;
}

/** Comments that sit on the same line as (and after) an assignment. */
function indexTrailingComments(parsed: ParseResult): Map<number, string> {
  const map = new Map<number, string>();
  for (const comment of parsed.lineComments) {
    const text = comment.text.replace(/^\/\//, '').trim();
    map.set(comment.span.start.line, text);
  }
  return map;
}

/**
 * Comments on the line(s) directly above an assignment become its label.
 *
 * Only a contiguous run is considered, so a comment separated by a blank line
 * is treated as belonging to whatever came before, not to the parameter.
 */
function indexDescriptions(parsed: ParseResult): Map<number, string> {
  const byLine = new Map<number, string>();
  for (const comment of parsed.lineComments) {
    byLine.set(comment.span.start.line, comment.text.replace(/^\/\//, '').trim());
  }

  const descriptions = new Map<number, string>();
  for (const stmt of parsed.file.body) {
    if (stmt.kind !== 'assign') continue;
    const line = stmt.span.start.line;
    const lines: string[] = [];
    for (let probe = line - 1; probe >= 1; probe--) {
      const text = byLine.get(probe);
      if (text === undefined) break;
      // A `[Section]`-looking line comment is a marker, not a description.
      if (/^\[.+\]$/.test(text)) break;
      lines.unshift(text);
    }
    if (lines.length > 0) descriptions.set(line, lines.join(' ').trim());
  }
  return descriptions;
}

// ---------------------------------------------------------------------------
// Literal extraction
// ---------------------------------------------------------------------------

const NOT_LITERAL = Symbol('not-literal');

/**
 * Reduces an expression to a literal value, or `NOT_LITERAL`.
 *
 * Negative numbers are the one computed form accepted, because `x = -5;` is a
 * unary expression but is obviously a literal to any reader.
 */
function literalValue(expr: Expr): Value | typeof NOT_LITERAL {
  switch (expr.kind) {
    case 'number':
      return expr.value;
    case 'string':
      return expr.value;
    case 'bool':
      return expr.value;
    case 'undef':
      return undefined;
    case 'unary': {
      if (expr.op !== '-' && expr.op !== '+') return NOT_LITERAL;
      const inner = literalValue(expr.operand);
      if (typeof inner !== 'number') return NOT_LITERAL;
      return expr.op === '-' ? -inner : inner;
    }
    case 'list': {
      const out: Value[] = [];
      for (const element of expr.elements) {
        if (element.kind !== 'item') return NOT_LITERAL;
        const value = literalValue(element.value);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        out.push(value);
      }
      return out;
    }
    default:
      return NOT_LITERAL;
  }
}

// ---------------------------------------------------------------------------
// Annotation parsing
// ---------------------------------------------------------------------------

function describeParameter(
  name: string,
  value: Value,
  annotation: string | undefined,
  description: string | undefined,
  group: string,
  line: number,
): CustomizerParameter {
  const base: CustomizerParameter = {
    name,
    kind: 'unsupported',
    defaultValue: value,
    description,
    group,
    line,
  };

  const spec = annotation ? parseAnnotation(annotation) : undefined;

  if (typeof value === 'boolean') return { ...base, kind: 'checkbox' };

  if (typeof value === 'number') {
    if (spec?.kind === 'options') {
      return { ...base, kind: 'dropdown', options: spec.options };
    }
    if (spec?.kind === 'range') {
      return {
        ...base,
        kind: spec.max !== undefined ? 'slider' : 'number',
        min: spec.min,
        max: spec.max,
        step: spec.step,
      };
    }
    return { ...base, kind: 'number' };
  }

  if (typeof value === 'string') {
    if (spec?.kind === 'options') return { ...base, kind: 'dropdown', options: spec.options };
    // `// [n]` on a string means "at most n characters".
    if (spec?.kind === 'range' && spec.max !== undefined && spec.min === undefined) {
      return { ...base, kind: 'text', maxLength: spec.max };
    }
    if (spec?.kind === 'range' && spec.max !== undefined) {
      return { ...base, kind: 'text', maxLength: spec.max };
    }
    return { ...base, kind: 'text' };
  }

  if (Array.isArray(value) && value.length >= 1 && value.length <= 4) {
    if (!value.every((v) => typeof v === 'number')) return base;
    return {
      ...base,
      kind: 'vector',
      size: value.length,
      min: spec?.kind === 'range' ? spec.min : undefined,
      max: spec?.kind === 'range' ? spec.max : undefined,
      step: spec?.kind === 'range' ? spec.step : undefined,
    };
  }

  return base;
}

type Annotation =
  | { kind: 'range'; min?: number; max?: number; step?: number }
  | { kind: 'options'; options: DropdownOption[] };

/** Parses the `[...]` part of a trailing annotation comment. */
export function parseAnnotation(text: string): Annotation | undefined {
  const match = /\[([^\]]*)\]/.exec(text);
  if (!match) return undefined;
  const body = match[1].trim();
  if (body.length === 0) return undefined;

  // A dropdown is signalled by commas; a range by colons.
  if (body.includes(',')) {
    const options: DropdownOption[] = [];
    for (const entry of body.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const colon = trimmed.indexOf(':');
      if (colon >= 0) {
        const rawValue = trimmed.slice(0, colon).trim();
        const label = trimmed.slice(colon + 1).trim();
        options.push({ value: coerceScalar(rawValue), label: label || rawValue });
      } else {
        options.push({ value: coerceScalar(trimmed), label: trimmed });
      }
    }
    return options.length > 0 ? { kind: 'options', options } : undefined;
  }

  const parts = body.split(':').map((p) => p.trim());
  if (parts.length === 1) {
    const max = Number.parseFloat(parts[0]);
    return Number.isFinite(max) ? { kind: 'range', max } : undefined;
  }
  if (parts.length === 2) {
    const [min, max] = parts.map(Number.parseFloat);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      // `[a:b]` with non-numeric bounds is a two-option dropdown.
      return { kind: 'options', options: parts.map((p) => ({ value: p, label: p })) };
    }
    return { kind: 'range', min, max };
  }
  if (parts.length === 3) {
    const [min, step, max] = parts.map(Number.parseFloat);
    if ([min, step, max].every(Number.isFinite)) return { kind: 'range', min, max, step };
  }
  return undefined;
}

/** Dropdown entries are written unquoted; numeric-looking ones become numbers. */
function coerceScalar(raw: string): Value {
  const unquoted = raw.replace(/^"(.*)"$/, '$1');
  if (unquoted !== raw) return unquoted;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNumber = Number(raw);
  return raw !== '' && Number.isFinite(asNumber) ? asNumber : raw;
}

// ---------------------------------------------------------------------------
// Applying values back
// ---------------------------------------------------------------------------

/**
 * Rewrites the source so the given parameter values become the literals in the
 * script.
 *
 * The Customizer normally feeds values in at evaluation time, but saving a
 * configured model needs the values written back into the `.scad` text so the
 * file stands alone.
 */
export function applyParametersToSource(
  source: string,
  file: ScadFile,
  values: Record<string, Value>,
): string {
  // Edits are applied back-to-front so earlier offsets stay valid.
  const edits: { start: number; end: number; text: string }[] = [];

  for (const stmt of file.body) {
    if (stmt.kind !== 'assign') continue;
    if (!(stmt.name in values)) continue;
    edits.push({
      start: stmt.value.span.start.offset,
      end: stmt.value.span.end.offset,
      text: literalToSource(values[stmt.name]),
    });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export function literalToSource(value: Value): string {
  if (value === undefined) return 'undef';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literalToSource).join(', ')}]`;
  if (value instanceof RangeValue) return `[${value.begin}:${value.step}:${value.end}]`;
  return 'undef';
}

/** Statement kinds the Customizer can read; exported for tests. */
export function isCustomizableStatement(stmt: Statement): boolean {
  return stmt.kind === 'assign' && !stmt.name.startsWith('$');
}
