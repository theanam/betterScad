/**
 * The CodeMirror 6 editor (spec features 4, 12 and 13).
 *
 * Undo/redo comes from CodeMirror's own history, and inline diagnostics are
 * pushed in from the render pipeline rather than computed by a second parser
 * inside the editor.
 */

import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language';
import { Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';

import type { Diagnostic } from '@betterscad/engine';
import { openscad } from './scad-language.js';
import { scadCompletions } from './completions.js';

export interface EditorCallbacks {
  onChange(source: string): void;
  onCursor(line: number, column: number): void;
  /** F5 / F6 and the other render shortcuts are owned by the app, not the editor. */
  onShortcut(name: string): boolean;
}

/**
 * Theme.
 *
 * Everything resolves to brand tokens, so switching light/dark needs no
 * editor reconfiguration — the CSS variables change underneath it.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bs-surface)',
    color: 'var(--bs-text)',
  },
  '.cm-content': { caretColor: 'var(--bs-solid-500)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--bs-solid-500)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--bs-solid-500) 28%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bs-surface)',
    color: 'var(--bs-text-faint)',
    border: 'none',
    borderRight: '1px solid var(--bs-border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bs-surface-sunken)', color: 'var(--bs-text-muted)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bs-text) 4%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--bs-cut-300) 22%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--bs-cut-300) 30%, transparent)',
    outline: 'none',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bs-surface-raised)',
    border: '1px solid var(--bs-border)',
    borderRadius: 'var(--bs-radius)',
    boxShadow: 'var(--bs-shadow-2)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--bs-solid-500)',
    color: '#fff',
  },
  '.cm-completionInfo': {
    maxWidth: '340px',
    padding: '8px 10px',
    backgroundColor: 'var(--bs-surface-raised)',
    border: '1px solid var(--bs-border)',
    borderRadius: 'var(--bs-radius)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-panels': { backgroundColor: 'var(--bs-surface-sunken)', color: 'var(--bs-text)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--bs-solid-500) 30%, transparent)' },
  '.cm-lintRange-error': { backgroundImage: 'none', borderBottom: '2px wavy var(--bs-danger)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', borderBottom: '2px wavy var(--bs-warning)' },
});

export class ScadEditor {
  readonly view: EditorView;
  private readonly readOnly = new Compartment();
  private readonly extensions: Extension[];
  /** Set while `setSource` is replacing the document, to suppress onChange. */
  private applyingExternalEdit = false;

  constructor(parent: HTMLElement, initialSource: string, private readonly callbacks: EditorCallbacks) {
    const shortcutKeymap = [
      { key: 'F5', run: () => this.shortcut('preview'), preventDefault: true },
      { key: 'F6', run: () => this.shortcut('render'), preventDefault: true },
      { key: 'Mod-s', run: () => this.shortcut('save'), preventDefault: true },
      { key: 'Mod-Shift-s', run: () => this.shortcut('save-as'), preventDefault: true },
      { key: 'Mod-o', run: () => this.shortcut('open'), preventDefault: true },
      { key: 'Mod-e', run: () => this.shortcut('export'), preventDefault: true },
      { key: 'Mod-Shift-p', run: () => this.shortcut('palette'), preventDefault: true },
      { key: 'Mod-Enter', run: () => this.shortcut('render'), preventDefault: true },
    ];

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of('  '),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [scadCompletions], activateOnTyping: true, icons: true }),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      lintGutter(),
      // Shortcuts come first so F5 reaches the app instead of the browser.
      keymap.of([
        ...shortcutKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      openscad(),
      theme,
      EditorView.lineWrapping,
      this.readOnly.of(EditorState.readOnly.of(false)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.applyingExternalEdit) {
          this.callbacks.onChange(update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          this.callbacks.onCursor(line.number, head - line.from + 1);
        }
      }),
    ];

    this.extensions = extensions;
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: initialSource, extensions }),
    });
  }

  /** A fresh state for a document, with this editor's full extension set. */
  createState(source: string): EditorState {
    return EditorState.create({ doc: source, extensions: this.extensions });
  }

  private shortcut(name: string): boolean {
    return this.callbacks.onShortcut(name);
  }

  get source(): string {
    return this.view.state.doc.toString();
  }

  /**
   * Replaces the document's text in place, keeping undo history.
   *
   * Used when the same document's content changes underneath the editor —
   * reverting, or applying Customizer values back to the source.
   */
  setSource(source: string): void {
    if (source === this.source) return;
    this.applyingExternalEdit = true;
    try {
      const previousHead = this.view.state.selection.main.head;
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: source },
        selection: { anchor: Math.min(previousHead, source.length) },
      });
    } finally {
      this.applyingExternalEdit = false;
    }
  }

  /** The live editor state, so a tab can be stored and restored intact. */
  get state(): EditorState {
    return this.view.state;
  }

  /**
   * Swaps in another document's state (spec feature 12).
   *
   * Each tab owns an `EditorState`, so undo history, selection and scroll
   * position all survive switching away and back — and, crucially, Ctrl+Z in
   * one tab can never undo into another tab's content.
   */
  swapState(state: EditorState): void {
    this.applyingExternalEdit = true;
    try {
      this.view.setState(state);
    } finally {
      this.applyingExternalEdit = false;
    }
  }

  setDiagnostics(diagnostics: Diagnostic[]): void {
    const doc = this.view.state.doc;
    const mapped: CmDiagnostic[] = [];

    for (const d of diagnostics) {
      if (d.severity === 'echo' || d.severity === 'info') continue;
      if (!d.span) continue;
      // Includes report spans in other files; those cannot be shown inline here.
      if (d.span.file !== 'main.scad' && d.span.file !== '<input>' && mapped.length > 0) continue;

      const from = Math.max(0, Math.min(d.span.start.offset, doc.length));
      const to = Math.max(from, Math.min(d.span.end.offset, doc.length));
      mapped.push({
        from,
        // A zero-width range renders no squiggle, so widen it by one character.
        to: to === from ? Math.min(from + 1, doc.length) : to,
        severity: d.severity === 'error' ? 'error' : 'warning',
        message: d.message,
        source: d.code,
      });
    }

    this.view.dispatch(setDiagnostics(this.view.state, mapped));
  }

  /** Moves the cursor to a 1-based line/column and scrolls it into view. */
  goTo(line: number, column = 1): void {
    const doc = this.view.state.doc;
    const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const pos = Math.min(target.from + column - 1, target.to);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    this.view.focus();
  }

  /** Replaces a source range, used by the Customizer to write values back. */
  replaceRange(from: number, to: number, text: string): void {
    this.view.dispatch({ changes: { from, to, insert: text } });
  }

  undo(): void {
    undo(this.view);
  }

  redo(): void {
    redo(this.view);
  }

  focus(): void {
    this.view.focus();
  }

  setReadOnly(value: boolean): void {
    this.view.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(value)) });
  }

  destroy(): void {
    this.view.destroy();
  }
}
