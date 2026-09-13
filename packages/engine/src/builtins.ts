/**
 * Built-in *functions* (the expression-level library). Built-in *modules*
 * (`cube`, `translate`, …) live in the interpreter, because they produce scene
 * nodes rather than values.
 *
 * Every function here is written from the documented behaviour of the language,
 * not from upstream source (spec feature 3).
 */

import { SourceSpan } from './diagnostics.js';
import {
  RangeValue,
  Value,
  asNumber,
  echoFormat,
  formatValue,
  isTruthy,
  toStringValue,
  typeOf,
} from './values.js';

export interface BuiltinContext {
  warn(message: string, span?: SourceSpan, code?: string): void;
  span?: SourceSpan;
  /** Shared RNG so repeated `rands()` calls without a seed do not correlate. */
  random(): number;
}

export interface BuiltinDef {
  /** Parameter names, so named arguments (`rands(seed=1)`) resolve correctly. */
  params: string[];
  /** Variadic builtins receive every argument positionally. */
  variadic?: boolean;
  fn(args: Value[], ctx: BuiltinContext): Value;
}

const DEG = Math.PI / 180;

/** Applies a unary math function elementwise over vectors, as OpenSCAD does not — scalar only. */
function num1(f: (x: number) => number): BuiltinDef['fn'] {
  return (args) => {
    const x = args[0];
    if (typeof x !== 'number') return undefined;
    return f(x);
  };
}

/**
 * Trig functions snap near-zero results to exactly zero.
 *
 * Without this, `sin(180)` is 1.2e-16 and every downstream polygon inherits
 * float noise that shows up as non-planar faces and failed booleans.
 */
function snap(x: number): number {
  return Math.abs(x) < 1e-12 ? 0 : x;
}

// ---------------------------------------------------------------------------
// mt19937 — the same core generator OpenSCAD seeds, so seeded runs are
// reproducible and principled. Exact parity with OpenSCAD's distribution
// mapping is not claimed.
// ---------------------------------------------------------------------------

class MersenneTwister {
  private mt = new Uint32Array(624);
  private index = 625;

  constructor(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      // Split the 32x32 multiply so it stays exact in doubles.
      this.mt[i] =
        ((((prev >>> 16) * 1812433253) << 16) + (prev & 0xffff) * 1812433253 + i) >>> 0;
    }
    this.index = 624;
  }

  private generate(): void {
    for (let i = 0; i < 624; i++) {
      const y = ((this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff)) >>> 0;
      let next = this.mt[(i + 397) % 624] ^ (y >>> 1);
      if (y & 1) next ^= 0x9908b0df;
      this.mt[i] = next >>> 0;
    }
    this.index = 0;
  }

  nextUint32(): number {
    if (this.index >= 624) this.generate();
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** Uniform in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }
}

let seededRng: MersenneTwister | undefined;

// ---------------------------------------------------------------------------

