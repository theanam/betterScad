/**
 * Evaluator: AST -> scene graph.
 *
 * Implements OpenSCAD's semantics as documented, notably the two that surprise
 * people coming from ordinary languages:
 *
 *  - **Assignments are scope-wide.** Within a scope every assignment is
 *    evaluated (in source order) *before* any geometry statement runs, so the
 *    last assignment to a name is what every statement in that scope sees.
 *  - **`$`-variables are dynamically scoped.** They flow down into called
 *    modules, while ordinary variables resolve lexically at the definition
 *    site. Two parent chains are therefore maintained per scope.
 */

import {
  Argument,
  Assignment,
  Expr,
  ForClause,
  ListElement,
  ModuleDecl,
  Parameter,
  ScadFile,
  Statement,
} from './ast.js';
import { BUILTIN_FUNCTIONS, BuiltinContext, echoArgs } from './builtins.js';
import { DiagnosticBag, ScadError, SourceSpan } from './diagnostics.js';
import {
  DEFAULT_RESOLUTION,
  IDENTITY,
  Mat4,
  Resolution,
  SceneNode,
  group,
  scopeGroup,
  matMultiply,
  mirrorMatrix,
  node,
  rotationAxis,
  rotationXYZ,
  scaling,
  translation,
} from './scene.js';
import {
  FunctionValue,
  RangeValue,
  Value,
  asNumber,
  asVector,
  compare,
  deepEqual,
  formatValue,
  isTruthy,
  toList,
  toStringValue,
  typeOf,
} from './values.js';

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

interface ModuleDef {
  decl: ModuleDecl;
  scope: Scope;
}

interface FunctionDef {
  name: string;
  params: Parameter[];
  body: Expr;
  scope: Scope;
}

/** Children captured at a module invocation, for `children()` to replay. */
interface ChildrenContext {
  statements: Statement[];
  scope: Scope;
}

class Scope {
  readonly vars = new Map<string, Value>();
  readonly specials = new Map<string, Value>();
  readonly modules = new Map<string, ModuleDef>();
  readonly functions = new Map<string, FunctionDef>();
  children?: ChildrenContext;

  constructor(
    readonly lexicalParent?: Scope,
    readonly dynamicParent?: Scope,
  ) {}

  lookupVar(name: string): { found: boolean; value: Value } {
    if (name.startsWith('$')) {
      for (let s: Scope | undefined = this; s; s = s.dynamicParent) {
        if (s.specials.has(name)) return { found: true, value: s.specials.get(name) };
      }
      return { found: false, value: undefined };
    }
    for (let s: Scope | undefined = this; s; s = s.lexicalParent) {
      if (s.vars.has(name)) return { found: true, value: s.vars.get(name) };
    }
    return { found: false, value: undefined };
  }

  setVar(name: string, value: Value): void {
    if (name.startsWith('$')) this.specials.set(name, value);
    else this.vars.set(name, value);
  }

  lookupModule(name: string): ModuleDef | undefined {
    for (let s: Scope | undefined = this; s; s = s.lexicalParent) {
      const found = s.modules.get(name);
      if (found) return found;
    }
    return undefined;
  }

  lookupFunction(name: string): FunctionDef | undefined {
    for (let s: Scope | undefined = this; s; s = s.lexicalParent) {
      const found = s.functions.get(name);
      if (found) return found;
    }
    return undefined;
  }

  lookupChildren(): ChildrenContext | undefined {
    for (let s: Scope | undefined = this; s; s = s.lexicalParent) {
      if (s.children) return s.children;
    }
    return undefined;
  }

  resolution(): Resolution {
    return {
      fn: asNumber(this.lookupVar('$fn').value, DEFAULT_RESOLUTION.fn),
      fa: asNumber(this.lookupVar('$fa').value, DEFAULT_RESOLUTION.fa),
      fs: asNumber(this.lookupVar('$fs').value, DEFAULT_RESOLUTION.fs),
    };
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Animation time, bound to `$t` (spec feature 20). */
  time?: number;
  /** `$preview` — true in fast-preview mode (spec feature 14). */
  preview?: boolean;
  /** Viewport state, bound to `$vpr` / `$vpt` / `$vpd` / `$vpf`. */
  viewport?: { rotation?: [number, number, number]; translation?: [number, number, number]; distance?: number; fov?: number };
  /** Values injected by the Customizer, overriding top-level assignments. */
  parameters?: Record<string, Value>;
  /** Parsed files reachable through `include` / `use`, keyed by resolved path. */
  includes?: Map<string, ScadFile>;
  maxRecursionDepth?: number;
  /** Hard ceiling on instantiated nodes; stops runaway recursion killing the tab. */
  maxNodes?: number;
}

export interface EvaluateResult {
  root: SceneNode;
  diagnostics: DiagnosticBag;
  /** Top-level variable values after evaluation, for the Customizer to read back. */
  topLevelVars: Map<string, Value>;
}

/**
 * Built-in constants.
 *
 * Resolved only when no variable of the same name is in scope, so `PI = 3;`
 * shadows the constant rather than being an error — matching OpenSCAD, where
 * these live in the builtin context that parents the root scope.
 *
 * `PI` is the only constant stock OpenSCAD defines. Infinity and NaN are
 * produced arithmetically (`1 / 0`, `0 / 0`), not spelled as identifiers;
 * adding `inf`/`nan`/`E` here would be a language extension, and would need a
 * legacy downgrade path under spec feature 21.
 */
export const BUILTIN_CONSTANTS: Record<string, Value> = {
  PI: Math.PI,
};

const MAX_RECURSION_DEFAULT = 200;
const MAX_NODES_DEFAULT = 250_000;

/** Thrown to unwind when a hard limit is hit; caught at the top of `evaluate`. */
class EvaluationHalt extends Error {}

// ---------------------------------------------------------------------------

class Interpreter {
  readonly diagnostics = new DiagnosticBag();
  private depth = 0;
  private nodeCount = 0;
  private readonly maxDepth: number;
  private readonly maxNodes: number;
  private readonly includes: Map<string, ScadFile>;
  /** Guards against `include` cycles. */
  private readonly includeStack: string[] = [];

  constructor(private readonly options: EvaluateOptions) {
    this.maxDepth = options.maxRecursionDepth ?? MAX_RECURSION_DEFAULT;
    this.maxNodes = options.maxNodes ?? MAX_NODES_DEFAULT;
    this.includes = options.includes ?? new Map();
  }

  private get builtinContext(): BuiltinContext {
    return {
      warn: (message, span, code) => this.diagnostics.warn(message, span, code),
      random: () => Math.random(),
    };
  }

  private countNode(): void {
    if (++this.nodeCount > this.maxNodes) {
      this.diagnostics.error(
        `Geometry limit reached (${this.maxNodes} nodes). This usually means unbounded recursion.`,
        undefined,
        'eval.node-limit',
      );
      throw new EvaluationHalt();
    }
  }

  // -- entry point ----------------------------------------------------------

  run(file: ScadFile): EvaluateResult {
    const root = new Scope();
    this.seedSpecials(root);

    const children: SceneNode[] = [];
    try {
      this.executeScope(file.body, root, children, file.file, true);
    } catch (err) {
      if (!(err instanceof EvaluationHalt)) {
        if (err instanceof ScadError) this.diagnostics.add(err.diagnostic);
        else throw err;
      }
    }

    return {
      // The top level is itself a brace scope: a negative() written here cuts
      // everything, but that is because *here* is the global scope.
      root: scopeGroup(children),
      diagnostics: this.diagnostics,
      topLevelVars: root.vars,
    };
  }

