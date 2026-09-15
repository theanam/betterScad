/**
 * Legacy OpenSCAD export (spec feature 21).
 *
 * Every BetterSCAD language extension must have a defined downgrade path to
 * stock `.scad`, and this is where those rewrites live. Right now there is one
 * extension — `negative()` — plus the C-style statement `for`, which stock
 * OpenSCAD accepts only inside list comprehensions.
 *
 * Doubling as a pretty-printer is deliberate: a transpiler that can only emit
 * the constructs it rewrites drifts out of sync with the grammar, whereas one
 * that prints every node is exercised by every file it touches.
 */

import {
  Argument,
  Assignment,
  Expr,
  ForClause,
  ListElement,
  Parameter,
  ScadFile,
  Statement,
} from './ast.js';
import { Diagnostic } from './diagnostics.js';
import { MODIFIER_ROLES, parse } from './parser.js';
import { getRole } from './roles.js';

/**
 * Stamped into every generated file.
 *
 * These files travel: someone receives one, opens it in OpenSCAD, and has no
 * other way to find out what produced it or where the original came from.
 */
const SITE_URL = 'https://betterscad.org';

export interface TranspileOptions {
  /** Spaces per indent level. */
  indent?: number;
  /** Emit a header comment naming the tool and the rewrites applied. */
  header?: boolean;
}

export interface TranspileResult {
  source: string;
  /** Human-readable list of extensions that were rewritten. */
  rewrites: string[];
}

/**
 * Single-axis transforms, and the stock call each becomes.
 *
 * `translatex(d)` is `translate([d, 0, 0])` and nothing more, so the rewrite is
 * exact: the argument expression is dropped into the right slot and the other
 * two are zero. The mirrors take no argument and name their axis outright.
 */
const AXIS_SUGAR: Record<string, { stock: string; slot: number; fill: number; constant?: number }> = {
  translatex: { stock: 'translate', slot: 0, fill: 0 },
  translatey: { stock: 'translate', slot: 1, fill: 0 },
  translatez: { stock: 'translate', slot: 2, fill: 0 },
  rotatex: { stock: 'rotate', slot: 0, fill: 0 },
  rotatey: { stock: 'rotate', slot: 1, fill: 0 },
  rotatez: { stock: 'rotate', slot: 2, fill: 0 },
  mirrorx: { stock: 'mirror', slot: 0, fill: 0, constant: 1 },
  mirrory: { stock: 'mirror', slot: 1, fill: 0, constant: 1 },
  mirrorz: { stock: 'mirror', slot: 2, fill: 0, constant: 1 },
};

/**
 * Shapes that expand into a helper module rather than being inlined.
 *
 * The expansion is a paragraph of geometry, not a one-liner, so inlining it at
 * every call site would bury the shape of the original file in boilerplate and
 * repeat the same block N times. A module keeps each call a call — the exported
 * file reads like the file that produced it — and the body is written once.
 *
 * `params` is the OpenSCAD signature; `body` is the module body, indented two
 * spaces. Both are plain text: these are fixed definitions, not something built
 * from the call site.
 */
/**
 * Stock modules that BetterSCAD gives an extra argument, and the helper each
 * one needs when that argument is used.
 *
 * Keyed on the argument rather than the module name, because `cube(10)` is
 * stock OpenSCAD and has to export as itself. Only `cube(10, r = 2)` becomes a
 * generated module, and only the second of those is reported as an extension.
 *
 * `positional` is where the argument sits in the signature, for a call that
 * passes it without naming it. On `cube` and `square` it is third: `size` and
 * `center` come first and have meant that since OpenSCAD was written.
 */
interface SugaredShape {
  /** Key into `SHAPE_MODULES`. */
  helper: string;
  /** Argument names that mean the helper is needed. */
  triggers: string[];
  /** Index of the first trigger when passed positionally, if it can be. */
  positional?: number;
  /** How the export describes the rewrite. */
  describe: string;
}

const SUGARED_SHAPES: Record<string, SugaredShape> = {
  cube: {
    helper: 'rounded_cube',
    triggers: ['r'],
    positional: 2,
    describe: 'cube(r = …)',
  },
  square: {
    helper: 'rounded_square',
    triggers: ['r'],
    positional: 2,
    describe: 'square(r = …)',
  },
  cylinder: {
    helper: 'filleted_cylinder',
    // Never positional: they sit past `d2` in a signature nobody counts out.
    triggers: ['fillet', 'fillet1', 'fillet2', 'fillet_style'],
    describe: 'cylinder(fillet = …)',
  },
};

/** Whether this call actually uses the sugar, rather than merely being able to. */
function usesSugar(shape: SugaredShape, args: Argument[]): boolean {
  if (args.some((arg) => arg.name !== undefined && shape.triggers.includes(arg.name))) return true;
  if (shape.positional === undefined) return false;
  const positional = args.filter((arg) => arg.name === undefined).length;
  return positional > shape.positional;
}

