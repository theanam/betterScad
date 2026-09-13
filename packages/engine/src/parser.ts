/**
 * Hand-written recursive-descent parser with precedence climbing for
 * expressions (spec feature 3a: "own grammar, own AST, no borrowed parser").
 *
 * The parser recovers from errors rather than bailing on the first one, so the
 * editor can show every problem in a file at once (spec feature 13). Recovery
 * is the usual "skip to the next `;` or `}` at the current brace depth".
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
import { Diagnostic, SourceSpan, mergeSpans } from './diagnostics.js';
import { T, Token, lex } from './lexer.js';

/** Source-level spelling of a debug modifier, mapped to its role name. */
export const MODIFIER_ROLES: Record<string, string> = {
  '%': 'background',
  '#': 'highlight',
  '!': 'root',
  '*': 'disabled',
};

export interface ParseResult {
  file: ScadFile;
  diagnostics: Diagnostic[];
  /** Forwarded from the lexer for the Customizer to mine. */
  lineComments: { text: string; span: SourceSpan }[];
  blockComments: { text: string; span: SourceSpan }[];
}

class ParseAbort extends Error {}

/** Binary operator precedence; higher binds tighter. */
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  // `^` is deliberately absent: exponentiation binds tighter than unary minus
  // (`-2 ^ 2` is -4), which the precedence-climbing loop cannot express. It is
  // handled by `parsePower` instead.
};

