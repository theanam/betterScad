/**
 * AST for the OpenSCAD language as implemented by BetterSCAD.
 *
 * The shape is our own (spec feature 3: nothing derived from upstream
 * OpenSCAD). Two deliberate departures from how OpenSCAD's own grammar is
 * usually described:
 *
 *  1. `if` / `for` / `let` / `intersection_for` at statement level are distinct
 *     node kinds rather than "module instantiations with funny arguments".
 *     They behave differently enough that folding them together only pushes
 *     special-casing downstream.
 *  2. Debug modifiers (`% # ! *`) are stored as an open-ended list of *role
 *     names* rather than four booleans, so new modifiers are a registry entry
 *     rather than a new field on every node (spec feature 3a).
 */

import { SourceSpan } from './diagnostics.js';

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | UndefLit
  | ListExpr
  | RangeExpr
  | Identifier
  | IndexExpr
  | MemberExpr
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | CallExpr
  | LetExpr
  | AssertExpr
  | EchoExpr
  | LambdaExpr
  | MeasureExpr;

export interface NodeBase {
  span: SourceSpan;
}

export interface NumberLit extends NodeBase {
  kind: 'number';
  value: number;
}

export interface StringLit extends NodeBase {
  kind: 'string';
  value: string;
}

export interface BoolLit extends NodeBase {
  kind: 'bool';
  value: boolean;
}

export interface UndefLit extends NodeBase {
  kind: 'undef';
}

/**
 * `[a, b, c]`. Elements may be comprehension forms (`for`, `if`, `each`,
 * `let`), which is why the element type is not simply `Expr`.
 */
export interface ListExpr extends NodeBase {
  kind: 'list';
  elements: ListElement[];
}

export type ListElement =
  | { kind: 'item'; value: Expr }
  | { kind: 'each'; value: Expr; span: SourceSpan }
  | { kind: 'comp-for'; clauses: ForClause[]; body: ListElement; span: SourceSpan }
  | {
      kind: 'comp-for-c';
      init: Assignment[];
      condition: Expr;
      update: Assignment[];
      body: ListElement;
      span: SourceSpan;
    }
  | { kind: 'comp-if'; condition: Expr; then: ListElement; else?: ListElement; span: SourceSpan }
  | { kind: 'comp-let'; bindings: Assignment[]; body: ListElement; span: SourceSpan };

export interface ForClause {
  name: string;
  value: Expr;
  span: SourceSpan;
}

/** `[start : end]` or `[start : step : end]`. */
export interface RangeExpr extends NodeBase {
  kind: 'range';
  start: Expr;
  step?: Expr;
  end: Expr;
}

export interface Identifier extends NodeBase {
  kind: 'identifier';
  name: string;
}

export interface IndexExpr extends NodeBase {
  kind: 'index';
  target: Expr;
  index: Expr;
}

/** `v.x` — OpenSCAD only defines `.x`, `.y`, `.z` as swizzles on vectors. */
export interface MemberExpr extends NodeBase {
  kind: 'member';
  target: Expr;
  property: string;
}