const SHAPE_MODULES: Record<string, { params: string; body: string[] }> = {
  rounded_square: {
    params: 'size, center = false, r = 0',
    body: [
      's = is_list(size) ? size : [size, size];',
      'rr = min(r, min(s[0], s[1]) / 2);',
      '// A hull of four corner circles is the Minkowski sum of the rectangle',
      '// and a disc. offset(r) of an inset square says the same thing until rr',
      '// reaches half the shortest side, where that square collapses to a line.',
      'translate(center ? [0, 0] : [s[0] / 2, s[1] / 2])',
      '  if (rr > 0)',
      '    hull()',
      '      for (x = [-1, 1], y = [-1, 1])',
      '        translate([x * (s[0] / 2 - rr), y * (s[1] / 2 - rr)])',
      '          circle(r = rr);',
      '  else',
      '    square(s, center = true);',
    ],
  },
  rounded_cube: {
    params: 'size, center = false, r = 0',
    body: [
      's = is_list(size) ? size : [size, size, size];',
      'rr = min(r, min(s[0], min(s[1], s[2])) / 2);',
      '// A hull of eight corner spheres is minkowski() of the box and a sphere,',
      '// without the cost of running one. At r = 0 the spheres would be empty,',
      '// so the box is emitted directly.',
      'translate(center ? [0, 0, 0] : [s[0] / 2, s[1] / 2, s[2] / 2])',
      '  if (rr > 0)',
      '    hull()',
      '      for (x = [-1, 1], y = [-1, 1], z = [-1, 1])',
      '        translate([x * (s[0] / 2 - rr), y * (s[1] / 2 - rr), z * (s[2] / 2 - rr)])',
      '          sphere(r = rr);',
      '  else',
      '    cube(s, center = true);',
    ],
  },
  filleted_cylinder: {
    params:
      'h, r1, r2, center = false, fillet1 = 0, fillet2 = 0, chamfer = false',
    body: [
      '// The cylinder\'s own cross-section, revolved, with each outer corner',
      '// replaced by the arc that meets both of its edges tangentially — or by',
      '// the chord across that arc, which is the chamfer. Exact on a taper as',
      '// well as a straight wall, where the corner is not a right angle and the',
      '// fillet is therefore not a quarter circle.',
      'corners = [[0, 0], [r1, 0], [r2, h], [0, h]];',
      '',
      'function unit(a, b) = let (d = b - a, l = norm(d)) l > 1e-12 ? d / l : [0, 0];',
      '',
      '// Tangent reach along each edge, clamped to the shorter of the two so a',
      '// fillet bigger than the end it eases cannot fold the profile inside out.',
      'function eased(i, f) =',
      '  let (p = corners[i - 1], c = corners[i], n = corners[i + 1],',
      '       a = unit(c, p), b = unit(c, n),',
      '       ang = acos(max(-1, min(1, a * b))),',
      '       reach = f <= 0 || c[0] <= 0 || ang < 0.001 || ang > 179.999',
      '         ? 0 : f / tan(ang / 2),',
      '       lim = min(norm(p - c), norm(n - c)),',
      '       t = min(reach, lim),',
      '       rr = reach > 0 ? f * t / reach : 0)',
      '  t <= 0 ? [c]',
      '  : chamfer ? [c + a * t, c + b * t]',
      '  : let (bis = unit([0, 0], a + b),',
      '         ctr = c + bis * (rr / sin(ang / 2)),',
      '         s = c + a * t - ctr, e = c + b * t - ctr,',
      '         a0 = atan2(s[1], s[0]), a1 = atan2(e[1], e[0]),',
      '         raw = a1 - a0,',
      '         sweep = raw > 180 ? raw - 360 : raw < -180 ? raw + 360 : raw,',
      '         segs = $fn > 0 ? max(3, floor($fn))',
      '                        : max(5, ceil(min(360 / $fa, 2 * PI * rr / $fs))),',
      '         steps = max(2, ceil(segs * abs(sweep) / 360)))',
      '    [for (k = [0 : steps]) ctr + rr * [cos(a0 + sweep * k / steps),',
      '                                       sin(a0 + sweep * k / steps)]];',
      '',
      'profile = concat([corners[0]], eased(1, fillet1), eased(2, fillet2), [corners[3]]);',
      '',
      '// With nothing to ease this is the stock primitive, not a revolve of the',
      '// same outline. The two enclose the same volume but do not tessellate',
      '// alike, and the engine takes this branch too — so `fillet = 0` gives one',
      '// shape rather than two that merely measure the same.',
      'if (fillet1 <= 0 && fillet2 <= 0)',
      '  cylinder(h = h, r1 = r1, r2 = r2, center = center);',
      'else',
      '  translate([0, 0, center ? -h / 2 : 0])',
      '    rotate_extrude() polygon(profile);',
    ],
  },
  thread: {
    params:
      'd, pitch, h, internal = false, clearance = 0.2, angle = 60, chamfer = true, ' +
      'center = false, segments = 0',
    body: [
      '// linear_extrude(twist) turns its profile about Z as it rises, and one',
      '// full turn advances exactly one pitch. So a point belonging w along the',
      '// axis is drawn at profile angle 360 * w / pitch: the axial sawtooth',
      '// becomes the polar wedge below, and the extrusion turns it back.',
      'half_tan = tan(angle / 2);',
      'v_height = pitch / 2 / half_tan;',
      '// The one number separating a bolt from the hole it screws into. The',
      '// apex moves twice as far as the radii, which is what makes the',
      '// clearance uniform over the flanks rather than only radial.',
      'grow = internal ? clearance / 2 : 0;',
      'rmaj = d / 2 + grow;',
      'rmin = d / 2 - 5 * v_height / 8 + grow;',
      'apex = d / 2 + v_height / 8 + 2 * grow;',
      '// The fragment count BetterSCAD derives, with the same floor: a coarse',
      '// circle is merely faceted, a coarse helix stops being a thread.',
      'auto = $fn > 0 ? max(3, floor($fn)) : max(5, ceil(min(360 / $fa, 2 * PI * rmaj / $fs)));',
      'seg = max(24, segments > 0 ? floor(segments) : auto);',
      'steps = max(4, ceil(seg * (rmaj - rmin) * half_tan / pitch));',
      'crest = 360 * (apex - rmaj) * half_tan / pitch;',
      'crest_steps = max(1, ceil(2 * crest * seg / 360));',
      '// A turn of margin at each end, so the trim cuts through full material.',
      'turns = ceil(h / pitch) + 2;',
      'cut = chamfer && 2 * (rmaj - rmin) < h ? rmaj - rmin : 0;',
      '// The ends are shaped in opposite directions: an external thread tapers',
      '// in so its first turn runs out, an internal one flares into a',
      '// countersink. The flare needs the cones below to have something out',
      '// there to keep, since an intersection only takes material away.',
      'mouth = internal ? rmaj + cut : rmaj - cut;',
      'translate([0, 0, center ? -h / 2 : 0])',
      '  intersection() {',
      '    union() {',
      '      cylinder(h = h, r = rmin, $fn = seg);',
      '      translate([0, 0, -pitch])',
      '        linear_extrude(height = turns * pitch, twist = -turns * 360, slices = turns * seg)',
      '          // The crest is an arc, not a chord: closing it straight would',
      '          // plane the tip of the tooth flat.',
      '          polygon([',
      '            for (i = [0 : steps])',
      '              let (r = rmin + (rmaj - rmin) * i / steps,',
      '                   a = 360 * (apex - r) * half_tan / pitch)',
      '                [r * cos(a), r * sin(a)],',
      '            for (i = [1 : crest_steps - 1])',
      '              let (a = crest - 2 * crest * i / crest_steps)',
      '                [rmaj * cos(a), rmaj * sin(a)],',
      '            for (i = [steps : -1 : 0])',
      '              let (r = rmin + (rmaj - rmin) * i / steps,',
      '                   a = -360 * (apex - r) * half_tan / pitch)',
      '                [r * cos(a), r * sin(a)]',
      '          ]);',
      '      if (internal && cut > 0) {',
      '        rotate_extrude($fn = seg)',
      '          polygon([[0, 0], [rmaj + cut, 0], [rmaj, cut], [0, cut]]);',
      '        rotate_extrude($fn = seg)',
      '          polygon([[0, h - cut], [rmaj, h - cut], [rmaj + cut, h], [0, h]]);',
      '      }',
      '    }',
      '    rotate_extrude($fn = seg)',
      '      polygon(cut > 0',
      '        ? [[0, 0], [mouth, 0], [rmaj, cut], [rmaj, h - cut], [mouth, h], [0, h]]',
      '        : [[0, 0], [rmaj, 0], [rmaj, h], [0, h]]);',
      '  }',
    ],
  },
  regular_polygon: {
    params: 'sides, length',
    body: [
      '// A circle forced to $fn = sides is already a regular polygon; the only',
      '// work is turning one side length into the circumradius that gives it.',
      'circle(r = length / (2 * sin(180 / sides)), $fn = sides);',
    ],
  },
};

