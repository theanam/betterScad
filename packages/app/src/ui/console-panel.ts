/**
 * Console / log panel (spec feature 15).
 *
 * Shows `echo()` output, warnings, errors and render stats. Entries with a
 * source span are clickable and jump the editor to the offending line, which is
 * half of what makes inline error reporting useful (spec feature 13).
 */

import type { Diagnostic, ExtensionUse } from '@betterscad/engine';
import type { RenderStats } from '../render/protocol.js';
import { button, clear, el, formatDuration, formatNumber } from './dom.js';
import { extensionList } from './extension-list.js';

export interface ConsoleEntry {
  severity: 'error' | 'warning' | 'info' | 'echo';
  message: string;
  line?: number;
  column?: number;
  file?: string;
}

const ICON: Record<ConsoleEntry['severity'], string> = {
  error: '✕',
  warning: '!',
  info: 'i',
  echo: '›',
};

type Filter = 'all' | 'problems' | 'info';

/** How many app notices are kept before the oldest is dropped. */
const MAX_NOTICES = 20;

export class ConsolePanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly tabs: Record<Filter, HTMLButtonElement>;
  private readonly problemCount: HTMLElement;
  private readonly extensionCount: HTMLElement;
  private entries: ConsoleEntry[] = [];
  /** App notices, which outlive the render they usually trigger. */
  private notices: ConsoleEntry[] = [];
  private extensions: ExtensionUse[] = [];
  private hasDocument = false;
  private filter: Filter = 'all';

  constructor(
    private readonly onJump: (line: number, column: number) => void,
    /** Opens the downgrade preview, from the Info tab's link. */
    private readonly onPreviewDowngrade: () => void,
  ) {
    this.list = el('ul', { class: 'console__list' });
    this.problemCount = el('span', { class: 'paneltab__count', hidden: true });
    this.extensionCount = el('span', { class: 'paneltab__count', hidden: true });

    // Tabs rather than a filter toggle: "Problems" is a destination people go
    // looking for, and a count on it answers the question from across the room.
    const tab = (filter: Filter, label: string, extra?: Node): HTMLButtonElement => {
      const node = el('button', {
        class: 'paneltab',
        type: 'button',
        role: 'tab',
        'aria-selected': filter === this.filter,
        onclick: () => this.setFilter(filter),
      }) as HTMLButtonElement;
      node.append(el('span', { text: label }));
      if (extra) node.append(extra);
      return node;
    };

    this.tabs = {
      all: tab('all', 'Console'),
      problems: tab('problems', 'Problems', this.problemCount),
      info: tab('info', 'Info', this.extensionCount),
    };

    this.clearButton = button({ label: 'Clear', title: 'Clear the console', onClick: () => this.clear() });

    this.element = el('div', { class: 'panel' }, [
      el('div', { class: 'panel__header panel__header--tabs' }, [
        el('div', { class: 'paneltabs', role: 'tablist' }, [
          this.tabs.all,
          this.tabs.problems,
          this.tabs.info,
        ]),
        el('span', { class: 'toolbar__spacer' }),
        this.clearButton,
      ]),
      el('div', { class: 'panel__body' }, [this.list]),
    ]);
  }

  /**
   * What this file is, as opposed to what this render said.
   *
   * Kept out of the log because it is a property of the source rather than an
   * event: it does not belong in a stream that the next render replaces.
   */
  setExtensions(extensions: ExtensionUse[], hasDocument: boolean): void {
    this.extensions = extensions;
    this.hasDocument = hasDocument;
    this.render();
  }

  private setFilter(filter: Filter): void {
    if (this.filter === filter) return;
    this.filter = filter;
    this.render();
  }

  /** Replaces the log with the results of one render. */
  setDiagnostics(diagnostics: Diagnostic[], stats?: RenderStats): void {
    // Notices first, and kept: a line like "Downloading the font Lobster" is
    // followed immediately by the re-render it caused, and wiping it there
    // would erase the only explanation of why the model just changed.
    this.entries = [...this.notices];
    this.entries.push(...diagnostics.map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.span?.start.line,
      column: d.span?.start.column,
      file: d.span?.file,
    })));

    if (stats) {
      this.entries.push({
        severity: 'info',
        message:
          `Rendered in ${formatDuration(stats.totalMs)} ` +
          `(parse ${formatDuration(stats.parseMs)}, evaluate ${formatDuration(stats.evaluateMs)}, ` +
          `geometry ${formatDuration(stats.geometryMs)}) · ` +
          `${stats.triangles.toLocaleString()} triangles · ` +
          `${stats.vertices.toLocaleString()} vertices` +
          (stats.volume > 0 ? ` · volume ${formatNumber(stats.volume)} mm³` : ''),
      });
    }
    this.render();
  }

  /**
   * A line from the app rather than from a render.
   *
   * Kept across renders, and capped: these arrive a handful at a time and only
   * when something happened that the reader did not ask for directly.
   */
  append(entry: ConsoleEntry): void {
    this.notices.push(entry);
    if (this.notices.length > MAX_NOTICES) this.notices.shift();
    this.entries.push(entry);
    this.render();
  }

  clear(): void {
    this.entries = [];
    this.notices = [];
    this.render();
  }

  /**
   * The Info tab: what the open file uses that stock OpenSCAD does not.
   *
   * Says so either way. "This file is stock OpenSCAD" is worth reading — it is
   * the answer to the same question, and a tab that is only ever populated when
   * something is wrong teaches people not to look at it.
   */
  private renderInfo(): void {
    if (!this.hasDocument) {
      this.list.appendChild(el('li', { class: 'panel__empty', text: 'No file open.' }));
      return;
    }

    if (this.extensions.length === 0) {
      this.list.appendChild(
        el('li', { class: 'infoview' }, [
          el('p', { class: 'infoview__lead', text: 'This file is stock OpenSCAD.' }),
          el('p', {
            class: 'infoview__body',
            text: 'It uses nothing BetterSCAD adds, so saving it as .scad writes it out unchanged.',
          }),
        ]),
      );
      return;
    }

    const count = this.extensions.length;
    const item = el('li', { class: 'infoview' }, [
      el('p', { class: 'infoview__lead' }, [
        el('span', { class: 'infoview__badge', text: 'EXT' }),
        el('span', {
          text: `This file uses ${count} BetterSCAD extension${count === 1 ? '' : 's'}, rewritten when you save as OpenSCAD .scad.`,
        }),
      ]),
      extensionList(this.extensions),
    ]);

    item.appendChild(
      el('button', {
        class: 'infoview__link',
        type: 'button',
        text: 'Preview downgrade',
        onclick: () => this.onPreviewDowngrade(),
      }),
    );
    this.list.appendChild(item);
  }

  get counts(): { errors: number; warnings: number } {
    return {
      errors: this.entries.filter((e) => e.severity === 'error').length,
      warnings: this.entries.filter((e) => e.severity === 'warning').length,
    };
  }

  private render(): void {
    clear(this.list);

    const { errors, warnings } = this.counts;
    const problems = errors + warnings;
    this.problemCount.textContent = String(problems);
    this.problemCount.hidden = problems === 0;
    this.problemCount.classList.toggle('paneltab__count--error', errors > 0);

    this.extensionCount.textContent = String(this.extensions.length);
    this.extensionCount.hidden = this.extensions.length === 0;

    for (const [name, node] of Object.entries(this.tabs)) {
      node.setAttribute('aria-selected', String(name === this.filter));
    }

    // Clearing a log makes sense; clearing a description of the file does not.
    this.clearButton.hidden = this.filter === 'info';

    if (this.filter === 'info') {
      this.renderInfo();
      return;
    }

    const visible =
      this.filter === 'problems'
        ? this.entries.filter((e) => e.severity === 'error' || e.severity === 'warning')
        : this.entries;

    if (visible.length === 0) {
      this.list.appendChild(
        el('li', {
          class: 'panel__empty',
          text: this.filter === 'problems' ? 'No errors or warnings.' : 'No output yet.',
        }),
      );
      return;
    }

    for (const entry of visible) {
      const clickable = entry.line !== undefined;
      const item = el(
        'li',
        {
          class: `log log--${entry.severity}${clickable ? ' log--clickable' : ''}`,
          ...(clickable
            ? {
                role: 'button',
                tabindex: '0',
                onclick: () => this.onJump(entry.line!, entry.column ?? 1),
                onkeydown: ((event: KeyboardEvent) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.onJump(entry.line!, entry.column ?? 1);
                  }
                }) as EventListener,
              }
            : {}),
        },
        [
          el('span', { class: 'log__icon', text: ICON[entry.severity] }),
          el('span', {}, [
            document.createTextNode(entry.message),
            clickable
              ? el('span', {
                  class: 'log__where',
                  text: `  ${entry.file && entry.file !== 'main.scad' ? `${entry.file}:` : 'line '}${entry.line}`,
                })
              : null,
          ]),
        ],
      );
      this.list.appendChild(item);
    }

    // Keep the newest output visible, which is what a log panel is for.
    this.list.parentElement?.scrollTo({ top: this.list.scrollHeight });
  }
}