class Parser {
  private pos = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly file: string,
  ) {}

  // -- token helpers --------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private get current(): Token {
    return this.peek();
  }

  private next(): Token {
    const tok = this.current;
    if (tok.kind !== T.EOF) this.pos++;
    return tok;
  }

  private at(kind: T, text?: string): boolean {
    const tok = this.current;
    return tok.kind === kind && (text === undefined || tok.text === text);
  }

  private atPunct(...texts: string[]): boolean {
    return this.current.kind === T.Punct && texts.includes(this.current.text);
  }

  private eat(kind: T, text?: string): Token | undefined {
    if (this.at(kind, text)) return this.next();
    return undefined;
  }

  private expect(kind: T, text?: string): Token {
    const tok = this.eat(kind, text);
    if (tok) return tok;
    const what = text ? `\`${text}\`` : kind;
    this.error(`Expected ${what} but found \`${this.current.text}\`.`, this.current.span, 'parse.expected');
    throw new ParseAbort();
  }

  private error(message: string, span: SourceSpan, code: string): void {
    this.diagnostics.push({ severity: 'error', message, span, code });
  }

  private warn(message: string, span: SourceSpan, code: string): void {
    this.diagnostics.push({ severity: 'warning', message, span, code });
  }

  private spanTo(start: SourceSpan): SourceSpan {
    const prev = this.tokens[Math.max(0, this.pos - 1)];
    return { file: this.file, start: start.start, end: prev.span.end };
  }

  /** Skip forward until a plausible statement boundary, so parsing can resume. */
  private recover(): void {
    let depth = 0;
    while (this.current.kind !== T.EOF) {
      if (this.atPunct('{', '[', '(')) depth++;
      else if (this.atPunct('}', ']', ')')) {
        if (depth === 0) {
          // Leave the closer for the enclosing parser to consume.
          return;
        }
        depth--;
      } else if (this.atPunct(';') && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  // -- top level ------------------------------------------------------------

  parseFile(): ScadFile {
    const body: Statement[] = [];
    while (this.current.kind !== T.EOF) {
      const before = this.pos;
      try {
        const stmt = this.parseStatement();
        if (stmt) body.push(stmt);
      } catch (err) {
        if (!(err instanceof ParseAbort)) throw err;
        this.recover();
      }
      if (this.pos === before) {
        // Guarantee progress even if a sub-parser consumed nothing.
        this.error(
          `Unexpected \`${this.current.text}\` at top level.`,
          this.current.span,
          'parse.unexpected-token',
        );
        this.next();
      }
    }
    return { file: this.file, body };
  }

  // -- statements -----------------------------------------------------------

  private parseModifiers(): string[] {
    const roles: string[] = [];
    while (this.current.kind === T.Punct && this.current.text in MODIFIER_ROLES) {
      roles.push(MODIFIER_ROLES[this.next().text]);
    }
    return roles;
  }

  parseStatement(): Statement | undefined {
    const start = this.current.span;

    if (this.atPunct(';')) {
      this.next();
      return { kind: 'empty', span: this.spanTo(start) };
    }

    // Declarations and includes cannot carry modifiers, so they are checked
    // before the modifier loop.
    if (this.at(T.Keyword, 'module')) return this.parseModuleDecl();
    if (this.at(T.Keyword, 'function') && this.peek(1).kind === T.Identifier) {
      return this.parseFunctionDecl();
    }
    if (this.at(T.Keyword, 'include') || this.at(T.Keyword, 'use')) {
      const keyword = this.next();
      const pathTok = this.eat(T.IncludePath);
      if (!pathTok) {
        this.error(
          `Expected \`<path>\` after \`${keyword.text}\`.`,
          this.current.span,
          'parse.expected-include-path',
        );
        throw new ParseAbort();
      }
      // A trailing `;` is not part of the grammar but is harmless and common.
      this.eat(T.Punct, ';');
      return keyword.text === 'include'
        ? { kind: 'include', path: pathTok.text.trim(), span: this.spanTo(start) }
        : { kind: 'use', path: pathTok.text.trim(), span: this.spanTo(start) };
    }

    // Assignment: `name = expr;`. Must be checked before module-call parsing,
    // which also begins with an identifier.
    if (
      (this.current.kind === T.Identifier || this.isSpecialVarToken(this.current)) &&
      this.peek(1).kind === T.Punct &&
      this.peek(1).text === '='
    ) {
      const name = this.next().text;
      this.next(); // '='
      const value = this.parseExpr();
      this.expectSemicolon();
      return { kind: 'assign', name, value, span: this.spanTo(start) };
    }

    const roles = this.parseModifiers();
    return this.parseModifiableStatement(start, roles);
  }

  private isSpecialVarToken(tok: Token): boolean {
    return tok.kind === T.Identifier && tok.text.startsWith('$');
  }

  private expectSemicolon(): void {
    if (!this.eat(T.Punct, ';')) {
      this.error(`Expected \`;\` but found \`${this.current.text}\`.`, this.current.span, 'parse.expected-semicolon');
      throw new ParseAbort();
    }
  }

  private parseModifiableStatement(start: SourceSpan, roles: string[]): Statement {
    if (this.atPunct('{')) {
      const body = this.parseBlockBody();
      return { kind: 'block', body, roles, span: this.spanTo(start) };
    }

    if (this.at(T.Keyword, 'if')) return this.parseIf(start, roles);
    if (this.at(T.Keyword, 'for')) return this.parseFor(start, roles, false);
    if (this.at(T.Keyword, 'intersection_for')) return this.parseFor(start, roles, true);
    if (this.at(T.Keyword, 'let')) return this.parseLetStatement(start, roles);

    if (this.at(T.Identifier, 'assert') || this.at(T.Identifier, 'echo')) {
      const isAssert = this.current.text === 'assert';
      this.next();
      this.expect(T.Punct, '(');
      const args = this.parseArguments();
      this.expect(T.Punct, ')');
      const body = this.parseChildStatement();
      return isAssert
        ? { kind: 'assert-stmt', args, body, roles, span: this.spanTo(start) }
        : { kind: 'echo-stmt', args, body, roles, span: this.spanTo(start) };
    }

    if (this.current.kind === T.Identifier) {
      const nameTok = this.next();
      this.expect(T.Punct, '(');
      const args = this.parseArguments();
      this.expect(T.Punct, ')');
      const child = this.parseChildStatement();
      return {
        kind: 'module-call',
        name: nameTok.text,
        args,
        children: child ? [child] : [],
        roles,
        nameSpan: nameTok.span,
        span: this.spanTo(start),
      };
    }

    this.error(
      `Expected a statement but found \`${this.current.text}\`.`,
      this.current.span,
      'parse.expected-statement',
    );
    throw new ParseAbort();
  }

  /**
   * The child of a module instantiation: `;` for none, a block, or a single
   * statement.
   */
  private parseChildStatement(): Statement | undefined {
    if (this.eat(T.Punct, ';')) return undefined;
    const stmt = this.parseStatement();
    return stmt && stmt.kind === 'empty' ? undefined : stmt;
  }

  private parseBlockBody(): Statement[] {
    this.expect(T.Punct, '{');
    const body: Statement[] = [];
    while (!this.atPunct('}') && this.current.kind !== T.EOF) {
      const before = this.pos;
      try {
        const stmt = this.parseStatement();
        if (stmt) body.push(stmt);
      } catch (err) {
        if (!(err instanceof ParseAbort)) throw err;
        this.recover();
      }
      if (this.pos === before) {
        this.error(`Unexpected \`${this.current.text}\` in block.`, this.current.span, 'parse.unexpected-token');
        this.next();
      }
    }
    this.expect(T.Punct, '}');
    return body;
  }

  private parseModuleDecl(): Statement {
    const start = this.current.span;
    this.expect(T.Keyword, 'module');
    const name = this.expect(T.Identifier).text;
    this.expect(T.Punct, '(');
    const params = this.parseParameters();
    this.expect(T.Punct, ')');
    const body = this.parseStatement() ?? { kind: 'empty' as const, span: this.spanTo(start) };
    return { kind: 'module-decl', name, params, body, span: this.spanTo(start) };
  }

  private parseFunctionDecl(): Statement {
    const start = this.current.span;
    this.expect(T.Keyword, 'function');
    const name = this.expect(T.Identifier).text;
    this.expect(T.Punct, '(');
    const params = this.parseParameters();
    this.expect(T.Punct, ')');
    this.expect(T.Punct, '=');
    const body = this.parseExpr();
    this.expectSemicolon();
    return { kind: 'function-decl', name, params, body, span: this.spanTo(start) };
  }

  private parseIf(start: SourceSpan, roles: string[]): Statement {
    this.expect(T.Keyword, 'if');
    this.expect(T.Punct, '(');
    const condition = this.parseExpr();
    this.expect(T.Punct, ')');
    const then = this.parseStatement() ?? { kind: 'empty' as const, span: this.current.span };
    let elseBranch: Statement | undefined;
    if (this.eat(T.Keyword, 'else')) {
      elseBranch = this.parseStatement();
    }
    return { kind: 'if', condition, then, else: elseBranch, roles, span: this.spanTo(start) };
  }

  private parseFor(start: SourceSpan, roles: string[], intersection: boolean): Statement {
    this.next(); // `for` / `intersection_for`
    this.expect(T.Punct, '(');

    // Distinguish `for (i = [0:5])` from the C-style `for (i = 0; i < 5; i = i+1)`
    // by looking for a `;` at depth 0 before the closing paren.
    if (!intersection && this.hasSemicolonBeforeCloseParen()) {
      const init = this.parseAssignmentList(';');
      this.expect(T.Punct, ';');
      const condition = this.parseExpr();
      this.expect(T.Punct, ';');
      const update = this.parseAssignmentList(')');
      this.expect(T.Punct, ')');
      const body = this.parseStatement() ?? { kind: 'empty' as const, span: this.current.span };
      return { kind: 'for-c', init, condition, update, body, roles, span: this.spanTo(start) };
    }

    const clauses = this.parseForClauses();
    this.expect(T.Punct, ')');
    const body = this.parseStatement() ?? { kind: 'empty' as const, span: this.current.span };
    return intersection
      ? { kind: 'intersection-for', clauses, body, roles, span: this.spanTo(start) }
      : { kind: 'for', clauses, body, roles, span: this.spanTo(start) };
  }

  private hasSemicolonBeforeCloseParen(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.kind !== T.Punct) continue;
      if (tok.text === '(' || tok.text === '[' || tok.text === '{') depth++;
      else if (tok.text === ')' || tok.text === ']' || tok.text === '}') {
        if (tok.text === ')' && depth === 0) return false;
        depth--;
      } else if (tok.text === ';' && depth === 0) return true;
    }
    return false;
  }

  private parseLetStatement(start: SourceSpan, roles: string[]): Statement {
    this.expect(T.Keyword, 'let');
    this.expect(T.Punct, '(');
    const bindings = this.parseAssignmentList(')');
    this.expect(T.Punct, ')');
    const body = this.parseStatement() ?? { kind: 'empty' as const, span: this.current.span };
    return { kind: 'let-stmt', bindings, body, roles, span: this.spanTo(start) };
  }

  private parseForClauses(): ForClause[] {
    const clauses: ForClause[] = [];
    if (this.atPunct(')')) return clauses;
    do {
      const start = this.current.span;
      const name = this.expect(T.Identifier).text;
      this.expect(T.Punct, '=');
      const value = this.parseExpr();
      clauses.push({ name, value, span: this.spanTo(start) });
    } while (this.eat(T.Punct, ','));
    return clauses;
  }

  private parseAssignmentList(terminator: string): Assignment[] {
    const list: Assignment[] = [];
    if (this.atPunct(terminator)) return list;
    do {
      if (this.atPunct(terminator)) break; // tolerate a trailing comma
      const start = this.current.span;
      const name = this.expect(T.Identifier).text;
      this.expect(T.Punct, '=');
      const value = this.parseExpr();
      list.push({ kind: 'assignment', name, value, span: this.spanTo(start) });
    } while (this.eat(T.Punct, ','));
    return list;
  }

  private parseParameters(): Parameter[] {
    const params: Parameter[] = [];
    if (this.atPunct(')')) return params;
    do {
      if (this.atPunct(')')) break; // trailing comma
      const start = this.current.span;
      const nameTok = this.eat(T.Identifier);
      if (!nameTok) {
        this.error(
          `Expected a parameter name but found \`${this.current.text}\`.`,
          this.current.span,
          'parse.expected-parameter',
        );
        throw new ParseAbort();
      }
      let def: Expr | undefined;
      if (this.eat(T.Punct, '=')) def = this.parseExpr();
      params.push({ name: nameTok.text, default: def, span: this.spanTo(start) });
    } while (this.eat(T.Punct, ','));
    return params;
  }

  private parseArguments(): Argument[] {
    const args: Argument[] = [];
    if (this.atPunct(')')) return args;
    let seenNamed = false;
    do {
      if (this.atPunct(')')) break; // trailing comma
      const start = this.current.span;
      if (
        (this.current.kind === T.Identifier || this.isSpecialVarToken(this.current)) &&
        this.peek(1).kind === T.Punct &&
        this.peek(1).text === '='
      ) {
        const name = this.next().text;
        this.next(); // '='
        const value = this.parseExpr();
        seenNamed = true;
        args.push({ name, value, span: this.spanTo(start) });
      } else {
        const value = this.parseExpr();
        if (seenNamed) {
          this.warn(
            'Positional argument after a named argument; OpenSCAD assigns it to the next unfilled parameter.',
            this.spanTo(start),
            'parse.positional-after-named',
          );
        }
        args.push({ value, span: this.spanTo(start) });
      }
    } while (this.eat(T.Punct, ','));
    return args;
  }

  // -- expressions ----------------------------------------------------------

  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const condition = this.parseBinary(0);
    if (!this.atPunct('?')) return condition;
    this.next();
    const then = this.parseTernary();
    this.expect(T.Punct, ':');
    const otherwise = this.parseTernary();
    return {
      kind: 'ternary',
      condition,
      then,
      else: otherwise,
      span: mergeSpans(condition.span, otherwise.span)!,
    };
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.current;
      if (tok.kind !== T.Punct) break;
      const precedence = BINARY_PRECEDENCE[tok.text];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const right = this.parseBinary(precedence + 1);
      left = {
        kind: 'binary',
        op: tok.text as never,
        left,
        right,
        span: mergeSpans(left.span, right.span)!,
      };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.atPunct('-', '+', '!')) {
      const opTok = this.next();
      const operand = this.parseUnary();
      return {
        kind: 'unary',
        op: opTok.text as '-' | '+' | '!',
        operand,
        span: mergeSpans(opTok.span, operand.span)!,
      };
    }
    return this.parsePower();
  }

  /**
   * `power := postfix ('^' unary)?`
   *
   * Right-associative, and its right operand is a *unary* expression so that
   * `2 ^ -3` parses. Sitting below `parseUnary` is what makes `^` bind tighter
   * than a leading minus.
   */
  private parsePower(): Expr {
    const base = this.parsePostfix();
    if (!this.atPunct('^')) return base;
    this.next();
    const exponent = this.parseUnary();
    return {
      kind: 'binary',
      op: '^',
      left: base,
      right: exponent,
      span: mergeSpans(base.span, exponent.span)!,
    };
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atPunct('[')) {
        const open = this.next();
        const index = this.parseExpr();
        const close = this.expect(T.Punct, ']');
        expr = { kind: 'index', target: expr, index, span: mergeSpans(expr.span, close.span) ?? open.span };
      } else if (this.atPunct('.')) {
        this.next();
        const prop = this.expect(T.Identifier);
        if (!['x', 'y', 'z'].includes(prop.text)) {
          this.warn(
            `\`.${prop.text}\` is not a valid vector component; only \`.x\`, \`.y\` and \`.z\` are defined.`,
            prop.span,
            'parse.unknown-member',
          );
        }
        expr = {
          kind: 'member',
          target: expr,
          property: prop.text,
          span: mergeSpans(expr.span, prop.span)!,
        };
      } else if (this.atPunct('(')) {
        this.next();
        const args = this.parseArguments();
        const close = this.expect(T.Punct, ')');
        expr = { kind: 'call', callee: expr, args, span: mergeSpans(expr.span, close.span)! };
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const tok = this.current;

    if (tok.kind === T.Number) {
      this.next();
      return { kind: 'number', value: tok.value ?? 0, span: tok.span };
    }
    if (tok.kind === T.String) {
      this.next();
      return { kind: 'string', value: tok.text, span: tok.span };
    }
    if (tok.kind === T.Keyword) {
      switch (tok.text) {
        case 'true':
          this.next();
          return { kind: 'bool', value: true, span: tok.span };
        case 'false':
          this.next();
          return { kind: 'bool', value: false, span: tok.span };
        case 'undef':
          this.next();
          return { kind: 'undef', span: tok.span };
        case 'let':
          return this.parseLetExpr();
        case 'function':
          return this.parseLambda();
        default:
          break;
      }
    }
    if (tok.kind === T.Identifier) {
      if (tok.text === 'assert' && this.peek(1).kind === T.Punct && this.peek(1).text === '(') {
        return this.parseAssertOrEchoExpr('assert');
      }
      if (tok.text === 'echo' && this.peek(1).kind === T.Punct && this.peek(1).text === '(') {
        return this.parseAssertOrEchoExpr('echo');
      }
      this.next();
      return { kind: 'identifier', name: tok.text, span: tok.span };
    }
    if (this.atPunct('(')) {
      this.next();
      const inner = this.parseExpr();
      this.expect(T.Punct, ')');
      return inner;
    }
    if (this.atPunct('[')) {
      return this.parseListOrRange();
    }

    this.error(`Expected an expression but found \`${tok.text}\`.`, tok.span, 'parse.expected-expression');
    throw new ParseAbort();
  }

  private parseLetExpr(): Expr {
    const start = this.current.span;
    this.expect(T.Keyword, 'let');
    this.expect(T.Punct, '(');
    const bindings = this.parseAssignmentList(')');
    this.expect(T.Punct, ')');
    const body = this.parseExpr();
    return { kind: 'let', bindings, body, span: mergeSpans(start, body.span)! };
  }

  private parseLambda(): Expr {
    const start = this.current.span;
    this.expect(T.Keyword, 'function');
    this.expect(T.Punct, '(');
    const params = this.parseParameters();
    this.expect(T.Punct, ')');
    const body = this.parseExpr();
    return { kind: 'lambda', params, body, span: mergeSpans(start, body.span)! };
  }

  private parseAssertOrEchoExpr(which: 'assert' | 'echo'): Expr {
    const start = this.current.span;
    this.next();
    this.expect(T.Punct, '(');
    const args = this.parseArguments();
    const close = this.expect(T.Punct, ')');
    // `assert(c) expr` has a body; `assert(c)` alone (inside a list, say) does not.
    const body = this.startsExpression() ? this.parseExpr() : undefined;
    const span = mergeSpans(start, body?.span ?? close.span)!;
    return which === 'assert'
      ? { kind: 'assert-expr', args, body, span }
      : { kind: 'echo-expr', args, body, span };
  }

  /** Whether the current token could begin an expression. */
  private startsExpression(): boolean {
    const tok = this.current;
    if (tok.kind === T.Number || tok.kind === T.String || tok.kind === T.Identifier) return true;
    if (tok.kind === T.Keyword) {
      return ['true', 'false', 'undef', 'let', 'function'].includes(tok.text);
    }
    if (tok.kind === T.Punct) return ['(', '[', '-', '+', '!'].includes(tok.text);
    return false;
  }

  private parseListOrRange(): Expr {
    const open = this.expect(T.Punct, '[');

    if (this.atPunct(']')) {
      const close = this.next();
      return { kind: 'list', elements: [], span: mergeSpans(open.span, close.span)! };
    }

    const first = this.parseListElement();

    // `[a : b]` / `[a : b : c]` — ranges only ever contain plain items.
    if (this.atPunct(':') && first.kind === 'item') {
      this.next();
      const second = this.parseExpr();
      let third: Expr | undefined;
      if (this.eat(T.Punct, ':')) third = this.parseExpr();
      const close = this.expect(T.Punct, ']');
      return third
        ? { kind: 'range', start: first.value, step: second, end: third, span: mergeSpans(open.span, close.span)! }
        : { kind: 'range', start: first.value, end: second, span: mergeSpans(open.span, close.span)! };
    }

    const elements: ListElement[] = [first];
    while (this.eat(T.Punct, ',')) {
      if (this.atPunct(']')) break; // trailing comma
      elements.push(this.parseListElement());
    }
    const close = this.expect(T.Punct, ']');
    return { kind: 'list', elements, span: mergeSpans(open.span, close.span)! };
  }

  /** A list element: a plain expression or one of the comprehension forms. */
  private parseListElement(): ListElement {
    const start = this.current.span;

    if (this.at(T.Keyword, 'each')) {
      this.next();
      const value = this.parseExpr();
      return { kind: 'each', value, span: this.spanTo(start) };
    }

    if (this.at(T.Keyword, 'for')) {
      this.next();
      this.expect(T.Punct, '(');
      if (this.hasSemicolonBeforeCloseParen()) {
        const init = this.parseAssignmentList(';');
        this.expect(T.Punct, ';');
        const condition = this.parseExpr();
        this.expect(T.Punct, ';');
        const update = this.parseAssignmentList(')');
        this.expect(T.Punct, ')');
        const body = this.parseListElement();
        return { kind: 'comp-for-c', init, condition, update, body, span: this.spanTo(start) };
      }
      const clauses = this.parseForClauses();
      this.expect(T.Punct, ')');
      const body = this.parseListElement();
      return { kind: 'comp-for', clauses, body, span: this.spanTo(start) };
    }

    if (this.at(T.Keyword, 'if')) {
      this.next();
      this.expect(T.Punct, '(');
      const condition = this.parseExpr();
      this.expect(T.Punct, ')');
      const then = this.parseListElement();
      let otherwise: ListElement | undefined;
      if (this.eat(T.Keyword, 'else')) otherwise = this.parseListElement();
      return { kind: 'comp-if', condition, then, else: otherwise, span: this.spanTo(start) };
    }

    // `let (...)` inside a comprehension binds for the element that follows,
    // which is subtly different from the `let` *expression* handled in
    // parsePrimary: the body here may itself be a comprehension form.
    if (this.at(T.Keyword, 'let') && this.isComprehensionLet()) {
      this.next();
      this.expect(T.Punct, '(');
      const bindings = this.parseAssignmentList(')');
      this.expect(T.Punct, ')');
      const body = this.parseListElement();
      return { kind: 'comp-let', bindings, body, span: this.spanTo(start) };
    }

    return { kind: 'item', value: this.parseExpr() };
  }

  /**
   * `let (...)` starts a comprehension-let only when what follows the closing
   * paren is itself a comprehension keyword; otherwise it is a let expression.
   */
  private isComprehensionLet(): boolean {
    let depth = 0;
    for (let i = this.pos + 1; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.kind !== T.Punct) continue;
      if (tok.text === '(') depth++;
      else if (tok.text === ')') {
        depth--;
        if (depth === 0) {
          const after = this.tokens[i + 1];
          return (
            after?.kind === T.Keyword && ['for', 'if', 'each', 'let'].includes(after.text)
          );
        }
      }
    }
    return false;
  }
}

export function parse(source: string, file = '<input>'): ParseResult {
  const lexed = lex(source, file);
  const parser = new Parser(lexed.tokens, file);
  const ast = parser.parseFile();
  return {
    file: ast,
    diagnostics: [...lexed.diagnostics, ...parser.diagnostics],
    lineComments: lexed.lineComments,
    blockComments: lexed.blockComments,
  };
}
