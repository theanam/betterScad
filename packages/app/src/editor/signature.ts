/**
 * Knowing which call the cursor is inside, and what that call takes.
 *
 * Autocomplete answers "what can I write here" only while you are writing the
 * *name*. The moment you type `(` it has nothing more to say, which is the
 * wrong way round for this language: OpenSCAD arguments are named and unordered,
 * so the useful question is not "what comes next" but "what else is there" —
 * and it is asked halfway through a call, not at the start of one.
 *
 * Two things are built on this file. A tooltip that keeps the signature on
 * screen while you are inside the brackets, and a completion source that offers
 * the parameters you have not used yet.
 *
 * Parameter names come from the engine's own tables rather than being written
 * out again here. `BUILTIN_MODULES` and `BUILTIN_FUNCTIONS` are what the
 * interpreter actually reads arguments from, so a suggestion cannot name a
 * parameter the interpreter would ignore.
 */

import { BUILTIN_FUNCTIONS, BUILTIN_MODULES } from '@betterscad/engine';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';

/** Characters that can sit inside a name. */
const WORD = /[A-Za-z0-9_$]/;

/**
 * `$fn`, `$fa` and `$fs` are legal on any module call.
 *
 * They are `$`-variables rather than declared parameters, so no table lists
 * them, but they are dynamically scoped into the children — which is exactly
 * how `cylinder(h = 10, d = 5, $fn = 64)` works. Offered on every module for
 * that reason, and ranked last because most calls do not want them.
 */
const RESOLUTION_PARAMS = ['$fn', '$fa', '$fs'];

export interface CallSite {
  /** The name being called. Empty for a plain parenthesised group. */
  name: string;
  /** Offset of the `(`. */
  open: number;
  /** Zero-based index of the argument the cursor is in. */
  argument: number;
  /** Parameters already given by name, so they are not offered twice. */
  named: string[];
  /**
   * True when the cursor is where a fresh argument begins — just after the
   * `(` or a `,`, with at most a partial name typed.
   *
   * This is what separates "I am choosing a parameter" from "I am writing a
   * value", and only the first should be answered with parameter names.
   */
  atArgumentStart: boolean;
  /** The parameter this argument names, when it has been written already. */
  current?: string;
}

interface Frame {
  bracket: '(' | '[' | '{';
  name: string;
  open: number;
  argument: number;
  named: string[];
  /** Offset just past the `(` or the most recent `,`. */
  argFrom: number;
}

/** The name ending at `end`, if the text there ends with one. */
function nameBefore(text: string, end: number): { name: string; from: number } {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  const to = i;
  while (i > 0 && WORD.test(text[i - 1])) i--;
  return { name: text.slice(i, to), from: i };
}

/**
 * The innermost call the cursor sits inside.
 *
 * Scanned forward from the start of the document rather than backwards from the
 * cursor. Backwards is tempting and cheaper, but it cannot tell a `(` in a
 * string or a comment from a real one without having read the text before it —
 * and a stray bracket in a comment would otherwise capture every call below it.
 */