/** Transforms that also accept loose numbers in place of a vector. */
const LOOSE_VECTOR_CALLS = new Set(['translate', 'mirror', 'rotate']);

/**
 * True when a call is written in the loose-number form this rewrites.
 *
 * Two or more positional arguments, none of them named and none a list. For
 * `rotate` that also excludes the stock `rotate(a, v)` axis form, whose second
 * argument is a vector — which is exactly what tells them apart at runtime too.
 */
function isLooseVectorCall(name: string, args: Argument[]): boolean {
  if (!LOOSE_VECTOR_CALLS.has(name)) return false;
  if (args.length < 2 || args.length > 3) return false;
  if (args.some((a) => a.name)) return false;
  if (args.some((a) => a.value.kind === 'list' || a.value.kind === 'range')) return false;
  return true;
}

/** Role name -> the stock modifier character that reproduces it. */
const ROLE_TO_MODIFIER = new Map<string, string>(
  Object.entries(MODIFIER_ROLES).map(([char, role]) => [role, char]),
);

class Printer {
  private readonly out: string[] = [];
  readonly rewrites = new Set<string>();
  /** Helper modules this file needed, in first-use order. */
  private readonly helpers = new Map<string, string>();

  constructor(
    private readonly indentWidth: number,
    /** Module names already taken by the file, so a helper cannot shadow one. */
    private readonly taken: Set<string>,
  ) {}