  private seedSpecials(scope: Scope): void {
    scope.specials.set('$fn', DEFAULT_RESOLUTION.fn);
    scope.specials.set('$fa', DEFAULT_RESOLUTION.fa);
    scope.specials.set('$fs', DEFAULT_RESOLUTION.fs);
    scope.specials.set('$t', this.options.time ?? 0);
    scope.specials.set('$preview', this.options.preview ?? true);
    const vp = this.options.viewport;
    scope.specials.set('$vpr', vp?.rotation ? [...vp.rotation] : [55, 0, 25]);
    scope.specials.set('$vpt', vp?.translation ? [...vp.translation] : [0, 0, 0]);
    scope.specials.set('$vpd', vp?.distance ?? 140);
    scope.specials.set('$vpf', vp?.fov ?? 22.5);
    scope.specials.set('$children', 0);
  }

  // -- scope execution ------------------------------------------------------

  /**
   * Runs a list of statements in `scope`, OpenSCAD-style: declarations are
   * hoisted, then assignments are evaluated in source order, then geometry.
   */
  private executeScope(
    statements: Statement[],
    scope: Scope,
    out: SceneNode[],
    file: string,
    isTopLevel = false,
  ): void {
    const flattened = this.spliceIncludes(statements, scope, file);

    // Pass 1: hoist declarations, so a module may be called before it is defined.
    for (const stmt of flattened) {
      if (stmt.kind === 'module-decl') {
        scope.modules.set(stmt.name, { decl: stmt, scope });
      } else if (stmt.kind === 'function-decl') {
        scope.functions.set(stmt.name, {
          name: stmt.name,
          params: stmt.params,
          body: stmt.body,
          scope,
        });
      }
    }

    // Pass 2: assignments, in source order; the last write to a name wins for
    // the whole scope.
    for (const stmt of flattened) {
      if (stmt.kind !== 'assign') continue;
      const override = isTopLevel ? this.options.parameters?.[stmt.name] : undefined;
      if (override !== undefined) {
        scope.setVar(stmt.name, override);
        continue;
      }
      scope.setVar(stmt.name, this.evalExpr(stmt.value, scope));
    }

    // Customizer parameters for names the script never assigns still need to
    // exist, otherwise a control silently does nothing.
    if (isTopLevel && this.options.parameters) {
      for (const [name, value] of Object.entries(this.options.parameters)) {
        if (!scope.vars.has(name) && !scope.specials.has(name)) scope.setVar(name, value);
      }
    }

    // Pass 3: everything that produces geometry or output.
    for (const stmt of flattened) {
      if (stmt.kind === 'assign' || stmt.kind === 'module-decl' || stmt.kind === 'function-decl') {
        continue;
      }
      this.executeStatement(stmt, scope, out, file);
    }
  }

  /**
   * Replaces `include` statements with the included file's statements, and
   * registers `use`d files' declarations without running their geometry.
   */
  private spliceIncludes(statements: Statement[], scope: Scope, file: string): Statement[] {
    if (!statements.some((s) => s.kind === 'include' || s.kind === 'use')) return statements;

    const out: Statement[] = [];
    for (const stmt of statements) {
      if (stmt.kind === 'include') {
        const included = this.includes.get(stmt.path);
        if (!included) {
          this.diagnostics.error(
            `Cannot resolve include <${stmt.path}>.`,
            stmt.span,
            'eval.unresolved-include',
          );
          continue;
        }
        if (this.includeStack.includes(stmt.path)) {
          this.diagnostics.warn(
            `Circular include <${stmt.path}> ignored.`,
            stmt.span,
            'eval.circular-include',
          );
          continue;
        }
        this.includeStack.push(stmt.path);
        out.push(...this.spliceIncludes(included.body, scope, included.file));
        this.includeStack.pop();
      } else if (stmt.kind === 'use') {
        const used = this.includes.get(stmt.path);
        if (!used) {
          this.diagnostics.error(`Cannot resolve use <${stmt.path}>.`, stmt.span, 'eval.unresolved-use');
          continue;
        }
        // `use` imports definitions only — never variables, never geometry.
        const usedScope = new Scope(scope, scope);
        for (const s of used.body) {
          if (s.kind === 'module-decl') scope.modules.set(s.name, { decl: s, scope: usedScope });
          else if (s.kind === 'function-decl') {
            scope.functions.set(s.name, { name: s.name, params: s.params, body: s.body, scope: usedScope });
          }
        }
      } else {
        out.push(stmt);
      }
    }
    return out;
  }

  private executeStatement(stmt: Statement, scope: Scope, out: SceneNode[], file: string): void {
    switch (stmt.kind) {
      case 'empty':
      case 'include':
      case 'use':
      case 'assign':
      case 'module-decl':
      case 'function-decl':
        return;

      case 'block': {
        const inner = new Scope(scope, scope);
        const kids: SceneNode[] = [];
        this.executeScope(stmt.body, inner, kids, file);
        this.emit(out, scopeGroup(kids, stmt.roles, stmt.span));
        return;
      }

      case 'if': {
        const taken = isTruthy(this.evalExpr(stmt.condition, scope)) ? stmt.then : stmt.else;
        if (!taken) return;
        const kids: SceneNode[] = [];
        this.executeStatement(taken, new Scope(scope, scope), kids, file);
        this.emit(out, group(kids, stmt.roles, stmt.span));
        return;
      }

      case 'for':
      case 'intersection-for': {
        const kids: SceneNode[] = [];
        this.iterateForClauses(stmt.clauses, 0, scope, (iterScope) => {
          this.executeStatement(stmt.body, iterScope, kids, file);
        });
        this.emit(
          out,
          stmt.kind === 'for'
            ? group(kids, stmt.roles, stmt.span)
            : node('intersection', {}, kids, stmt.roles, stmt.span),
        );
        return;
      }

      case 'for-c': {
        const kids: SceneNode[] = [];
        let iterScope = new Scope(scope, scope);
        for (const init of stmt.init) iterScope.setVar(init.name, this.evalExpr(init.value, iterScope));
        let guard = 0;
        while (isTruthy(this.evalExpr(stmt.condition, iterScope))) {
          if (++guard > 1_000_000) {
            this.diagnostics.error(
              'C-style `for` exceeded 1,000,000 iterations; aborting.',
              stmt.span,
              'eval.loop-limit',
            );
            break;
          }
          const bodyScope = new Scope(iterScope, iterScope);
          this.executeStatement(stmt.body, bodyScope, kids, file);
          const nextScope = new Scope(scope, scope);
          for (const [k, v] of iterScope.vars) nextScope.vars.set(k, v);
          for (const [k, v] of iterScope.specials) nextScope.specials.set(k, v);
          for (const upd of stmt.update) nextScope.setVar(upd.name, this.evalExpr(upd.value, iterScope));
          iterScope = nextScope;
        }
        this.emit(out, group(kids, stmt.roles, stmt.span));
        return;
      }

      case 'let-stmt': {
        const inner = new Scope(scope, scope);
        for (const b of stmt.bindings) inner.setVar(b.name, this.evalExpr(b.value, inner));
        const kids: SceneNode[] = [];
        this.executeStatement(stmt.body, inner, kids, file);
        this.emit(out, group(kids, stmt.roles, stmt.span));
        return;
      }

      case 'assert-stmt': {
        this.runAssert(stmt.args, scope, stmt.span);
        if (stmt.body) {
          const kids: SceneNode[] = [];
          this.executeStatement(stmt.body, scope, kids, file);
          this.emit(out, group(kids, stmt.roles, stmt.span));
        }
        return;
      }

      case 'echo-stmt': {
        this.runEcho(stmt.args, scope, stmt.span);
        if (stmt.body) {
          const kids: SceneNode[] = [];
          this.executeStatement(stmt.body, scope, kids, file);
          this.emit(out, group(kids, stmt.roles, stmt.span));
        }
        return;
      }

      case 'module-call':
        this.callModule(stmt, scope, out, file);
        return;

      default: {
        const never: never = stmt;
        throw new Error(`Unhandled statement ${(never as Statement).kind}`);
      }
    }
  }

