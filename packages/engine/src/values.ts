/**
 * The OpenSCAD value model.
 *
 * Values map onto JavaScript directly where the semantics line up — `undef` is
 * `undefined`, vectors are arrays — which keeps the hot path in the evaluator
 * allocation-free. Ranges and function literals need their own carriers.
 */

import { Expr, Parameter } from './ast.js';

export class RangeValue {
  constructor(
    readonly begin: number,
    readonly step: number,
    readonly end: number,
  ) {}

  /**
   * Number of elements the range yields, or `undefined` when it does not
   * terminate (zero/NaN step, or a step pointing away from `end`).
   */
  get length(): number | undefined {
    if (!Number.isFinite(this.begin) || !Number.isFinite(this.end) || !Number.isFinite(this.step)) {
      return undefined;
    }
    if (this.step === 0) return undefined;
    const span = this.end - this.begin;
    if (span === 0) return 1;
    if (Math.sign(span) !== Math.sign(this.step)) return 0;
    return Math.floor(span / this.step + 1e-9) + 1;
  }

  *[Symbol.iterator](): Generator<number> {
    const count = this.length;
    if (count === undefined) return;
    for (let i = 0; i < count; i++) yield this.begin + i * this.step;
  }

  toArray(): number[] {
    return [...this];
  }
}

/** A user function or `function(x) ...` literal, closed over its defining scope. */
export class FunctionValue {
  constructor(
    readonly params: Parameter[],
    readonly body: Expr,
    readonly env: unknown,
    readonly name = 'anonymous',
  ) {}
}

export type Value = undefined | boolean | number | string | Value[] | RangeValue | FunctionValue;

export type ValueType = 'undef' | 'bool' | 'number' | 'string' | 'list' | 'range' | 'function';

export function typeOf(v: Value): ValueType {
  if (v === undefined) return 'undef';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (v instanceof RangeValue) return 'range';
  return 'function';
}

/** Rank used to give `<` a total order across mixed types, as OpenSCAD does. */
const TYPE_RANK: Record<ValueType, number> = {
  undef: 0,
  bool: 1,
  number: 2,
  string: 3,
  list: 4,
  range: 5,
  function: 6,
};

export function isTruthy(v: Value): boolean {
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true; // ranges and functions are always truthy
}

export function isNum(v: Value): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A list whose every element is a finite number. */
export function isNumericVector(v: Value): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'number');
}

export function deepEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return false;
  if (ta === 'list') {
    const la = a as Value[];
    const lb = b as Value[];
    if (la.length !== lb.length) return false;
    return la.every((e, i) => deepEqual(e, lb[i]));
  }
  if (ta === 'range') {
    const ra = a as RangeValue;
    const rb = b as RangeValue;
    return ra.begin === rb.begin && ra.step === rb.step && ra.end === rb.end;
  }
  if (ta === 'undef') return true;
  return false;
}

/** Three-way compare implementing OpenSCAD's `<`/`>` ordering. */
export function compare(a: Value, b: Value): number {
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb];

  switch (ta) {
    case 'undef':
      return 0;
    case 'bool':
      return Number(a as boolean) - Number(b as boolean);
    case 'number': {
      const na = a as number;
      const nb = b as number;
      if (Number.isNaN(na) || Number.isNaN(nb)) return Number.NaN;
      return na === nb ? 0 : na < nb ? -1 : 1;
    }
    case 'string': {
      const sa = a as string;
      const sb = b as string;
      return sa === sb ? 0 : sa < sb ? -1 : 1;
    }
    case 'list': {
      const la = a as Value[];
      const lb = b as Value[];
      const n = Math.min(la.length, lb.length);
      for (let i = 0; i < n; i++) {
        const c = compare(la[i], lb[i]);
        if (c !== 0 || Number.isNaN(c)) return c;
      }
      return la.length - lb.length;
    }
    default:
      return deepEqual(a, b) ? 0 : Number.NaN;
  }
}

/**
 * Formats a number the way OpenSCAD's `str()` and `echo()` do: up to ~6
 * significant digits, no trailing zeros, `inf`/`nan` spelled out.
 */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);

  const rounded = Number.parseFloat(n.toPrecision(6));
  // Round-tripping through toPrecision can leave float noise (0.30000000000000004);
  // prefer the shorter of the two spellings when they agree numerically.
  const short = String(rounded);
  return short.includes('e') ? short.replace('e+', 'e') : short;
}

/** `str()` semantics: strings pass through bare, everything else is formatted. */
export function toStringValue(v: Value): string {
  if (typeof v === 'string') return v;
  return formatValue(v);
}

/** `echo()` / debug spelling: strings are quoted, lists bracketed. */
export function formatValue(v: Value): string {
  switch (typeOf(v)) {
    case 'undef':
      return 'undef';
    case 'bool':
      return v ? 'true' : 'false';
    case 'number':
      return formatNumber(v as number);
    case 'string':
      return v as string;
    case 'list':
      return `[${(v as Value[]).map(formatValueQuoted).join(', ')}]`;
    case 'range': {
      const r = v as RangeValue;
      return `[${formatNumber(r.begin)} : ${formatNumber(r.step)} : ${formatNumber(r.end)}]`;
    }
    default:
      return 'function';
  }
}

/** Inside a list, strings print with quotes; at top level they do not. */
function formatValueQuoted(v: Value): string {
  if (typeof v === 'string') return JSON.stringify(v);
  return formatValue(v);
}

export function echoFormat(v: Value): string {
  return typeof v === 'string' ? JSON.stringify(v) : formatValue(v);
}

// ---------------------------------------------------------------------------
// Coercions used by the geometry builtins
// ---------------------------------------------------------------------------

/** Reads a value as a number, returning `fallback` when it is not one. */
export function asNumber(v: Value, fallback = Number.NaN): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Reads a vector of exactly `size` numbers.
 *
 * A bare number broadcasts to every component (`scale(2)`), a short vector is
 * padded with `fill`, and anything non-numeric yields `undefined` so the caller
 * can report a typed error against the right argument.
 */
export function asVector(v: Value, size: number, fill = 0): number[] | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Array(size).fill(v);
  if (!Array.isArray(v)) return undefined;
  const out = new Array<number>(size).fill(fill);
  for (let i = 0; i < size; i++) {
    const e = v[i];
    if (e === undefined) continue;
    if (typeof e !== 'number' || !Number.isFinite(e)) return undefined;
    out[i] = e;
  }
  return out;
}

/** Flattens a value into an iterable list: ranges expand, scalars wrap. */
export function toList(v: Value): Value[] {
  if (Array.isArray(v)) return v;
  if (v instanceof RangeValue) return v.toArray();
  if (v === undefined) return [];
  return [v];
}