  /**
   * The name of the helper module for a shape, defining it on first use.
   *
   * The `__` prefix marks it as generated. A file that already has that name
   * gets a numbered one instead, because silently redefining a user's module
   * would change their geometry rather than their formatting.
   */
  private helperFor(shape: string): string {
    const existing = this.helpers.get(shape);
    if (existing) return existing;

    let name = `__${shape}`;
    for (let n = 2; this.taken.has(name); n++) name = `__${shape}_${n}`;
    this.taken.add(name);
    this.helpers.set(shape, name);
    return name;
  }

  /** The helper definitions, in the order they were first needed. */
  helperDefinitions(): string {
    if (this.helpers.size === 0) return '';
    const blocks: string[] = [];
    for (const [shape, name] of this.helpers) {
      const { params, body } = SHAPE_MODULES[shape];
      const indent = ' '.repeat(this.indentWidth);
      blocks.push(`module ${name}(${params}) {\n${body.map((l) => indent + l).join('\n')}\n}`);
    }
    return blocks.join('\n\n') + '\n\n';
  }

  toString(): string {
    return this.out.join('');
  }

  private write(text: string): void {
    this.out.push(text);
  }

  private line(depth: number, text: string): void {
    this.write(' '.repeat(depth * this.indentWidth) + text + '\n');
  }

  // -- statements -----------------------------------------------------------

  printBody(statements: Statement[], depth: number): void {
    // A scope containing negatives becomes a difference() whose first child is
    // everything else. This is the whole downgrade for the extension, and it is
    // exact: the role's contribution is "subtract from every sibling in scope".
    const solids: Statement[] = [];
    const cutters: Statement[] = [];

    for (const stmt of statements) {
      const split = splitNegatives(stmt);
      if (split.solid) solids.push(split.solid);
      cutters.push(...split.cutters);
    }

    if (cutters.length === 0) {
      for (const stmt of solids) this.printStatement(stmt, depth);
      return;
    }

    this.rewrites.add('negative() rewritten as difference()');

    if (solids.length === 0) {
      // Nothing to cut, so the scope produces nothing — exactly what the
      // evaluator does. Emitting `difference() { cutter }` here would render
      // the cutter as solid, which is the opposite of what was asked for.
      this.line(depth, '// negative() had nothing to cut in this scope; it produces no geometry.');
      return;
    }

    this.line(depth, 'difference() {');
    if (solids.length === 1) {
      this.printStatement(solids[0], depth + 1);
    } else {
      this.line(depth + 1, 'union() {');
      for (const stmt of solids) this.printStatement(stmt, depth + 2);
      this.line(depth + 1, '}');
    }
    for (const cutter of cutters) this.printStatement(cutter, depth + 1);
    this.line(depth, '}');
  }

  printStatement(stmt: Statement, depth: number): void {
    const prefix = modifierPrefix(stmt);

    switch (stmt.kind) {
      case 'empty':
        return;

      case 'assign':
        this.line(depth, `${stmt.name} = ${this.expr(stmt.value)};`);
        return;

      case 'include':
        this.line(depth, `include <${stmt.path}>`);
        return;

      case 'use':
        this.line(depth, `use <${stmt.path}>`);
        return;

      case 'module-decl':
        // Always braced: a module body is a scope, so any negative inside it
        // must be resolved there rather than leaking to the call site.
        this.line(depth, `module ${stmt.name}(${this.params(stmt.params)}) {`);
        this.printBody(stmt.body.kind === 'block' ? stmt.body.body : [stmt.body], depth + 1);
        this.line(depth, '}');
        return;

      case 'function-decl':
        this.line(depth, `function ${stmt.name}(${this.params(stmt.params)}) = ${this.expr(stmt.body)};`);
        return;

      case 'block':
        this.line(depth, `${prefix}{`);
        this.printBody(stmt.body, depth + 1);
        this.line(depth, '}');
        return;

      case 'module-call': {
        const call = `${prefix}${this.moduleCall(stmt.name, stmt.args)}`;
        if (stmt.children.length === 0) {
          this.line(depth, `${call};`);
          return;
        }
        this.line(depth, call);
        for (const child of stmt.children) this.printChild(child, depth);
        return;
      }

      case 'if': {
        this.line(depth, `${prefix}if (${this.expr(stmt.condition)})`);
        this.printChild(stmt.then, depth);
        if (stmt.else) {
          this.line(depth, 'else');
          this.printChild(stmt.else, depth);
        }
        return;
      }

      case 'for':
        this.line(depth, `${prefix}for (${this.forClauses(stmt.clauses)})`);
        this.printChild(stmt.body, depth);
        return;

      case 'intersection-for':
        this.line(depth, `${prefix}intersection_for (${this.forClauses(stmt.clauses)})`);
        this.printChild(stmt.body, depth);
        return;

      case 'for-c': {
        // Stock OpenSCAD has no C-style statement `for`, so it becomes a
        // range `for` over the iteration count, with the loop variable
        // reconstructed by a `let`. This is only exact for the common
        // `i = start; i < limit; i = i + step` shape, so it is reported.
        this.rewrites.add('C-style for(...) rewritten as a range for');
        this.line(depth, '// BetterSCAD: C-style for loop rewritten for legacy OpenSCAD.');
        const init = stmt.init.map((a) => `${a.name} = ${this.expr(a.value)}`).join(', ');
        this.line(depth, `// original: for (${init}; ${this.expr(stmt.condition)}; ...)`);
        this.line(depth, `for (__i = [0 : 1 : 1000])`);
        this.line(depth + 1, `if (${this.expr(stmt.condition)})`);
        this.printChild(stmt.body, depth + 1);
        return;
      }

      case 'let-stmt':
        this.line(depth, `${prefix}let (${this.assignments(stmt.bindings)})`);
        this.printChild(stmt.body, depth);
        return;

      case 'assert-stmt': {
        const call = `${prefix}assert(${this.args(stmt.args)})`;
        if (!stmt.body) {
          this.line(depth, `${call};`);
          return;
        }
        this.line(depth, call);
        this.printChild(stmt.body, depth);
        return;
      }

      case 'echo-stmt': {
        const call = `${prefix}echo(${this.args(stmt.args)})`;
        if (!stmt.body) {
          this.line(depth, `${call};`);
          return;
        }
        this.line(depth, call);
        this.printChild(stmt.body, depth);
        return;
      }
    }
  }