  private emit(out: SceneNode[], n: SceneNode): void {
    this.countNode();
    out.push(n);
  }

  /** Recursively expands nested `for` clauses into a cartesian product. */
  private iterateForClauses(
    clauses: ForClause[],
    index: number,
    scope: Scope,
    body: (scope: Scope) => void,
  ): void {
    if (index >= clauses.length) {
      body(scope);
      return;
    }
    const clause = clauses[index];
    const source = this.evalExpr(clause.value, scope);
    const items = this.iterableOf(source, clause.span);
    for (const item of items) {
      const iterScope = new Scope(scope, scope);
      iterScope.setVar(clause.name, item);
      this.iterateForClauses(clauses, index + 1, iterScope, body);
    }
  }

  /** Values a `for` may loop over. Non-iterables yield a single iteration. */
  private iterableOf(v: Value, span?: SourceSpan): Value[] {
    if (Array.isArray(v)) return v;
    if (v instanceof RangeValue) {
      const count = v.length;
      if (count === undefined) {
        this.diagnostics.warn(
          'Range does not terminate (step is zero or points away from the end); skipping.',
          span,
          'eval.bad-range',
        );
        return [];
      }
      if (count > 1_000_000) {
        this.diagnostics.error(
          `Range would produce ${count} iterations; aborting to protect the session.`,
          span,
          'eval.loop-limit',
        );
        throw new EvaluationHalt();
      }
      return v.toArray();
    }
    if (typeof v === 'string') return [...v];
    if (v === undefined) return [];
    return [v];
  }

  // -- module calls ---------------------------------------------------------

  private callModule(
    stmt: Extract<Statement, { kind: 'module-call' }>,
    scope: Scope,
    out: SceneNode[],
    file: string,
  ): void {
    const { name } = stmt;

    // `children()` replays the caller's children rather than instantiating a module.
    if (name === 'children') {
      this.instantiateChildren(stmt, scope, out, file);
      return;
    }

    // Legacy `assign(x = 1) ...`: deprecated in OpenSCAD but still common in
    // older scripts. It binds variables for its children, so — unlike every
    // other built-in module — it must run before they are evaluated.
    if (name === 'assign' && !scope.lookupModule('assign')) {
      const inner = new Scope(scope, scope);
      for (const arg of stmt.args) {
        if (!arg.name) {
          this.diagnostics.warn(
            '`assign()` takes only named arguments.',
            arg.span,
            'eval.assign-positional',
          );
          continue;
        }
        inner.setVar(arg.name, this.evalExpr(arg.value, scope));
      }
      const assigned: SceneNode[] = [];
      for (const child of stmt.children) {
        this.executeStatement(child, new Scope(inner, inner), assigned, file);
      }
      this.emit(out, group(assigned, stmt.roles, stmt.span));
      return;
    }

    const userModule = scope.lookupModule(name);
    if (userModule) {
      this.callUserModule(userModule, stmt, scope, out, file);
      return;
    }

    const builtin = BUILTIN_MODULES[name];
    if (builtin) {
      const kids: SceneNode[] = [];
      // `translate(…) { a; b; }` writes a brace scope; `translate(…) a;` does
      // not. The block is unwrapped either way, so the distinction is recorded
      // here — it is what bounds a negative() written inside those braces.
      const braced = this.hasBracedChildren(stmt.children);
      this.executeChildren(stmt.children, scope, kids, file);
      const args = this.bindArguments(builtin.params, stmt.args, scope, name, stmt.nameSpan, builtin.acceptsExtra);
      const built = builtin.build(args, kids, scope, this, stmt.span);
      if (built) {
        this.emit(out, {
          ...built,
          params: braced ? { ...built.params, braced: true } : built.params,
          roles: [...stmt.roles, ...built.roles],
        });
      }
      return;
    }

    this.diagnostics.warn(`Ignoring unknown module \`${name}()\`.`, stmt.nameSpan, 'eval.unknown-module');
  }

  private callUserModule(
    def: ModuleDef,
    stmt: Extract<Statement, { kind: 'module-call' }>,
    callerScope: Scope,
    out: SceneNode[],
    file: string,
  ): void {
    if (this.depth >= this.maxDepth) {
      this.diagnostics.error(
        `Maximum module recursion depth (${this.maxDepth}) exceeded in \`${stmt.name}()\`.`,
        stmt.nameSpan,
        'eval.recursion-limit',
      );
      throw new EvaluationHalt();
    }

    // Lexical parent is the definition site; dynamic parent is the call site,
    // which is what makes `$fn` and friends propagate into the callee.
    const invocation = new Scope(def.scope, callerScope);
    this.bindParameters(def.decl.params, stmt.args, callerScope, invocation, stmt.name, stmt.nameSpan);
    invocation.children = { statements: stmt.children, scope: callerScope };
    invocation.specials.set('$children', stmt.children.length === 0 ? 0 : this.countChildStatements(stmt.children));

    const kids: SceneNode[] = [];
    this.depth++;
    try {
      const bodyScope = new Scope(invocation, invocation);
      bodyScope.children = invocation.children;
      this.executeStatement(def.decl.body, bodyScope, kids, file);
    } finally {
      this.depth--;
    }
    // A module body is a scope even when written without braces, so a
    // negative() inside a module can never reach out and cut its caller.
    this.emit(out, scopeGroup(kids, stmt.roles, stmt.span));
  }

  /**
   * `$children` counts the children of the instantiation, where a single block
   * child counts as its contained statements.
   */
  private countChildStatements(children: Statement[]): number {
    if (children.length === 1 && children[0].kind === 'block') {
      return children[0].body.filter((s) => this.isGeometryStatement(s)).length;
    }
    return children.filter((s) => this.isGeometryStatement(s)).length;
  }

  private isGeometryStatement(s: Statement): boolean {
    return !['assign', 'module-decl', 'function-decl', 'empty', 'include', 'use'].includes(s.kind);
  }

  private childStatementList(ctx: ChildrenContext): Statement[] {
    const { statements } = ctx;
    if (statements.length === 1 && statements[0].kind === 'block') {
      return statements[0].body.filter((s) => this.isGeometryStatement(s));
    }
    return statements.filter((s) => this.isGeometryStatement(s));
  }

  /**
   * Instantiates a built-in module's children, one scene node per statement.
   *
   * `difference() { a; b; }` has a single *syntactic* child — the brace block —
   * but two CSG operands. Unwrapping the block here is what makes `difference`,
   * `intersection`, `hull` and `minkowski` see their operands separately;
   * without it every braced boolean would collapse to a no-op union.
   *
   * A block carrying its own modifiers is left intact, because those modifiers
   * apply to the block as a whole.
   */
  /** Whether a module instantiation's children were written as a `{ … }` block. */
  private hasBracedChildren(children: Statement[]): boolean {
    return children.length === 1 && children[0].kind === 'block' && children[0].roles.length === 0;
  }