export const BUILTIN_FUNCTIONS: Record<string, BuiltinDef> = {
  // --- trigonometry (degrees, as OpenSCAD) ---
  sin: { params: ['x'], fn: num1((x) => snap(Math.sin(x * DEG))) },
  cos: { params: ['x'], fn: num1((x) => snap(Math.cos(x * DEG))) },
  tan: { params: ['x'], fn: num1((x) => snap(Math.tan(x * DEG))) },
  asin: { params: ['x'], fn: num1((x) => Math.asin(x) / DEG) },
  acos: { params: ['x'], fn: num1((x) => Math.acos(x) / DEG) },
  atan: { params: ['x'], fn: num1((x) => Math.atan(x) / DEG) },
  atan2: {
    params: ['y', 'x'],
    fn: (args) => {
      const y = args[0];
      const x = args[1];
      if (typeof y !== 'number' || typeof x !== 'number') return undefined;
      return Math.atan2(y, x) / DEG;
    },
  },

  // --- general maths ---
  abs: { params: ['x'], fn: num1(Math.abs) },
  sign: { params: ['x'], fn: num1(Math.sign) },
  floor: { params: ['x'], fn: num1(Math.floor) },
  ceil: { params: ['x'], fn: num1(Math.ceil) },
  round: {
    params: ['x'],
    // OpenSCAD rounds half away from zero; JS `Math.round` rounds half up.
    fn: num1((x) => (x < 0 ? -Math.round(-x) : Math.round(x))),
  },
  sqrt: { params: ['x'], fn: num1(Math.sqrt) },
  exp: { params: ['x'], fn: num1(Math.exp) },
  ln: { params: ['x'], fn: num1(Math.log) },
  log: { params: ['x'], fn: num1(Math.log10) },
  pow: {
    params: ['base', 'exponent'],
    fn: (args) => {
      const b = args[0];
      const e = args[1];
      if (typeof b !== 'number' || typeof e !== 'number') return undefined;
      return Math.pow(b, e);
    },
  },

  min: { params: [], variadic: true, fn: (args) => minMax(args, Math.min) },
  max: { params: [], variadic: true, fn: (args) => minMax(args, Math.max) },

  norm: {
    params: ['v'],
    fn: (args) => {
      const v = args[0];
      if (!Array.isArray(v)) return undefined;
      let sum = 0;
      for (const e of v) {
        if (typeof e !== 'number') return undefined;
        sum += e * e;
      }
      return Math.sqrt(sum);
    },
  },

  cross: {
    params: ['a', 'b'],
    fn: (args) => {
      const a = args[0];
      const b = args[1];
      if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
      if (a.length !== b.length) return undefined;
      const num = (x: Value): number | undefined => (typeof x === 'number' ? x : undefined);
      if (a.length === 2) {
        const [a0, a1] = [num(a[0]), num(a[1])];
        const [b0, b1] = [num(b[0]), num(b[1])];
        if ([a0, a1, b0, b1].some((n) => n === undefined)) return undefined;
        return a0! * b1! - a1! * b0!; // 2D cross is the scalar z-component
      }
      if (a.length !== 3) return undefined;
      const av = a.map(num);
      const bv = b.map(num);
      if ([...av, ...bv].some((n) => n === undefined)) return undefined;
      return [
        av[1]! * bv[2]! - av[2]! * bv[1]!,
        av[2]! * bv[0]! - av[0]! * bv[2]!,
        av[0]! * bv[1]! - av[1]! * bv[0]!,
      ];
    },
  },

  // --- lists and strings ---
  len: {
    params: ['v'],
    fn: (args) => {
      const v = args[0];
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      return undefined;
    },
  },

  concat: {
    params: [],
    variadic: true,
    // Flattens exactly one level; ranges expand, scalars append.
    fn: (args) => {
      const out: Value[] = [];
      for (const arg of args) {
        if (Array.isArray(arg)) out.push(...arg);
        else if (arg instanceof RangeValue) out.push(...arg.toArray());
        else if (arg !== undefined) out.push(arg);
        else out.push(undefined);
      }
      return out;
    },
  },

  str: {
    params: [],
    variadic: true,
    fn: (args) => args.map(toStringValue).join(''),
  },

  chr: {
    params: [],
    variadic: true,
    fn: (args) => {
      const codes: number[] = [];
      const collect = (v: Value): void => {
        if (typeof v === 'number') codes.push(Math.floor(v));
        else if (Array.isArray(v)) v.forEach(collect);
        else if (v instanceof RangeValue) v.toArray().forEach((n) => codes.push(Math.floor(n)));
      };
      args.forEach(collect);
      return codes
        .filter((c) => c >= 1 && c <= 0x10ffff)
        .map((c) => String.fromCodePoint(c))
        .join('');
    },
  },

  ord: {
    params: ['s'],
    fn: (args) => {
      const s = args[0];
      if (typeof s !== 'string' || s.length === 0) return undefined;
      return s.codePointAt(0);
    },
  },

  lookup: {
    params: ['key', 'table'],
    // Piecewise-linear interpolation over a sorted table of [key, value] pairs.
    fn: (args) => {
      const key = args[0];
      const table = args[1];
      if (typeof key !== 'number' || !Array.isArray(table)) return undefined;
      const pairs: [number, number][] = [];
      for (const row of table) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const k = row[0];
        const v = row[1];
        if (typeof k === 'number' && typeof v === 'number') pairs.push([k, v]);
      }
      if (pairs.length === 0) return undefined;
      pairs.sort((a, b) => a[0] - b[0]);
      if (key <= pairs[0][0]) return pairs[0][1];
      if (key >= pairs[pairs.length - 1][0]) return pairs[pairs.length - 1][1];
      for (let i = 0; i < pairs.length - 1; i++) {
        const [k0, v0] = pairs[i];
        const [k1, v1] = pairs[i + 1];
        if (key >= k0 && key <= k1) {
          if (k1 === k0) return v0;
          return v0 + ((key - k0) / (k1 - k0)) * (v1 - v0);
        }
      }
      return undefined;
    },
  },

  search: {
    params: ['match_value', 'string_or_vector', 'num_returns_per_match', 'index_col_num'],
    fn: (args, ctx) => searchImpl(args, ctx),
  },

  // --- type predicates ---
  is_undef: { params: ['x'], fn: (args) => args[0] === undefined },
  is_bool: { params: ['x'], fn: (args) => typeof args[0] === 'boolean' },
  is_num: { params: ['x'], fn: (args) => typeof args[0] === 'number' && !Number.isNaN(args[0]) },
  is_string: { params: ['x'], fn: (args) => typeof args[0] === 'string' },
  is_list: { params: ['x'], fn: (args) => Array.isArray(args[0]) },
  is_function: { params: ['x'], fn: (args) => typeOf(args[0]) === 'function' },

  // --- randomness ---
  rands: {
    params: ['min_value', 'max_value', 'value_count', 'seed'],
    fn: (args, ctx) => {
      const lo = asNumber(args[0], 0);
      const hi = asNumber(args[1], 1);
      const count = Math.max(0, Math.floor(asNumber(args[2], 1)));
      const seed = args[3];
      if (typeof seed === 'number' && Number.isFinite(seed)) {
        seededRng = new MersenneTwister(Math.floor(seed) >>> 0);
      }
      const draw = (): number => (seededRng ? seededRng.nextFloat() : ctx.random());
      const out: Value[] = [];
      for (let i = 0; i < count; i++) out.push(lo + draw() * (hi - lo));
      return out;
    },
  },

  // --- version ---
  version: { params: [], fn: () => [2021, 1, 0] },
  version_num: { params: [], fn: () => 20210100 },

  // --- BetterSCAD extras (documented as extensions) ---
  is_range: { params: ['x'], fn: (args) => args[0] instanceof RangeValue },
};

