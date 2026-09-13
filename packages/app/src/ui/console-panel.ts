/**
 * Console / log panel (spec feature 15).
 *
 * Shows `echo()` output, warnings, errors and render stats. Entries with a
 * source span are clickable and jump the editor to the offending line, which is
 * half of what makes inline error reporting useful (spec feature 13).
 */

import type { Diagnostic } from '@betterscad/engine';
import type { RenderStats } from '../render/protocol.js';
import { button, clear, el, formatDuration, formatNumber } from './dom.js';

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

export class ConsolePanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly countLabel: HTMLElement;
  private entries: ConsoleEntry[] = [];
  private filter: 'all' | 'problems' = 'all';

  constructor(private readonly onJump: (line: number, column: number) => void) {
    this.list = el('ul', { class: 'console__list' });
    this.countLabel = el('span', { text: '' });

    const filterButton = button({
      label: 'Problems only',
      title: 'Show only errors and warnings',
      onClick: () => {
        this.filter = this.filter === 'all' ? 'problems' : 'all';
        filterButton.classList.toggle('btn--active', this.filter === 'problems');
        this.render();
      },
    });

    this.element = el('div', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('span', { text: 'Console' }),
        this.countLabel,
        el('span', { class: 'toolbar__spacer' }),
        filterButton,
        button({ label: 'Clear', title: 'Clear the console', onClick: () => this.clear() }),
      ]),
      el('div', { class: 'panel__body' }, [this.list]),
    ]);
  }

  /** Replaces the log with the results of one render. */
  setDiagnostics(diagnostics: Diagnostic[], stats?: RenderStats): void {
    this.entries = diagnostics.map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.span?.start.line,
      column: d.span?.start.column,
      file: d.span?.file,
    }));

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

  append(entry: ConsoleEntry): void {
    this.entries.push(entry);
    this.render();
  }

  clear(): void {
    this.entries = [];
    this.render();
  }

  get counts(): { errors: number; warnings: number } {
    return {
      errors: this.entries.filter((e) => e.severity === 'error').length,
      warnings: this.entries.filter((e) => e.severity === 'warning').length,
    };
  }

  private render(): void {
    clear(this.list);

    const visible =
      this.filter === 'problems'
        ? this.entries.filter((e) => e.severity === 'error' || e.severity === 'warning')
        : this.entries;

    const { errors, warnings } = this.counts;
    this.countLabel.textContent =
      errors || warnings
        ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`
        : '';

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
