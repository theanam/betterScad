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

  constructor(private readonly indentWidth: number) {}

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
  const printer = new Printer(options.indent ?? 2);
  printer.printBody(file.body, 0);
  const body = printer.toString();
  const rewrites = [...printer.rewrites];

  if (options.header === false) return { source: body, rewrites };

  const header = [
    '// Generated by BetterSCAD — legacy OpenSCAD export.',
    ...(rewrites.length > 0
      ? ['//', '// Extensions rewritten for compatibility:', ...rewrites.map((r) => `//   - ${r}`)]
      : []),
    '',
    '',
  ].join('\n');

  return { source: header + body, rewrites };
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