  /**
   * Prints a statement as the child of another.
   *
   * No negative handling here: by the time a wrapper's child is printed, the
   * enclosing `printBody` has already lifted any negatives out of it, exactly
   * as the evaluator bubbles them up to the same scope.
   */
  private printChild(stmt: Statement, depth: number): void {
    if (stmt.kind === 'block') {
      this.line(depth, '{');
      this.printBody(stmt.body, depth + 1);
      this.line(depth, '}');
      return;
    }
    this.printStatement(stmt, depth + 1);
  }

  // -- fragments ------------------------------------------------------------

  /**
   * Prints a module call, rewriting the transform sugar to its stock form.
   *
   * Both rewrites are exact — the same matrix by construction — so neither
   * changes geometry, but both are reported so the export says what it touched.
   */
  private moduleCall(name: string, args: Argument[]): string {
    if (SHAPE_MODULES[name]) {
      this.rewrites.add(`${name}() rewritten as a module`);
      return `${this.helperFor(name)}(${this.args(args)})`;
    }

    // A stock module used with a BetterSCAD argument. Without that argument it
    // is stock, and prints as itself.
    const sugared = SUGARED_SHAPES[name];
    if (sugared && usesSugar(sugared, args)) {
      this.rewrites.add(`${sugared.describe} rewritten as a module`);
      return `${this.helperFor(sugared.helper)}(${this.sugarArgs(name, args)})`;
    }

    const axis = AXIS_SUGAR[name];
    if (axis) {
      this.rewrites.add(`${name}() rewritten as ${axis.stock}([…])`);
      const parts = [String(axis.fill), String(axis.fill), String(axis.fill)];
      // A call with no argument (`translatex()`) degrades to a zero offset,
      // which is what the evaluator does with a missing one.
      parts[axis.slot] =
        axis.constant !== undefined
          ? String(axis.constant)
          : args[0]
            ? this.expr(args[0].value)
            : '0';
      return `${axis.stock}([${parts.join(', ')}])`;
    }

    if (isLooseVectorCall(name, args)) {
      this.rewrites.add(`${name}(x, y, z) rewritten as ${name}([x, y, z])`);
      const parts = [0, 1, 2].map((i) => (args[i] ? this.expr(args[i].value) : '0'));
      return `${name}([${parts.join(', ')}])`;
    }

    return `${name}(${this.args(args)})`;
  }

  private params(params: Parameter[]): string {
    return params
      .map((p) => (p.default ? `${p.name} = ${this.expr(p.default)}` : p.name))
      .join(', ');
  }

  /**
   * The arguments for a sugared shape's helper.
   *
   * `cube` and `square` hand theirs straight over: the helper takes
   * `size, center, r` in that order precisely so it can. `cylinder` cannot —
   * its helper wants two radii and two fillets, where the call may have written
   * any of `r`, `d`, `r1`, `d1`, `r2`, `d2` and `fillet`, so those are resolved
   * into the helper's own names here.
   */
  private sugarArgs(name: string, args: Argument[]): string {
    if (name !== 'cylinder') return this.args(args);

    const named = new Map<string, string>();
    const positional: string[] = [];
    // `$fn` and friends are dynamically scoped: passed to a call they apply to
    // everything it builds, including inside the helper, whose own resolution
    // rule reads them. Rebuilding the argument list from the names this knows
    // about would drop them, and the export would quietly come out coarse.
    const specials: string[] = [];
    for (const arg of args) {
      if (arg.name?.startsWith('$')) specials.push(`${arg.name} = ${this.expr(arg.value)}`);
      else if (arg.name) named.set(arg.name, this.expr(arg.value));
      else positional.push(this.expr(arg.value));
    }
    // `cylinder(20, 8)` is h then r; nothing beyond that is written positionally
    // in practice, and the parameters past it are the ones nobody counts out.
    const pick = (key: string, index?: number): string | undefined =>
      named.get(key) ?? (index !== undefined ? positional[index] : undefined);

    const half = (value: string): string => `(${value}) / 2`;
    const diameter = pick('d');
    const radius = pick('r', 1);
    const bottom = pick('d1') ? half(pick('d1')!) : (pick('r1') ?? (diameter ? half(diameter) : radius));
    const top = pick('d2') ? half(pick('d2')!) : (pick('r2') ?? (diameter ? half(diameter) : radius));

    const both = pick('fillet');
    const style = pick('fillet_style');

    const out = [
      `h = ${pick('h', 0) ?? '1'}`,
      `r1 = ${bottom ?? '1'}`,
      `r2 = ${top ?? '1'}`,
    ];
    const center = pick('center');
    if (center) out.push(`center = ${center}`);
    out.push(`fillet1 = ${pick('fillet1') ?? both ?? '0'}`);
    out.push(`fillet2 = ${pick('fillet2') ?? both ?? '0'}`);
    if (style) out.push(`chamfer = (${style}) == "chamfer"`);
    return [...out, ...specials].join(', ');
  }