  private executeChildren(
    children: Statement[],
    scope: Scope,
    out: SceneNode[],
    file: string,
  ): void {
    const only = children[0];
    if (children.length === 1 && only.kind === 'block' && only.roles.length === 0) {
      // A fresh scope so the block's own assignments stay local to it.
      this.executeScope(only.body, new Scope(scope, scope), out, file);
      return;
    }
    for (const child of children) {
      this.executeStatement(child, new Scope(scope, scope), out, file);
    }
  }

  private instantiateChildren(
    stmt: Extract<Statement, { kind: 'module-call' }>,
    scope: Scope,
    out: SceneNode[],
    file: string,
  ): void {
    const ctx = scope.lookupChildren();
    if (!ctx) {
      this.diagnostics.warn(
        '`children()` used outside a module definition.',
        stmt.nameSpan,
        'eval.children-outside-module',
      );
      return;
    }
    const list = this.childStatementList(ctx);
    const selector = stmt.args.length > 0 ? this.evalExpr(stmt.args[0].value, scope) : undefined;

    let indices: number[];
    if (selector === undefined) {
      indices = list.map((_, i) => i);
    } else if (typeof selector === 'number') {
      indices = [Math.floor(selector)];
    } else if (selector instanceof RangeValue) {
      indices = selector.toArray().map((n) => Math.floor(n));
    } else if (Array.isArray(selector)) {
      indices = selector.filter((n): n is number => typeof n === 'number').map((n) => Math.floor(n));
    } else {
      this.diagnostics.warn(
        '`children()` expects a number, range or vector of indices.',
        stmt.nameSpan,
        'eval.children-selector',
      );
      return;
    }

    const kids: SceneNode[] = [];
    for (const i of indices) {
      const child = list[i];
      if (!child) {
        this.diagnostics.warn(
          `children(${i}) is out of range; this module was given ${list.length} child${list.length === 1 ? '' : 'ren'}.`,
          stmt.nameSpan,
          'eval.children-range',
        );
        continue;
      }
      // Children evaluate in the scope they were *written* in, not where
      // `children()` appears — that is what makes them behave like arguments.
      this.executeStatement(child, new Scope(ctx.scope, scope), kids, file);
    }
    this.emit(out, group(kids, stmt.roles, stmt.span));
  }

  // -- argument binding -----------------------------------------------------

  /** Binds call arguments onto a user module's parameters, in the callee scope. */
  private bindParameters(
    params: Parameter[],
    args: Argument[],
    callerScope: Scope,
    calleeScope: Scope,
    what: string,
    span: SourceSpan,
  ): void {
    const filled = new Set<string>();

    // Named arguments first, so positional ones can skip the slots they took.
    for (const arg of args) {
      if (!arg.name) continue;
      const value = this.evalExpr(arg.value, callerScope);
      if (arg.name.startsWith('$')) {
        calleeScope.specials.set(arg.name, value);
        continue;
      }
      if (!params.some((p) => p.name === arg.name)) {
        this.diagnostics.warn(
          `\`${what}()\` has no parameter named \`${arg.name}\`.`,
          arg.span,
          'eval.unknown-argument',
        );
        continue;
      }
      calleeScope.vars.set(arg.name, value);
      filled.add(arg.name);
    }

    let next = 0;
    for (const arg of args) {
      if (arg.name) continue;
      while (next < params.length && filled.has(params[next].name)) next++;
      if (next >= params.length) {
        this.diagnostics.warn(
          `Too many arguments to \`${what}()\`; expected at most ${params.length}.`,
          arg.span,
          'eval.too-many-arguments',
        );
        break;
      }
      const param = params[next++];
      calleeScope.vars.set(param.name, this.evalExpr(arg.value, callerScope));
      filled.add(param.name);
    }

    // Defaults evaluate in the callee scope so they may reference earlier params.
    for (const param of params) {
      if (filled.has(param.name)) continue;
      calleeScope.vars.set(
        param.name,
        param.default ? this.evalExpr(param.default, calleeScope) : undefined,
      );
    }
    void span;
  }

  /** Binds call arguments for a built-in module, returning a name -> value map. */
  private bindArguments(
    params: string[],
    args: Argument[],
    scope: Scope,
    what: string,
    span: SourceSpan,
    acceptsExtra = false,
  ): Map<string, Value> {
    const bound = new Map<string, Value>();

    for (const arg of args) {
      if (!arg.name) continue;
      const value = this.evalExpr(arg.value, scope);
      if (arg.name.startsWith('$')) {
        bound.set(arg.name, value);
        continue;
      }
      if (!params.includes(arg.name) && !acceptsExtra) {
        this.diagnostics.warn(
          `\`${what}()\` has no parameter named \`${arg.name}\`.`,
          arg.span,
          'eval.unknown-argument',
        );
        continue;
      }
      bound.set(arg.name, value);
    }

    let next = 0;
    for (const arg of args) {
      if (arg.name) continue;
      while (next < params.length && bound.has(params[next])) next++;
      if (next >= params.length) {
        if (!acceptsExtra) {
          this.diagnostics.warn(
            `Too many arguments to \`${what}()\`.`,
            arg.span,
            'eval.too-many-arguments',
          );
        }
        break;
      }
      bound.set(params[next++], this.evalExpr(arg.value, scope));
    }
    void span;
    return bound;
  }

  // -- echo / assert --------------------------------------------------------

  private runEcho(args: Argument[], scope: Scope, span: SourceSpan): void {
    const parts = args.map((a) => ({ name: a.name, value: this.evalExpr(a.value, scope) }));
    this.diagnostics.echo(`ECHO: ${echoArgs(parts)}`, span);
  }

  private runAssert(args: Argument[], scope: Scope, span: SourceSpan): void {
    const positional = args.filter((a) => !a.name);
    const named = new Map(args.filter((a) => a.name).map((a) => [a.name!, a.value]));
    const conditionExpr = named.get('condition') ?? positional[0]?.value;
    const messageExpr = named.get('message') ?? positional[1]?.value;

    if (!conditionExpr) {
      this.diagnostics.error('`assert()` requires a condition.', span, 'eval.assert-no-condition');
      return;
    }
    const condition = this.evalExpr(conditionExpr, scope);
    if (isTruthy(condition)) return;

    const detail = messageExpr ? `: ${toStringValue(this.evalExpr(messageExpr, scope))}` : '';
    throw new ScadError(`Assertion failed${detail}`, span, 'eval.assert-failed');
  }

  // -- expressions ----------------------------------------------------------