function minMax(args: Value[], pick: (...n: number[]) => number): Value {
  // `min(v)` where v is a list reduces the list; `min(a, b, c)` reduces args.
  const values: number[] = [];
  const source = args.length === 1 && Array.isArray(args[0]) ? (args[0] as Value[]) : args;
  for (const v of source) {
    if (typeof v !== 'number') return undefined;
    values.push(v);
  }
  if (values.length === 0) return undefined;
  return pick(...values);
}

/**
 * `search()` — OpenSCAD's general table lookup.
 *
 * Returns, for each element of `match_value`, the indices in
 * `string_or_vector` whose `index_col_num` column equals it.
 * `num_returns_per_match` of 0 means "all matches"; 1 (the default) flattens
 * the result to one index per needle and drops misses.
 */
function searchImpl(args: Value[], ctx: BuiltinContext): Value {
  const needle = args[0];
  const haystack = args[1];
  const perMatch = args[2] === undefined ? 1 : Math.floor(asNumber(args[2], 1));
  const column = args[3] === undefined ? 0 : Math.floor(asNumber(args[3], 0));

  if (haystack === undefined) return [];

  const keyOf = (entry: Value): Value => {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry)) return entry[column];
    return entry;
  };

  const entries: Value[] = typeof haystack === 'string' ? [...haystack] : Array.isArray(haystack) ? haystack : [];

  const needles: Value[] =
    typeof needle === 'string'
      ? [...needle]
      : Array.isArray(needle)
        ? needle
        : [needle];

  // A scalar needle against a list haystack searches for that single value.
  const results: Value[] = [];
  for (const n of needles) {
    const hits: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (valuesMatch(keyOf(entries[i]), n)) {
        hits.push(i);
        if (perMatch > 0 && hits.length >= perMatch) break;
      }
    }
    if (perMatch === 1) {
      if (hits.length > 0) results.push(hits[0]);
      // A miss contributes nothing, which is what makes `search` usable for
      // filtering; callers comparing lengths must account for that.
    } else {
      results.push(hits);
    }
  }

  if (!Array.isArray(needle) && typeof needle !== 'string' && perMatch !== 1) {
    ctx.warn(
      'search() with a scalar needle and num_returns_per_match != 1 returns a nested list.',
      ctx.span,
      'builtin.search-shape',
    );
  }
  return results;
}

function valuesMatch(a: Value, b: Value): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  return false;
}

/** Rendering of a value for `echo()` output. */
export function echoArgs(parts: { name?: string; value: Value }[]): string {
  return parts
    .map((p) => (p.name ? `${p.name} = ${echoFormat(p.value)}` : echoFormat(p.value)))
    .join(', ');
}

export { formatValue, isTruthy };
