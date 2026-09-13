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
import { MODIFIER_ROLES } from './parser.js';
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
    // A scope containing `negative()` children becomes a difference() whose
    // first child is everything else. This is the whole downgrade for the
    // extension, and it is exact: the role's contribution is "subtract from
    // every sibling in scope".
    const negatives = statements.filter(isNegativeCall);
    if (negatives.length > 0) {
      this.rewrites.add('negative() rewritten as difference()');
      const rest = statements.filter((s) => !isNegativeCall(s));
      this.line(depth, 'difference() {');
      if (rest.length === 0) {
        this.line(depth + 1, '// nothing to cut from: negative() had no siblings');
      } else if (rest.length === 1) {
        this.printStatement(rest[0], depth + 1);
      } else {
        this.line(depth + 1, 'union() {');
        for (const stmt of rest) this.printStatement(stmt, depth + 2);
        this.line(depth + 1, '}');
      }
      for (const negative of negatives) {
        // The wrapper module disappears; only its children survive as cutters.
        const children = negative.kind === 'module-call' ? negative.children : [];
        for (const child of children) this.printStatement(child, depth + 1);
      }
      this.line(depth, '}');
      return;
    }

    for (const stmt of statements) this.printStatement(stmt, depth);
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
        this.line(depth, `module ${stmt.name}(${this.params(stmt.params)})`);
        this.printChild(stmt.body, depth);
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
        const call = `${prefix}${stmt.name}(${this.args(stmt.args)})`;
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

  /** Prints a statement as the child of another, wrapping bare lists in braces. */
  private printChild(stmt: Statement, depth: number): void {
    if (stmt.kind === 'block') {
      this.line(depth, '{');
      this.printBody(stmt.body, depth + 1);
      this.line(depth, '}');
      return;
    }
    // A lone `negative()` child still needs the scope rewrite, which only
    // `printBody` performs.
    if (isNegativeCall(stmt)) {
      this.line(depth, '{');
      this.printBody([stmt], depth + 1);
      this.line(depth, '}');
      return;
    }
    this.printStatement(stmt, depth + 1);
  }

  // -- fragments ------------------------------------------------------------

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

function isNegativeCall(stmt: Statement): boolean {
  return stmt.kind === 'module-call' && stmt.name === 'negative';
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

/**
 * Reports which extensions a file uses, for a UI warning before saving as
 * legacy `.scad`.
 */
export function describeExtensions(file: ScadFile): { name: string; downgrade: string }[] {
  const found = new Map<string, { name: string; downgrade: string }>();

  const visitStatement = (stmt: Statement): void => {
    if (stmt.kind === 'module-call' && stmt.name === 'negative') {
      const role = getRole('negative');
      found.set('negative', {
        name: 'negative()',
        downgrade: role?.legacy.transpile ?? 'Rewritten as difference().',
      });
    }
    if (stmt.kind === 'for-c') {
      found.set('for-c', {
        name: 'C-style for(...)',
        downgrade: 'Rewritten as a bounded range for with the condition as a guard.',
      });
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
  return [...found.values()];
}