  evalExpr(expr: Expr, scope: Scope): Value {
    switch (expr.kind) {
      case 'number':
        return expr.value;
      case 'string':
        return expr.value;
      case 'bool':
        return expr.value;
      case 'undef':
        return undefined;

      case 'identifier': {
        const found = scope.lookupVar(expr.name);
        if (!found.found) {
          // Constants sit below every user scope, so an assignment of the same
          // name shadows them — which is exactly how OpenSCAD behaves.
          if (Object.hasOwn(BUILTIN_CONSTANTS, expr.name)) return BUILTIN_CONSTANTS[expr.name];
          // A bare identifier naming a function is a first-class function value.
          const fn = scope.lookupFunction(expr.name);
          if (fn) return new FunctionValue(fn.params, fn.body, fn.scope, fn.name);
          this.diagnostics.warn(
            `\`${expr.name}\` is not defined; using undef.`,
            expr.span,
            'eval.undefined-variable',
          );
        }
        return found.value;
      }

      case 'list': {
        const out: Value[] = [];
        for (const element of expr.elements) this.evalListElement(element, scope, out);
        return out;
      }

      case 'range': {
        const begin = asNumber(this.evalExpr(expr.start, scope));
        const end = asNumber(this.evalExpr(expr.end, scope));
        const step = expr.step === undefined ? 1 : asNumber(this.evalExpr(expr.step, scope));
        if (Number.isNaN(begin) || Number.isNaN(end) || Number.isNaN(step)) {
          this.diagnostics.warn('Range bounds must be numbers.', expr.span, 'eval.bad-range');
          return undefined;
        }
        if (step === 0) {
          this.diagnostics.warn('Range step is zero; the range is empty.', expr.span, 'eval.bad-range');
        }
        return new RangeValue(begin, step, end);
      }

      case 'index': {
        const target = this.evalExpr(expr.target, scope);
        const index = this.evalExpr(expr.index, scope);
        return this.indexInto(target, index);
      }

      case 'member': {
        const target = this.evalExpr(expr.target, scope);
        const slot = { x: 0, y: 1, z: 2 }[expr.property];
        if (slot === undefined || !Array.isArray(target)) return undefined;
        return target[slot];
      }

      case 'unary': {
        const operand = this.evalExpr(expr.operand, scope);
        if (expr.op === '!') return !isTruthy(operand);
        if (expr.op === '+') return typeof operand === 'number' ? operand : undefined;
        if (typeof operand === 'number') return -operand;
        if (Array.isArray(operand)) return operand.map((e) => (typeof e === 'number' ? -e : undefined));
        return undefined;
      }

      case 'binary':
        return this.evalBinary(expr.op, expr.left, expr.right, scope, expr.span);

      case 'ternary':
        return isTruthy(this.evalExpr(expr.condition, scope))
          ? this.evalExpr(expr.then, scope)
          : this.evalExpr(expr.else, scope);

      case 'let': {
        const inner = new Scope(scope, scope);
        for (const b of expr.bindings) inner.setVar(b.name, this.evalExpr(b.value, inner));
        return this.evalExpr(expr.body, inner);
      }

      case 'assert-expr': {
        this.runAssert(expr.args, scope, expr.span);
        return expr.body ? this.evalExpr(expr.body, scope) : undefined;
      }

      case 'echo-expr': {
        this.runEcho(expr.args, scope, expr.span);
        return expr.body ? this.evalExpr(expr.body, scope) : undefined;
      }

      case 'lambda':
        return new FunctionValue(expr.params, expr.body, scope, 'anonymous');

      case 'call':
        return this.evalCall(expr, scope);

      default: {
        const never: never = expr;
        throw new Error(`Unhandled expression ${(never as Expr).kind}`);
      }
    }
  }

  private indexInto(target: Value, index: Value): Value {
    if (typeof index !== 'number') return undefined;
    const i = Math.floor(index);
    if (typeof target === 'string') {
      const chars = [...target];
      return i >= 0 && i < chars.length ? chars[i] : undefined;
    }
    if (Array.isArray(target)) return i >= 0 && i < target.length ? target[i] : undefined;
    if (target instanceof RangeValue) {
      const arr = target.toArray();
      return i >= 0 && i < arr.length ? arr[i] : undefined;
    }
    return undefined;
  }

  private evalListElement(element: ListElement, scope: Scope, out: Value[]): void {
    switch (element.kind) {
      case 'item':
        out.push(this.evalExpr(element.value, scope));
        return;

      case 'each': {
        const value = this.evalExpr(element.value, scope);
        // `each undef` contributes nothing, which is how `each` is used to
        // conditionally omit elements.
        if (value === undefined) return;
        out.push(...toList(value));
        return;
      }

      case 'comp-for':
        this.iterateForClauses(element.clauses, 0, scope, (iterScope) => {
          this.evalListElement(element.body, iterScope, out);
        });
        return;

      case 'comp-for-c': {
        let iterScope = new Scope(scope, scope);
        for (const init of element.init) iterScope.setVar(init.name, this.evalExpr(init.value, iterScope));
        let guard = 0;
        while (isTruthy(this.evalExpr(element.condition, iterScope))) {
          if (++guard > 1_000_000) {
            this.diagnostics.error(
              'C-style list comprehension exceeded 1,000,000 iterations; aborting.',
              element.span,
              'eval.loop-limit',
            );
            break;
          }
          this.evalListElement(element.body, iterScope, out);
          const nextScope = new Scope(scope, scope);
          for (const [k, v] of iterScope.vars) nextScope.vars.set(k, v);
          for (const [k, v] of iterScope.specials) nextScope.specials.set(k, v);
          for (const upd of element.update) nextScope.setVar(upd.name, this.evalExpr(upd.value, iterScope));
          iterScope = nextScope;
        }
        return;
      }

      case 'comp-if': {
        if (isTruthy(this.evalExpr(element.condition, scope))) {
          this.evalListElement(element.then, scope, out);
        } else if (element.else) {
          this.evalListElement(element.else, scope, out);
        }
        return;
      }

      case 'comp-let': {
        const inner = new Scope(scope, scope);
        for (const b of element.bindings) inner.setVar(b.name, this.evalExpr(b.value, inner));
        this.evalListElement(element.body, inner, out);
        return;
      }
    }
  }

  private evalBinary(
    op: string,
    leftExpr: Expr,
    rightExpr: Expr,
    scope: Scope,
    span: SourceSpan,
  ): Value {
    // Short-circuit before evaluating the right-hand side.
    if (op === '&&') {
      return isTruthy(this.evalExpr(leftExpr, scope)) ? isTruthy(this.evalExpr(rightExpr, scope)) : false;
    }
    if (op === '||') {
      return isTruthy(this.evalExpr(leftExpr, scope)) ? true : isTruthy(this.evalExpr(rightExpr, scope));
    }

    const a = this.evalExpr(leftExpr, scope);
    const b = this.evalExpr(rightExpr, scope);

    switch (op) {
      case '==':
        return deepEqual(a, b);
      case '!=':
        return !deepEqual(a, b);
      case '<':
        return compare(a, b) < 0;
      case '<=':
        return compare(a, b) <= 0;
      case '>':
        return compare(a, b) > 0;
      case '>=':
        return compare(a, b) >= 0;
      case '+':
        return this.arithmetic(a, b, (x, y) => x + y, span, '+');
      case '-':
        return this.arithmetic(a, b, (x, y) => x - y, span, '-');
      case '%':
        if (typeof a !== 'number' || typeof b !== 'number') return undefined;
        return a % b;
      case '^':
        if (typeof a !== 'number' || typeof b !== 'number') return undefined;
        return Math.pow(a, b);
      case '/':
        return this.divide(a, b);
      case '*':
        return this.multiply(a, b, span);
      default:
        return undefined;
    }
  }