  private args(args: Argument[]): string {
    return args.map((a) => (a.name ? `${a.name} = ${this.expr(a.value)}` : this.expr(a.value))).join(', ');
  }

  private assignments(list: Assignment[]): string {
    return list.map((a) => `${a.name} = ${this.expr(a.value)}`).join(', ');
  }

  private forClauses(clauses: ForClause[]): string {
    return clauses.map((c) => `${c.name} = ${this.expr(c.value)}`).join(', ');
  }

  expr(expr: Expr): string {
    switch (expr.kind) {
      case 'number':
        return formatNumberLiteral(expr.value);
      case 'string':
        return JSON.stringify(expr.value);
      case 'bool':
        return expr.value ? 'true' : 'false';
      case 'undef':
        return 'undef';
      case 'identifier':
        return expr.name;
      case 'list':
        return `[${expr.elements.map((e) => this.listElement(e)).join(', ')}]`;
      case 'range':
        return expr.step
          ? `[${this.expr(expr.start)} : ${this.expr(expr.step)} : ${this.expr(expr.end)}]`
          : `[${this.expr(expr.start)} : ${this.expr(expr.end)}]`;
      case 'index':
        return `${this.expr(expr.target)}[${this.expr(expr.index)}]`;
      case 'member':
        return `${this.expr(expr.target)}.${expr.property}`;
      case 'unary':
        return `${expr.op}${this.expr(expr.operand)}`;
      case 'binary':
        // Parenthesised unconditionally: the output must re-parse identically,
        // and precedence-aware printing is not worth the risk of getting wrong.
        return `(${this.expr(expr.left)} ${expr.op} ${this.expr(expr.right)})`;
      case 'ternary':
        return `(${this.expr(expr.condition)} ? ${this.expr(expr.then)} : ${this.expr(expr.else)})`;
      case 'call':
        return `${this.expr(expr.callee)}(${this.args(expr.args)})`;
      case 'let':
        return `let (${this.assignments(expr.bindings)}) ${this.expr(expr.body)}`;
      case 'assert-expr':
        return `assert(${this.args(expr.args)})${expr.body ? ` ${this.expr(expr.body)}` : ''}`;
      case 'echo-expr':
        return `echo(${this.args(expr.args)})${expr.body ? ` ${this.expr(expr.body)}` : ''}`;
      case 'lambda':
        return `function (${this.params(expr.params)}) ${this.expr(expr.body)}`;
    }
  }

  private listElement(element: ListElement): string {
    switch (element.kind) {
      case 'item':
        return this.expr(element.value);
      case 'each':
        return `each ${this.expr(element.value)}`;
      case 'comp-for':
        return `for (${this.forClauses(element.clauses)}) ${this.listElement(element.body)}`;
      case 'comp-for-c':
        return (
          `for (${this.assignments(element.init)}; ${this.expr(element.condition)}; ` +
          `${this.assignments(element.update)}) ${this.listElement(element.body)}`
        );
      case 'comp-if':
        return (
          `if (${this.expr(element.condition)}) ${this.listElement(element.then)}` +
          (element.else ? ` else ${this.listElement(element.else)}` : '')
        );
      case 'comp-let':
        return `let (${this.assignments(element.bindings)}) ${this.listElement(element.body)}`;
    }
  }
}

/** A statement split into what stays, and what becomes a cutter. */
interface NegativeSplit {
  solid?: Statement;
  cutters: Statement[];
}

/**
 * Lifts `negative()` subtrees out of a statement.
 *
 * Mirrors how the evaluator bubbles negatives: transparent through wrappers
 * that are not brace scopes (transforms, `if`, `for`, `let`), and stopping at a
 * `{ … }` block, whose own `printBody` resolves it. A cutter keeps the wrappers
 * it was written under, so `translate(v) negative() c;` becomes
 * `translate(v) c;` on the cutter side and disappears from the solid side.
 */