export function callAt(text: string, pos: number): CallSite | undefined {
  const stack: Frame[] = [];
  let i = 0;

  while (i < pos) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '/') {
      while (i < pos && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < pos && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < pos && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      const { name } = c === '(' ? nameBefore(text, i) : { name: '' };
      stack.push({ bracket: c, name, open: i, argument: 0, named: [], argFrom: i + 1 });
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      i++;
      continue;
    }

    const top = stack[stack.length - 1];
    if (top?.bracket === '(') {
      if (c === ',') {
        top.argument++;
        top.argFrom = i + 1;
      } else if (c === '=' && text[i + 1] !== '=' && !'=<>!'.includes(text[i - 1] ?? '')) {
        // `name =` supplies a parameter. `==`, `<=`, `>=` and `!=` do not.
        const { name } = nameBefore(text, i);
        if (name) top.named.push(name);
      }
    }
    i++;
  }

  const frame = stack[stack.length - 1];
  if (!frame || frame.bracket !== '(') return undefined;

  const written = text.slice(frame.argFrom, pos);
  const assigned = /^\s*([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(written);
  return {
    name: frame.name,
    open: frame.open,
    argument: frame.argument,
    named: frame.named,
    // Nothing yet, or a bare partial name: still choosing what to write.
    atArgumentStart: /^\s*[A-Za-z_$][\w$]*$|^\s*$/.test(written),
    current: assigned?.[1],
  };
}

/** One parameter, and what it falls back to when it is left out. */
export interface Param {
  name: string;
  /** Source text, exactly as you would type it. Absent when it is required. */
  default?: string;
}

export interface Signature {
  name: string;
  params: Param[];
  kind: 'module' | 'function' | 'user module' | 'user function';
}

/**
 * Splits a parameter list on the commas that separate parameters.
 *
 * Not `split(',')`: a default can contain commas of its own — `size = [40, 20]`
 * is one parameter, not two — so only the commas at the top level count.
 */
function splitParams(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The text between a `(` at `open` and its matching `)`. */
function bracketed(source: string, open: number): string | undefined {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return undefined;
}

/** Parameters declared by a `module` or `function` in the document. */
function userSignature(name: string, source: string): Signature | undefined {
  // Regex to find the declaration, for the same reason the symbol list uses
  // one: this runs while the file is half-typed, and a parse of a broken file
  // is both slower and noisier than a scan that simply finds nothing. The
  // parameter list itself is then read by bracket matching, because a default
  // may contain brackets the regex could not have counted.
  const escaped = name.replace(/[$]/g, '\\$&');
  const declaration = new RegExp(`\\b(module|function)\\s+${escaped}\\s*\\(`);
  const found = declaration.exec(source);
  if (!found) return undefined;

  const list = bracketed(source, found.index + found[0].length - 1);
  if (list === undefined) return undefined;

  const params: Param[] = [];
  for (const part of splitParams(list)) {
    const at = part.indexOf('=');
    const paramName = (at < 0 ? part : part.slice(0, at)).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(paramName)) continue;
    // Whatever was written after the `=` is the default, verbatim.
    const fallback = at < 0 ? '' : part.slice(at + 1).trim();
    params.push(fallback ? { name: paramName, default: fallback } : { name: paramName });
  }
  return { name, params, kind: found[1] === 'module' ? 'user module' : 'user function' };
}

/** What a call takes, from the engine first and the document second. */
export function signatureFor(name: string, source: string): Signature | undefined {
  if (!name) return undefined;
  // A module of the user's own shadows the builtin of the same name, which is
  // what the interpreter does too.
  const user = userSignature(name, source);
  if (user) return user;

  type Builtin = { params: string[]; defaults?: Record<string, string> };
  const withDefaults = (names: string[], defaults: Record<string, string> = {}): Param[] =>
    names.map((param) => (defaults[param] ? { name: param, default: defaults[param] } : { name: param }));

  const builtinModule = (BUILTIN_MODULES as Record<string, Builtin>)[name];
  if (builtinModule) {
    return {
      name,
      params: withDefaults([...builtinModule.params, ...RESOLUTION_PARAMS], builtinModule.defaults),
      kind: 'module',
    };
  }
  const builtinFunction = (BUILTIN_FUNCTIONS as Record<string, Builtin>)[name];
  if (builtinFunction) {
    return { name, params: withDefaults(builtinFunction.params, builtinFunction.defaults), kind: 'function' };
  }
  return undefined;
}

/** The signature and the call site, when the cursor is inside a known call. */
export function signatureAt(
  source: string,
  pos: number,
): { call: CallSite; signature: Signature } | undefined {
  const call = callAt(source, pos);
  if (!call) return undefined;
  const signature = signatureFor(call.name, source);
  return signature ? { call, signature } : undefined;
}

/**
 * Which parameter the signature should point at.
 *
 * By name when the argument names one, because named arguments are unordered
 * and the position means nothing. By position otherwise.
 */
export function activeParam(call: CallSite, signature: Signature): number {
  if (call.current) {
    const named = signature.params.findIndex((param) => param.name === call.current);
    if (named >= 0) return named;
  }
  if (call.named.length > 0 && call.atArgumentStart) return -1;
  return call.argument < signature.params.length ? call.argument : -1;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * The parameters of the call the cursor is inside, minus the ones already
 * given.
 *
 * Its own completion source rather than something the builtin list reaches for,
 * because the two answer different questions and share nothing: this one knows
 * where the cursor is, that one knows what the language has.
 *
 * The suggestions outrank everything else. At the start of an argument they are
 * almost always what is wanted, and the alternative — every global name in the
 * language — is what the editor unhelpfully offered before. `$fn` and friends
 * sort just below the declared parameters: legal everywhere, wanted rarely.
 */
export function parameterCompletions(context: CompletionContext): CompletionResult | null {
  const found = signatureAt(context.state.doc.toString(), context.pos);
  if (!found || !found.call.atArgumentStart) return null;

  const { call, signature } = found;
  const options: Completion[] = signature.params
    .filter((param) => !call.named.includes(param.name))
    .map((param, index) => ({
      label: param.name,
      // The `= ` is the point: it is how an argument gets named at all.
      apply: `${param.name} = `,
      // Just "parameter": the signature sitting directly above the list already
      // says which call, and repeating it down a column reads as noise.
      detail: 'parameter',
      type: 'property',
      // Declared order, not the alphabetical one a flat boost would give — so
      // the list reads in the same order as the signature above it. `$fn` and
      // friends are last in `params`, so they land last here too.
      boost: 9 - index / 100,
    }));
  if (options.length === 0) return null;

  const word = context.matchBefore(/[A-Za-z_$][\w$]*/);
  return { from: word ? word.from : context.pos, options, validFor: /^[\w$]*$/ };
}

// ---------------------------------------------------------------------------
// The tooltip
// ---------------------------------------------------------------------------

function renderSignature(state: EditorState): Tooltip | null {
  const pos = state.selection.main.head;
  if (!state.selection.main.empty) return null;

  const found = signatureAt(state.doc.toString(), pos);
  if (!found) return null;
  const { call, signature } = found;
  const active = activeParam(call, signature);

  return {
    pos: call.open,
    above: true,
    // The signature belongs to the call, not to the character the cursor is on,
    // so it stays put while an argument is typed rather than crawling sideways.
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-signatureHelp';
      dom.append(Object.assign(document.createElement('span'), {
        className: 'cm-signatureHelp__name',
        textContent: signature.name,
      }));
      dom.append(document.createTextNode('('));
      signature.params.forEach((param, index) => {
        if (index > 0) dom.append(document.createTextNode(', '));
        const span = document.createElement('span');
        span.className =
          index === active
            ? 'cm-signatureHelp__param cm-signatureHelp__param--active'
            : call.named.includes(param.name)
              ? 'cm-signatureHelp__param cm-signatureHelp__param--used'
              : 'cm-signatureHelp__param';
        span.append(document.createTextNode(param.name));
        if (param.default !== undefined) {
          // Dimmer than the name: it answers "what happens if I leave this
          // out", which is a quieter question than "what is this called".
          span.append(Object.assign(document.createElement('span'), {
            className: 'cm-signatureHelp__default',
            textContent: ` = ${param.default}`,
          }));
        }
        dom.append(span);
      });
      dom.append(document.createTextNode(')'));
      return { dom };
    },
  };
}

const signatureField = StateField.define<Tooltip | null>({
  create: renderSignature,
  update: (value, tr) => (tr.docChanged || tr.selection ? renderSignature(tr.state) : value),
  provide: (field) => showTooltip.from(field),
});

export const signatureHelp = (): Extension => [signatureField, signatureTheme];

const signatureTheme = EditorView.baseTheme({
  '.cm-signatureHelp': {
    padding: '3px 8px',
    borderRadius: '4px',
    fontFamily: 'var(--bs-font-mono)',
    fontSize: '12px',
    // Signatures with every default spelled out get long, and a clipped one is
    // worse than a wrapped one.
    maxWidth: '640px',
  },
  '.cm-signatureHelp__name': { fontWeight: '600' },
  '.cm-signatureHelp__param': { opacity: '0.7' },
  // The one you are filling in, and the ones you already filled in.
  '.cm-signatureHelp__param--active': { opacity: '1', fontWeight: '600', textDecoration: 'underline' },
  '.cm-signatureHelp__param--used': { opacity: '0.35' },
  '.cm-signatureHelp__default': { opacity: '0.55', fontWeight: '400' },
});