  /** `+`/`-`: numbers, or elementwise over equal-length vectors. */
  private arithmetic(
    a: Value,
    b: Value,
    f: (x: number, y: number) => number,
    span: SourceSpan,
    op: string,
  ): Value {
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        this.diagnostics.warn(
          `Cannot apply \`${op}\` to vectors of different lengths (${a.length} and ${b.length}).`,
          span,
          'eval.vector-length-mismatch',
        );
        return undefined;
      }
      return a.map((e, i) => this.arithmetic(e, b[i], f, span, op));
    }
    return undefined;
  }

  private divide(a: Value, b: Value): Value {
    if (typeof a === 'number' && typeof b === 'number') return a / b;
    if (Array.isArray(a) && typeof b === 'number') return a.map((e) => this.divide(e, b));
    return undefined;
  }

  /**
   * `*` is heavily overloaded in OpenSCAD: scalar product, scaling, dot
   * product, matrix-vector and matrix-matrix multiplication all share it.
   */
  private multiply(a: Value, b: Value, span: SourceSpan): Value {
    if (typeof a === 'number' && typeof b === 'number') return a * b;
    if (typeof a === 'number' && Array.isArray(b)) return b.map((e) => this.multiply(a, e, span));
    if (Array.isArray(a) && typeof b === 'number') return a.map((e) => this.multiply(e, b, span));

    if (!Array.isArray(a) || !Array.isArray(b)) return undefined;

    const aIsMatrix = a.length > 0 && Array.isArray(a[0]);
    const bIsMatrix = b.length > 0 && Array.isArray(b[0]);

    if (!aIsMatrix && !bIsMatrix) {
      // vector · vector -> scalar
      if (a.length !== b.length) {
        this.diagnostics.warn(
          `Dot product needs vectors of equal length (${a.length} and ${b.length}).`,
          span,
          'eval.vector-length-mismatch',
        );
        return undefined;
      }
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (typeof x !== 'number' || typeof y !== 'number') return undefined;
        sum += x * y;
      }
      return sum;
    }

    const asMatrix = (v: Value[]): number[][] | undefined => {
      const rows: number[][] = [];
      for (const row of v) {
        if (!Array.isArray(row)) return undefined;
        const cells: number[] = [];
        for (const cell of row) {
          if (typeof cell !== 'number') return undefined;
          cells.push(cell);
        }
        rows.push(cells);
      }
      return rows;
    };

    const asNumbers = (v: Value[]): number[] | undefined => {
      const out: number[] = [];
      for (const e of v) {
        if (typeof e !== 'number') return undefined;
        out.push(e);
      }
      return out;
    };

    if (aIsMatrix && bIsMatrix) {
      const ma = asMatrix(a);
      const mb = asMatrix(b);
      if (!ma || !mb || ma[0].length !== mb.length) return undefined;
      return ma.map((row) =>
        mb[0].map((_, j) => row.reduce((sum, cell, k) => sum + cell * mb[k][j], 0)),
      );
    }

    if (aIsMatrix && !bIsMatrix) {
      const ma = asMatrix(a);
      const vb = asNumbers(b);
      if (!ma || !vb || ma[0].length !== vb.length) return undefined;
      return ma.map((row) => row.reduce((sum, cell, k) => sum + cell * vb[k], 0));
    }

    // vector * matrix (row-vector convention)
    const va = asNumbers(a);
    const mb = asMatrix(b);
    if (!va || !mb || va.length !== mb.length) return undefined;
    return mb[0].map((_, j) => va.reduce((sum, cell, k) => sum + cell * mb[k][j], 0));
  }

  private evalCall(expr: Extract<Expr, { kind: 'call' }>, scope: Scope): Value {
    // Direct calls to a named function take the fast path; everything else
    // evaluates the callee to a FunctionValue first.
    if (expr.callee.kind === 'identifier') {
      const name = expr.callee.name;

      const userFn = scope.lookupFunction(name);
      if (userFn) {
        return this.invokeFunction(
          new FunctionValue(userFn.params, userFn.body, userFn.scope, userFn.name),
          expr.args,
          scope,
          expr.span,
        );
      }

      // A variable holding a function value shadows nothing but takes priority
      // over a builtin of the same name, matching OpenSCAD.
      const asVar = scope.lookupVar(name);
      if (asVar.found && asVar.value instanceof FunctionValue) {
        return this.invokeFunction(asVar.value, expr.args, scope, expr.span);
      }

      const builtin = BUILTIN_FUNCTIONS[name];
      if (builtin) {
        const args = this.bindBuiltinFunctionArgs(builtin.params, builtin.variadic ?? false, expr.args, scope, name);
        return builtin.fn(args, { ...this.builtinContext, span: expr.span });
      }

      this.diagnostics.warn(`\`${name}()\` is not a known function.`, expr.span, 'eval.unknown-function');
      return undefined;
    }

    const callee = this.evalExpr(expr.callee, scope);
    if (callee instanceof FunctionValue) return this.invokeFunction(callee, expr.args, scope, expr.span);
    this.diagnostics.warn(
      `Cannot call a value of type ${typeOf(callee)}.`,
      expr.span,
      'eval.not-callable',
    );
    return undefined;
  }

  private bindBuiltinFunctionArgs(
    params: string[],
    variadic: boolean,
    args: Argument[],
    scope: Scope,
    name: string,
  ): Value[] {
    if (variadic) return args.map((a) => this.evalExpr(a.value, scope));

    const slots = new Array<Value>(params.length).fill(undefined);
    const filled = new Set<number>();

    for (const arg of args) {
      if (!arg.name) continue;
      const index = params.indexOf(arg.name);
      if (index < 0) {
        this.diagnostics.warn(
          `\`${name}()\` has no parameter named \`${arg.name}\`.`,
          arg.span,
          'eval.unknown-argument',
        );
        continue;
      }
      slots[index] = this.evalExpr(arg.value, scope);
      filled.add(index);
    }

    let next = 0;
    for (const arg of args) {
      if (arg.name) continue;
      while (next < params.length && filled.has(next)) next++;
      if (next >= params.length) break;
      slots[next] = this.evalExpr(arg.value, scope);
      filled.add(next++);
    }
    return slots;
  }

  private invokeFunction(fn: FunctionValue, args: Argument[], callerScope: Scope, span: SourceSpan): Value {
    if (this.depth >= this.maxDepth) {
      this.diagnostics.error(
        `Maximum function recursion depth (${this.maxDepth}) exceeded in \`${fn.name}()\`.`,
        span,
        'eval.recursion-limit',
      );
      throw new EvaluationHalt();
    }
    const defScope = fn.env as Scope;
    const invocation = new Scope(defScope, callerScope);
    this.bindParameters(fn.params, args, callerScope, invocation, fn.name, span);
    this.depth++;
    try {
      return this.evalExpr(fn.body, invocation);
    } finally {
      this.depth--;
    }
  }

  // -- helpers exposed to the built-in module table -------------------------

  warn(message: string, span?: SourceSpan, code?: string): void {
    this.diagnostics.warn(message, span, code);
  }
}

// ---------------------------------------------------------------------------
// Built-in modules
// ---------------------------------------------------------------------------

interface BuiltinModule {
  params: string[];
  /** Modules like `color()` tolerate arbitrary extra named arguments. */
  acceptsExtra?: boolean;
  build(
    args: Map<string, Value>,
    children: SceneNode[],
    scope: Scope,
    interp: Interpreter,
    span: SourceSpan,
  ): SceneNode | undefined;
}

/** Reads `$fn/$fa/$fs`, letting a call-site override (`sphere($fn=64)`) win. */
function resolutionFor(args: Map<string, Value>, scope: Scope): Resolution {
  const base = scope.resolution();
  return {
    fn: args.has('$fn') ? asNumber(args.get('$fn'), base.fn) : base.fn,
    fa: args.has('$fa') ? asNumber(args.get('$fa'), base.fa) : base.fa,
    fs: args.has('$fs') ? asNumber(args.get('$fs'), base.fs) : base.fs,
  };
}

function transformNode(matrix: Mat4, children: SceneNode[], span: SourceSpan): SceneNode {
  return node('transform', { matrix }, children, [], span);
}