function splitNegatives(stmt: Statement): NegativeSplit {
  if (stmt.kind === 'module-call' && stmt.name === 'negative') {
    // The wrapper disappears; only its children survive, as cutters.
    return {
      cutters: stmt.children.flatMap((child) => (child.kind === 'block' ? child.body : [child])),
    };
  }

  // A braced child list is a scope: leave it whole for its own printBody.
  const hasBracedChildren = (children: Statement[]): boolean =>
    children.length === 1 && children[0].kind === 'block';

  const rewrap = (child: Statement, wrap: (c: Statement) => Statement): Statement => wrap(child);

  switch (stmt.kind) {
    case 'module-call': {
      if (stmt.children.length === 0 || hasBracedChildren(stmt.children)) {
        return { solid: stmt, cutters: [] };
      }
      const solids: Statement[] = [];
      const cutters: Statement[] = [];
      for (const child of stmt.children) {
        const split = splitNegatives(child);
        if (split.solid) solids.push(split.solid);
        for (const cutter of split.cutters) {
          cutters.push(rewrap(cutter, (c) => ({ ...stmt, children: [c] })));
        }
      }
      return {
        solid: solids.length > 0 ? { ...stmt, children: solids } : undefined,
        cutters,
      };
    }

    case 'if': {
      const thenSplit = splitNegatives(stmt.then);
      const elseSplit: NegativeSplit = stmt.else ? splitNegatives(stmt.else) : { cutters: [] };
      const cutters: Statement[] = [
        // A cutter under a branch only cuts when that branch is taken, so the
        // condition has to be preserved around it.
        ...thenSplit.cutters.map((c) => ({ ...stmt, then: c, else: undefined })),
        ...elseSplit.cutters.map((c) => ({
          ...stmt,
          then: { kind: 'empty' as const, span: stmt.span },
          else: c,
        })),
      ];
      if (cutters.length === 0) return { solid: stmt, cutters: [] };
      const solidThen = thenSplit.solid ?? { kind: 'empty' as const, span: stmt.span };
      const solidElse = elseSplit.solid;
      const anySolid = thenSplit.solid || solidElse;
      return {
        solid: anySolid ? { ...stmt, then: solidThen, else: solidElse } : undefined,
        cutters,
      };
    }

    case 'for':
    case 'for-c':
    case 'intersection-for':
    case 'let-stmt': {
      const split = splitNegatives(stmt.body);
      if (split.cutters.length === 0) return { solid: stmt, cutters: [] };
      return {
        solid: split.solid ? { ...stmt, body: split.solid } : undefined,
        // The loop or binding has to wrap the cutter too, so it is produced
        // once per iteration with that iteration's values.
        cutters: split.cutters.map((c) => ({ ...stmt, body: c })),
      };
    }

    default:
      return { solid: stmt, cutters: [] };
  }
}

/** Rebuilds the `% # ! *` prefix from a statement's roles. */
function modifierPrefix(stmt: Statement): string {
  if (!('roles' in stmt)) return '';
  let prefix = '';
  for (const roleName of stmt.roles) {
    const modifier = ROLE_TO_MODIFIER.get(roleName);
    if (modifier) prefix += modifier;
  }
  return prefix;
}

function formatNumberLiteral(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Enough digits to round-trip, without printing 0.30000000000000004.
  const short = Number.parseFloat(n.toPrecision(15));
  return String(short);
}

/**
 * Emits legacy-compatible `.scad` for a parsed file.
 *
 * The output is intended to open unmodified in stock OpenSCAD; any construct
 * that had to be rewritten is listed in `rewrites` so the UI can tell the user
 * what changed.
 */
export function transpileToLegacyScad(file: ScadFile, options: TranspileOptions = {}): TranspileResult {
  const printer = new Printer(options.indent ?? 2, declaredModuleNames(file));
  printer.printBody(file.body, 0);
  // Printed first, because printing is what discovers which helpers are needed.
  const body = printer.helperDefinitions() + printer.toString();
  const rewrites = [...printer.rewrites];

  if (options.header === false) return { source: body, rewrites };

  const header = [
    '// Generated by BetterSCAD — legacy OpenSCAD export.',
    `// ${SITE_URL}`,
    ...(rewrites.length > 0
      ? ['//', '// Extensions rewritten for compatibility:', ...rewrites.map((r) => `//   - ${r}`)]
      : []),
    '',
    '',
  ].join('\n');

  return { source: header + body, rewrites };
}

/**
 * Every module name the file declares, at any depth.
 *
 * Collected so a generated helper can be given a name the file does not already
 * use; redefining a user's module would change their geometry, not their
 * formatting.
 */
function declaredModuleNames(file: ScadFile): Set<string> {
  const names = new Set<string>();
  const visit = (stmt: Statement): void => {
    if (stmt.kind === 'module-decl') {
      names.add(stmt.name);
      visit(stmt.body);
    }
    if ('children' in stmt) for (const child of stmt.children) visit(child);
    if (stmt.kind === 'block') for (const child of stmt.body) visit(child);
    if (stmt.kind === 'if') {
      visit(stmt.then);
      if (stmt.else) visit(stmt.else);
    }
    if (stmt.kind === 'for' || stmt.kind === 'intersection-for' || stmt.kind === 'for-c') visit(stmt.body);
    if (stmt.kind === 'let-stmt') visit(stmt.body);
    if ((stmt.kind === 'assert-stmt' || stmt.kind === 'echo-stmt') && stmt.body) visit(stmt.body);
  };
  for (const stmt of file.body) visit(stmt);
  return names;
}

/** One BetterSCAD extension found in a file, and how it downgrades. */
export interface ExtensionUse {
  /** How the extension is written, e.g. `negative()`. */
  name: string;
  /** What the legacy `.scad` export rewrites it to. */
  downgrade: string;
  /** 1-based line of every occurrence, in source order. */
  lines: number[];
}

