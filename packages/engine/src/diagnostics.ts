/**
 * Source positions, diagnostics and the error type shared by every engine stage.
 *
 * Everything user-visible (lexer, parser, evaluator, geometry) reports through
 * `Diagnostic` so the editor can surface problems inline (spec feature 13)
 * rather than dumping them to a console.
 */

export interface Position {
  /** 0-based byte offset into the source text. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

export interface SourceSpan {
  /** Logical file name; `include`/`use` produce spans from other files. */
  file: string;
  start: Position;
  end: Position;
}

export type Severity = 'error' | 'warning' | 'info' | 'echo';

export interface Diagnostic {
  severity: Severity;
  message: string;
  span?: SourceSpan;
  /** Stable identifier, e.g. `parse.unexpected-token`, used for tests and docs. */
  code?: string;
}

export function position(offset: number, line: number, column: number): Position {
  return { offset, line, column };
}

export function span(file: string, start: Position, end: Position): SourceSpan {
  return { file, start, end };
}

/** A span covering a single point, used when only one position is known. */
export function pointSpan(file: string, at: Position): SourceSpan {
  return { file, start: at, end: at };
}

export function mergeSpans(a: SourceSpan | undefined, b: SourceSpan | undefined): SourceSpan | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.file !== b.file) return a;
  return {
    file: a.file,
    start: a.start.offset <= b.start.offset ? a.start : b.start,
    end: a.end.offset >= b.end.offset ? a.end : b.end,
  };
}

/**
 * Thrown for problems that stop evaluation of the current construct.
 *
 * Most runtime problems in OpenSCAD are warnings that degrade to `undef`
 * instead; this is reserved for `assert()` failures, parse errors and genuinely
 * unrecoverable geometry states.
 */
export class ScadError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(message: string, span?: SourceSpan, code?: string) {
    super(message);
    this.name = 'ScadError';
    this.diagnostic = { severity: 'error', message, span, code };
  }
}

/** Collects diagnostics across a whole compile, de-duplicating identical repeats. */
export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  private seen = new Set<string>();
  private truncated = false;

  constructor(private readonly limit = 500) {}

  add(d: Diagnostic): void {
    if (this.items.length >= this.limit) {
      if (!this.truncated) {
        this.truncated = true;
        this.items.push({
          severity: 'warning',
          message: `Too many diagnostics; further messages suppressed (limit ${this.limit}).`,
          code: 'diagnostics.truncated',
        });
      }
      return;
    }
    // `echo` output is intentionally never de-duplicated: repeats are meaningful.
    if (d.severity !== 'echo') {
      const key = `${d.severity}:${d.code ?? ''}:${d.message}:${d.span?.start.offset ?? -1}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.items.push(d);
  }

  error(message: string, span?: SourceSpan, code?: string): void {
    this.add({ severity: 'error', message, span, code });
  }

  warn(message: string, span?: SourceSpan, code?: string): void {
    this.add({ severity: 'warning', message, span, code });
  }

  echo(message: string, span?: SourceSpan): void {
    this.add({ severity: 'echo', message, span });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}