export interface UnaryExpr extends NodeBase {
  kind: 'unary';
  op: '-' | '+' | '!';
  operand: Expr;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

export interface BinaryExpr extends NodeBase {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface TernaryExpr extends NodeBase {
  kind: 'ternary';
  condition: Expr;
  then: Expr;
  else: Expr;
}

export interface Argument {
  /** `undefined` for positional arguments. */
  name?: string;
  value: Expr;
  span: SourceSpan;
}

export interface CallExpr extends NodeBase {
  kind: 'call';
  callee: Expr;
  args: Argument[];
}

export interface Assignment extends NodeBase {
  kind: 'assignment';
  name: string;
  value: Expr;
}

export interface LetExpr extends NodeBase {
  kind: 'let';
  bindings: Assignment[];
  body: Expr;
}

export interface AssertExpr extends NodeBase {
  kind: 'assert-expr';
  args: Argument[];
  /** `assert(x)` used as a statement-expression has no trailing body. */
  body?: Expr;
}

export interface EchoExpr extends NodeBase {
  kind: 'echo-expr';
  args: Argument[];
  body?: Expr;
}

/** `function (x, y = 1) x + y` — OpenSCAD 2021 function literals. */
export interface LambdaExpr extends NodeBase {
  kind: 'lambda';
  params: Parameter[];
  body: Expr;
}

/**
 * `get_size(bracket())` / `get_position(bracket())` — a BetterSCAD extension.
 *
 * The argument is geometry, not a value: a statement, parsed as one, which
 * stock OpenSCAD's grammar has no place for inside an expression. The object
 * is built and measured while the code runs; the legacy export writes the
 * measured value in its place.
 */
export interface MeasureExpr extends NodeBase {
  kind: 'measure';
  /** `size` for `get_size()`, `position` for `get_position()`. */
  measure: 'size' | 'position';
  /** What is measured: a module call, a block, a `for`, an `if`. */
  body: Statement;
  /** Span of just the function name. */
  nameSpan: SourceSpan;
}

/** The functions that take an object rather than a value, and what each reads. */
export const MEASURE_FUNCTIONS: Record<string, MeasureExpr['measure']> = {
  get_size: 'size',
  get_position: 'position',
};

/**
 * `center()` and its one- and two-axis forms — a BetterSCAD extension — as the
 * axes each one moves on.
 *
 * Every statement inside the braces after the first is moved so its bounding
 * box is centred on the first one's, on these axes. Like `get_size()` it
 * measures geometry while the code runs, and the legacy export writes the
 * moves it measured; the measurements are kept under `measureKey` of the call.
 *
 * Here rather than in the interpreter because the transpiler and the editor
 * need the same list, and a name added to one but not the others is a call
 * that renders and then cannot be saved.
 */
export const CENTER_AXES: Record<string, readonly [boolean, boolean, boolean]> = {
  center: [true, true, true],
  centerx: [true, false, false],
  centery: [false, true, false],
  centerz: [false, false, true],
  centerxy: [true, true, false],
};

/**
 * Where a `get_size()` was written, as the key its measurements are kept under.
 *
 * The file and offset rather than the node, because the export parses the
 * source again and gets different nodes for the same calls.
 */
export function measureKey(span: SourceSpan): string {
  return `${span.file}:${span.start.offset}`;
}

export interface Parameter {
  name: string;
  default?: Expr;
  span: SourceSpan;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Statement =
  | AssignStmt
  | ModuleDecl
  | FunctionDecl
  | ModuleCall
  | BlockStmt
  | IfStmt
  | ForStmt
  | ForCStmt
  | IntersectionForStmt
  | LetStmt
  | IncludeStmt
  | UseStmt
  | AssertStmt
  | EchoStmt
  | EmptyStmt;

export interface AssignStmt extends NodeBase {
  kind: 'assign';
  name: string;
  value: Expr;
}

export interface ModuleDecl extends NodeBase {
  kind: 'module-decl';
  name: string;
  params: Parameter[];
  body: Statement;
}

export interface FunctionDecl extends NodeBase {
  kind: 'function-decl';
  name: string;
  params: Parameter[];
  body: Expr;
}

/**
 * `translate([1,0,0]) cube();`
 *
 * `roles` holds modifier role names resolved from `% # ! *` (and, in future,
 * from named modifiers). Ordering is source order.
 */
export interface ModuleCall extends NodeBase {
  kind: 'module-call';
  name: string;
  args: Argument[];
  children: Statement[];
  roles: string[];
  /** Span of just the callee name, for precise error underlining. */
  nameSpan: SourceSpan;
  /**
   * Written after the call when it is printed, as `/* … *\/`.
   *
   * Only a call the transpiler made up carries one — the `translate()` that
   * stands in for a `center()` says which — so the generated file says why the
   * number is there. The parser never sets it.
   */
  comment?: string;
}

export interface BlockStmt extends NodeBase {
  kind: 'block';
  body: Statement[];
  roles: string[];
}

export interface IfStmt extends NodeBase {
  kind: 'if';
  condition: Expr;
  then: Statement;
  else?: Statement;
  roles: string[];
}

export interface ForStmt extends NodeBase {
  kind: 'for';
  clauses: ForClause[];
  body: Statement;
  roles: string[];
}

/** C-style `for (i = 0; i < 10; i = i + 1)`. */
export interface ForCStmt extends NodeBase {
  kind: 'for-c';
  init: Assignment[];
  condition: Expr;
  update: Assignment[];
  body: Statement;
  roles: string[];
}

export interface IntersectionForStmt extends NodeBase {
  kind: 'intersection-for';
  clauses: ForClause[];
  body: Statement;
  roles: string[];
}

export interface LetStmt extends NodeBase {
  kind: 'let-stmt';
  bindings: Assignment[];
  body: Statement;
  roles: string[];
}

export interface IncludeStmt extends NodeBase {
  kind: 'include';
  path: string;
}

export interface UseStmt extends NodeBase {
  kind: 'use';
  path: string;
}

export interface AssertStmt extends NodeBase {
  kind: 'assert-stmt';
  args: Argument[];
  body?: Statement;
  roles: string[];
}

export interface EchoStmt extends NodeBase {
  kind: 'echo-stmt';
  args: Argument[];
  body?: Statement;
  roles: string[];
}

export interface EmptyStmt extends NodeBase {
  kind: 'empty';
}

export interface ScadFile {
  /** Logical file name, matching `SourceSpan.file`. */
  file: string;
  body: Statement[];
}

/** Statement kinds that carry a `roles` array. */
export type ModifiableStatement = Extract<Statement, { roles: string[] }>;

export function hasRoles(stmt: Statement): stmt is ModifiableStatement {
  return 'roles' in stmt;
}