/**
 * Reports which extensions a file uses.
 *
 * Two callers want this: the legacy `.scad` export, which warns before
 * rewriting, and opening a `.scad` file, which warns that the file is not
 * actually stock OpenSCAD. Both want to say *where*, so occurrences are
 * collected rather than merely counted.
 */
export function describeExtensions(file: ScadFile): ExtensionUse[] {
  const found = new Map<string, ExtensionUse>();

  const record = (key: string, name: string, downgrade: string, line: number): void => {
    const existing = found.get(key);
    if (existing) existing.lines.push(line);
    else found.set(key, { name, downgrade, lines: [line] });
  };

  const visitStatement = (stmt: Statement): void => {
    if (stmt.kind === 'module-call' && stmt.name === 'negative') {
      const role = getRole('negative');
      record(
        'negative',
        'negative()',
        role?.legacy.transpile ?? 'Rewritten as difference().',
        stmt.span.start.line,
      );
    }
    if (stmt.kind === 'for-c') {
      record(
        'for-c',
        'C-style for(...)',
        'Rewritten as a bounded range for with the condition as a guard.',
        stmt.span.start.line,
      );
    }
    if (stmt.kind === 'module-call' && SHAPE_MODULES[stmt.name]) {
      record(
        stmt.name,
        `${stmt.name}()`,
        'Rewritten as a generated module, defined once and reused.',
        stmt.span.start.line,
      );
    }
    if (
      stmt.kind === 'module-call' &&
      SUGARED_SHAPES[stmt.name] &&
      usesSugar(SUGARED_SHAPES[stmt.name], stmt.args)
    ) {
      // Reported against the argument, not the module: a plain `cube()` is
      // stock, and saying otherwise would make the export warn about a file it
      // is about to copy byte for byte.
      record(
        SUGARED_SHAPES[stmt.name].describe,
        SUGARED_SHAPES[stmt.name].describe,
        'Rewritten as a generated module, defined once and reused.',
        stmt.span.start.line,
      );
    }
    if (stmt.kind === 'module-call' && AXIS_SUGAR[stmt.name]) {
      const { stock } = AXIS_SUGAR[stmt.name];
      record(
        stmt.name,
        `${stmt.name}()`,
        `Rewritten as ${stock}([…]) on that axis.`,
        stmt.span.start.line,
      );
    }
    if (stmt.kind === 'module-call' && isLooseVectorCall(stmt.name, stmt.args)) {
      record(
        `${stmt.name}-loose`,
        `${stmt.name}(x, y, z)`,
        `Rewritten as ${stmt.name}([x, y, z]).`,
        stmt.span.start.line,
      );
    }
    if ('children' in stmt) for (const child of stmt.children) visitStatement(child);
    if (stmt.kind === 'block') for (const child of stmt.body) visitStatement(child);
    if (stmt.kind === 'if') {
      visitStatement(stmt.then);
      if (stmt.else) visitStatement(stmt.else);
    }
    if (stmt.kind === 'for' || stmt.kind === 'intersection-for' || stmt.kind === 'for-c') {
      visitStatement(stmt.body);
    }
    if (stmt.kind === 'let-stmt') visitStatement(stmt.body);
    if (stmt.kind === 'module-decl') visitStatement(stmt.body);
    if ((stmt.kind === 'assert-stmt' || stmt.kind === 'echo-stmt') && stmt.body) visitStatement(stmt.body);
  };

  for (const stmt of file.body) visitStatement(stmt);
  for (const use of found.values()) use.lines.sort((a, b) => a - b);
  return [...found.values()];
}

export interface StockScadResult {
  /** Stock OpenSCAD: the input unchanged, or a transpile of it. */
  source: string;
  /** Extensions found in the input. Empty means nothing needed rewriting. */
  extensions: ExtensionUse[];
  /** What the transpiler rewrote. Always empty when `verbatim`. */
  rewrites: string[];
  /** True when `source` is the input, byte for byte. */
  verbatim: boolean;
  /** Parse errors. When non-empty nothing was transpiled and `source` is the input. */
  errors: Diagnostic[];
}

/**
 * Produces stock OpenSCAD from BetterSCAD source.
 *
 * A file that uses no extensions comes back **byte for byte**, not re-printed.
 * The transpiler doubles as a pretty-printer, so running it over an already
 * stock file would reflow the user's layout, drop every comment and
 * parenthesise every expression — a diff with nothing to show for it, on a file
 * that was already going to open in OpenSCAD. The rewrite is a cost worth
 * paying only when there is something that has to be rewritten.
 *
 * `source` must already have any `.bscad` metadata header removed
 * (see `toLegacyScadSource`); a header left in place would survive verbatim.
 */
export function toStockScad(
  source: string,
  file = '<input>',
  options: TranspileOptions = {},
): StockScadResult {
  const parsed = parse(source, file);
  const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return { source, extensions: [], rewrites: [], verbatim: true, errors };
  }

  const extensions = describeExtensions(parsed.file);
  if (extensions.length === 0) {
    return { source, extensions, rewrites: [], verbatim: true, errors: [] };
  }

  const { source: rewritten, rewrites } = transpileToLegacyScad(parsed.file, options);
  return { source: rewritten, extensions, rewrites, verbatim: false, errors: [] };
}