/** OpenSCAD's cylinder parameter juggling: r/d, r1/r2, d1/d2. */
function cylinderRadii(args: Map<string, Value>): { r1: number; r2: number } {
  const r = args.get('r');
  const d = args.get('d');
  const r1 = args.get('r1');
  const r2 = args.get('r2');
  const d1 = args.get('d1');
  const d2 = args.get('d2');

  const base = d !== undefined ? asNumber(d, 2) / 2 : r !== undefined ? asNumber(r, 1) : 1;
  const top = d2 !== undefined ? asNumber(d2, 2) / 2 : r2 !== undefined ? asNumber(r2, base) : base;
  const bottom = d1 !== undefined ? asNumber(d1, 2) / 2 : r1 !== undefined ? asNumber(r1, base) : base;
  return { r1: Math.max(0, bottom), r2: Math.max(0, top) };
}

export const BUILTIN_MODULES: Record<string, BuiltinModule> = {
  // --- 3D primitives ---
  cube: {
    params: ['size', 'center'],
    build: (args, _children, _scope, _interp, span) => {
      const size = asVector(args.get('size') ?? 1, 3, 1) ?? [1, 1, 1];
      return node('cube', { size, center: isTruthy(args.get('center')) }, [], [], span);
    },
  },

  sphere: {
    params: ['r', 'd'],
    build: (args, _children, scope, _interp, span) => {
      const d = args.get('d');
      const r = d !== undefined ? asNumber(d, 2) / 2 : asNumber(args.get('r'), 1);
      return node('sphere', { r: Math.max(0, r), resolution: resolutionFor(args, scope) }, [], [], span);
    },
  },

  cylinder: {
    params: ['h', 'r', 'r1', 'r2', 'center', 'd', 'd1', 'd2'],
    build: (args, _children, scope, _interp, span) => {
      const { r1, r2 } = cylinderRadii(args);
      return node(
        'cylinder',
        {
          h: Math.max(0, asNumber(args.get('h'), 1)),
          r1,
          r2,
          center: isTruthy(args.get('center')),
          resolution: resolutionFor(args, scope),
        },
        [],
        [],
        span,
      );
    },
  },

  polyhedron: {
    params: ['points', 'faces', 'convexity', 'triangles'],
    build: (args, _children, _scope, interp, span) => {
      const rawPoints = args.get('points');
      // `triangles` is the pre-2014 spelling of `faces`, still found in the wild.
      const rawFaces = args.get('faces') ?? args.get('triangles');
      if (args.get('faces') === undefined && args.get('triangles') !== undefined) {
        interp.warn(
          '`triangles=` is deprecated; use `faces=`.',
          span,
          'eval.deprecated-triangles',
        );
      }
      const points: [number, number, number][] = [];
      for (const p of toList(rawPoints)) {
        const v = asVector(p, 3);
        if (!v) {
          interp.warn('polyhedron(): every point must be a 3-vector.', span, 'eval.bad-polyhedron');
          return undefined;
        }
        points.push([v[0], v[1], v[2]]);
      }
      const faces: number[][] = [];
      for (const f of toList(rawFaces)) {
        const indices = toList(f)
          .map((n) => (typeof n === 'number' ? Math.floor(n) : Number.NaN))
          .filter((n) => Number.isFinite(n));
        if (indices.length >= 3) faces.push(indices);
      }
      return node('polyhedron', { points, faces }, [], [], span);
    },
  },

  // --- 2D primitives ---
  square: {
    params: ['size', 'center'],
    build: (args, _children, _scope, _interp, span) => {
      const size = asVector(args.get('size') ?? 1, 2, 1) ?? [1, 1];
      return node('square', { size, center: isTruthy(args.get('center')) }, [], [], span);
    },
  },

  circle: {
    params: ['r', 'd'],
    build: (args, _children, scope, _interp, span) => {
      const d = args.get('d');
      const r = d !== undefined ? asNumber(d, 2) / 2 : asNumber(args.get('r'), 1);
      return node('circle', { r: Math.max(0, r), resolution: resolutionFor(args, scope) }, [], [], span);
    },
  },

  polygon: {
    params: ['points', 'paths', 'convexity'],
    build: (args, _children, _scope, interp, span) => {
      const points: [number, number][] = [];
      for (const p of toList(args.get('points'))) {
        const v = asVector(p, 2);
        if (!v) {
          interp.warn('polygon(): every point must be a 2-vector.', span, 'eval.bad-polygon');
          return undefined;
        }
        points.push([v[0], v[1]]);
      }
      const rawPaths = args.get('paths');
      let paths: number[][] | undefined;
      if (rawPaths !== undefined && rawPaths !== 'undef') {
        paths = [];
        for (const path of toList(rawPaths)) {
          paths.push(
            toList(path)
              .map((n) => (typeof n === 'number' ? Math.floor(n) : Number.NaN))
              .filter((n) => Number.isFinite(n)),
          );
        }
      }
      return node('polygon', { points, paths }, [], [], span);
    },
  },

  text: {
    params: [
      'text', 'size', 'font', 'halign', 'valign', 'spacing',
      'direction', 'language', 'script',
    ],
    build: (args, _children, scope, _interp, span) =>
      node(
        'text',
        {
          text: args.get('text') === undefined ? '' : toStringValue(args.get('text')),
          size: asNumber(args.get('size'), 10),
          font: args.get('font') === undefined ? '' : toStringValue(args.get('font')),
          halign: args.get('halign') === undefined ? 'left' : toStringValue(args.get('halign')),
          valign: args.get('valign') === undefined ? 'baseline' : toStringValue(args.get('valign')),
          spacing: asNumber(args.get('spacing'), 1),
          direction: args.get('direction') === undefined ? 'ltr' : toStringValue(args.get('direction')),
          language: args.get('language') === undefined ? 'en' : toStringValue(args.get('language')),
          script: args.get('script') === undefined ? 'latin' : toStringValue(args.get('script')),
          resolution: resolutionFor(args, scope),
        },
        [],
        [],
        span,
      ),
  },

  // --- transforms ---
  translate: {
    params: ['v'],
    build: (args, children, _scope, _interp, span) => {
      const v = asVector(args.get('v') ?? 0, 3, 0) ?? [0, 0, 0];
      return transformNode(translation(v[0], v[1], v[2]), children, span);
    },
  },

  rotate: {
    params: ['a', 'v'],
    build: (args, children, _scope, _interp, span) => {
      const a = args.get('a');
      const axis = args.get('v');
      if (axis !== undefined) {
        const v = asVector(axis, 3, 0) ?? [0, 0, 1];
        return transformNode(rotationAxis([v[0], v[1], v[2]], asNumber(a, 0)), children, span);
      }
      if (Array.isArray(a)) {
        const v = asVector(a, 3, 0) ?? [0, 0, 0];
        return transformNode(rotationXYZ(v[0], v[1], v[2]), children, span);
      }
      // `rotate(45)` is a rotation about Z.
      return transformNode(rotationXYZ(0, 0, asNumber(a, 0)), children, span);
    },
  },

  scale: {
    params: ['v'],
    build: (args, children, _scope, _interp, span) => {
      const v = asVector(args.get('v') ?? 1, 3, 1) ?? [1, 1, 1];
      return transformNode(scaling(v[0], v[1], v[2]), children, span);
    },
  },

  mirror: {
    params: ['v'],
    build: (args, children, _scope, _interp, span) => {
      const v = asVector(args.get('v') ?? [1, 0, 0], 3, 0) ?? [1, 0, 0];
      return transformNode(mirrorMatrix(v[0], v[1], v[2]), children, span);
    },
  },

  multmatrix: {
    params: ['m'],
    build: (args, children, _scope, interp, span) => {
      const rows = toList(args.get('m'));
      // Row-major 4x4 (or 3x4) in source; the scene graph is column-major.
      const m: number[][] = [];
      for (const row of rows) m.push(toList(row).map((n) => asNumber(n, 0)));
      while (m.length < 4) m.push([0, 0, 0, 1].slice(0, 4));
      if (m.some((row) => row.length < 4)) {
        for (const row of m) while (row.length < 4) row.push(row.length === 3 ? 0 : 0);
        m[3] = [0, 0, 0, 1];
      }
      if (rows.length === 0) {
        interp.warn('multmatrix(): missing matrix.', span, 'eval.bad-matrix');
        return group(children, [], span);
      }
      const matrix: Mat4 = [
        m[0][0], m[1][0], m[2][0], m[3][0],
        m[0][1], m[1][1], m[2][1], m[3][1],
        m[0][2], m[1][2], m[2][2], m[3][2],
        m[0][3], m[1][3], m[2][3], m[3][3],
      ];
      return transformNode(matrix, children, span);
    },
  },

  resize: {
    params: ['newsize', 'auto', 'convexity'],
    build: (args, children, _scope, _interp, span) => {
      const newsize = asVector(args.get('newsize') ?? 0, 3, 0) ?? [0, 0, 0];
      const rawAuto = args.get('auto');
      const auto = Array.isArray(rawAuto)
        ? rawAuto.map((v) => isTruthy(v))
        : [isTruthy(rawAuto), isTruthy(rawAuto), isTruthy(rawAuto)];
      return node('resize', { newsize, auto }, children, [], span);
    },
  },

  color: {
    params: ['c', 'alpha'],
    build: (args, children, _scope, _interp, span) => {
      const c = args.get('c');
      const alpha = args.get('alpha');
      return node(
        'color',
        { color: c, alpha: alpha === undefined ? undefined : asNumber(alpha, 1) },
        children,
        [],
        span,
      );
    },
  },

  offset: {
    params: ['r', 'delta', 'chamfer'],
    build: (args, children, scope, _interp, span) => {
      const r = args.get('r');
      const delta = args.get('delta');
      return node(
        'offset',
        {
          amount: r !== undefined ? asNumber(r, 0) : asNumber(delta, 0),
          round: r !== undefined,
          chamfer: isTruthy(args.get('chamfer')),
          resolution: resolutionFor(args, scope),
        },
        children,
        [],
        span,
      );
    },
  },

  // --- booleans and grouping ---
  union: { params: [], build: (_a, children, _s, _i, span) => node('union', {}, children, [], span) },
  difference: {
    params: [],
    build: (_a, children, _s, _i, span) => node('difference', {}, children, [], span),
  },
  intersection: {
    params: [],
    build: (_a, children, _s, _i, span) => node('intersection', {}, children, [], span),
  },
  group: { params: [], build: (_a, children, _s, _i, span) => group(children, [], span) },
  hull: { params: [], build: (_a, children, _s, _i, span) => node('hull', {}, children, [], span) },
  minkowski: {
    params: ['convexity'],
    build: (_a, children, _s, _i, span) => node('minkowski', {}, children, [], span),
  },

  render: {
    params: ['convexity'],
    // `render()` forces full evaluation of its subtree; in this engine every
    // boolean is already exact, so it is a pass-through that preserves intent.
    build: (_a, children, _s, _i, span) => node('render', {}, children, [], span),
  },

  // --- 2D <-> 3D ---
  linear_extrude: {
    params: ['height', 'center', 'convexity', 'twist', 'slices', 'scale', 'v'],
    build: (args, children, scope, _interp, span) => {
      const scaleArg = args.get('scale');
      const scaleTop = scaleArg === undefined ? [1, 1] : (asVector(scaleArg, 2, 1) ?? [1, 1]);
      const twist = asNumber(args.get('twist'), 0);
      const height = asNumber(args.get('height'), 100);
      const res = resolutionFor(args, scope);
      const slicesArg = args.get('slices');
      // Twisted extrusions need enough slices to stay smooth; OpenSCAD derives
      // a default from the twist angle and $fa/$fs when `slices` is absent.
      const slices =
        slicesArg !== undefined
          ? Math.max(1, Math.floor(asNumber(slicesArg, 1)))
          : twist === 0
            ? 1
            : Math.max(1, Math.ceil(Math.abs(twist) / Math.max(res.fa, 1)));
      return node(
        'linear_extrude',
        {
          height,
          center: isTruthy(args.get('center')),
          twist,
          slices,
          scaleTop,
          // `v=` extrudes along an arbitrary vector rather than straight up.
          v: args.get('v') === undefined ? undefined : asVector(args.get('v'), 3, 0),
          resolution: res,
        },
        children,
        [],
        span,
      );
    },
  },

  rotate_extrude: {
    params: ['angle', 'convexity', 'start'],
    build: (args, children, scope, _interp, span) =>
      node(
        'rotate_extrude',
        {
          angle: args.get('angle') === undefined ? 360 : asNumber(args.get('angle'), 360),
          start: asNumber(args.get('start'), 0),
          resolution: resolutionFor(args, scope),
        },
        children,
        [],
        span,
      ),
  },

  projection: {
    params: ['cut'],
    build: (args, children, _scope, _interp, span) =>
      node('projection', { cut: isTruthy(args.get('cut')) }, children, [], span),
  },

  // --- imports ---
  import: {
    params: ['file', 'convexity', 'layer', 'origin', 'scale', 'center', 'id', 'dpi'],
    build: (args, _children, scope, _interp, span) =>
      node(
        'import',
        {
          file: toStringValue(args.get('file') ?? ''),
          layer: args.get('layer') === undefined ? undefined : toStringValue(args.get('layer')),
          origin: asVector(args.get('origin') ?? 0, 2, 0) ?? [0, 0],
          scale: asNumber(args.get('scale'), 1),
          center: isTruthy(args.get('center')),
          dpi: asNumber(args.get('dpi'), 72),
          resolution: resolutionFor(args, scope),
        },
        [],
        [],
        span,
      ),
  },

  surface: {
    params: ['file', 'center', 'convexity', 'invert'],
    build: (args, _children, _scope, _interp, span) =>
      node(
        'surface',
        {
          file: toStringValue(args.get('file') ?? ''),
          center: isTruthy(args.get('center')),
          invert: isTruthy(args.get('invert')),
        },
        [],
        [],
        span,
      ),
  },
};

// --- BetterSCAD language extensions ---------------------------------------
//
// Both carry a downgrade path to legacy `.scad` (spec feature 21); see
// `transpile.ts`, which performs the rewrite.

/**
 * `negative() { ... }` — marks a subtree as negative space, subtracted from
 * every sibling in the enclosing scope. Implemented purely by attaching the
 * `negative` role, with no change to the CSG evaluator: exactly the "contained
 * change" the role architecture exists to make possible (spec feature 3a).
 */
BUILTIN_MODULES.negative = {
  params: [],
  build: (_args, children, _scope, _interp, span) => group(children, ['negative'], span),
};

/** `import_stl`/`import_dxf`/`import_off` are legacy aliases for `import`. */
for (const alias of ['import_stl', 'import_dxf', 'import_off']) {
  BUILTIN_MODULES[alias] = BUILTIN_MODULES.import;
}

export function evaluate(file: ScadFile, options: EvaluateOptions = {}): EvaluateResult {
  return new Interpreter(options).run(file);
}

export { IDENTITY, matMultiply };
