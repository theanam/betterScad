/**
 * Toolbar, tab strip, status bar, animation bar and toasts.
 *
 * These are thin views over state the app owns: each exposes an `update()`
 * that re-reads everything rather than trying to patch incrementally, which
 * for a handful of elements is both simpler and fast enough.
 */

import { button, clear, el, formatDuration, icon, splitButton, type MenuItem } from './dom.js';
import { setHint } from './tooltip.js';
import { formatShortcut } from './command-palette.js';
import type { Document, DocumentFormat } from '../state/workspace.js';
import type { RenderStats } from '../render/protocol.js';
import type { ExtensionUse } from '@betterscad/engine';

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

/**
 * A two-state switch: both icons visible, a thumb resting over the active one.
 *
 * Shared by the theme control and the grid toggle. A switch says "this has two
 * settings and one of them is current" in a way a highlighted button does not,
 * and it does so without needing a text label.
 */
export interface IconSwitchOptions {
  /** Icon for the "off" state, shown on the left. */
  offIcon: string;
  /** Icon for the "on" state, shown on the right. */
  onIcon: string;
  /** Stable accessible name, e.g. "Ground grid". */
  label: string;
  /** Hint text per state. */
  hint(on: boolean): string;
  onToggle(): void;
}

export class IconSwitch {
  readonly element: HTMLButtonElement;

  constructor(private readonly options: IconSwitchOptions) {
    const track = el('span', { class: 'iconswitch__track' });

    const off = icon(options.offIcon, 13);
    off.classList.add('iconswitch__icon', 'iconswitch__icon--off');
    const on = icon(options.onIcon, 13);
    on.classList.add('iconswitch__icon', 'iconswitch__icon--on');

    track.append(el('span', { class: 'iconswitch__thumb' }), off, on);

    // `role="switch"` gives assistive tech the right affordance; the label
    // names what is being switched, so "on" is not left to interpretation.
    this.element = el('button', {
      class: 'iconswitch',
      type: 'button',
      role: 'switch',
      'aria-checked': 'true',
      'aria-label': options.label,
      onclick: () => options.onToggle(),
    }) as HTMLButtonElement;
    this.element.appendChild(track);
    this.setState(true);
  }

  setState(on: boolean): void {
    this.element.setAttribute('aria-checked', String(on));
    setHint(this.element, this.options.hint(on));
    // `setHint` fills in a missing aria-label; keep the stable one instead.
    this.element.setAttribute('aria-label', this.options.label);
  }
}

/** The theme control: sun on the left, moon on the right. */
export class ThemeToggle {
  private readonly control: IconSwitch;
  readonly element: HTMLButtonElement;

  constructor(onToggle: () => void) {
    this.control = new IconSwitch({
      offIcon: 'sun',
      onIcon: 'moon',
      label: 'Dark theme',
      hint: (dark) => `Switch to ${dark ? 'light' : 'dark'} theme`,
      onToggle,
    });
    this.element = this.control.element;
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.control.setState(theme === 'dark');
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface ToolbarActions {
  newFile(): void;
  open(): void;
  save(): void;
  /** Save As. `format` forces the on-disk format; omitted keeps the current one. */
  saveAs(format?: DocumentFormat): void;
  /** Save as stock OpenSCAD, transpiling the extensions the file uses. */
  saveAsStockScad(): void;
  preview(): void;
  render(): void;
  export(): void;
  toggleCustomizer(): void;
  toggleConsole(): void;
  toggleTheme(): void;
  openPalette(): void;
  openFonts(): void;
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly customizerButton: HTMLButtonElement;
  private readonly consoleButton: HTMLButtonElement;
  private readonly previewButton: HTMLButtonElement;
  private readonly renderButton: HTMLButtonElement;
  private readonly themeToggle: ThemeToggle;

  /** Drives the Save menu; a `.scad` gets the extra "Save as .bscad" item. */
  private documentFormat: DocumentFormat = 'bscad';

  constructor(private readonly actions: ToolbarActions) {
    this.customizerButton = button({
      label: 'Customizer',
      iconName: 'sliders',
      onClick: () => this.actions.toggleCustomizer(),
    });
    this.consoleButton = button({
      label: 'Console',
      iconName: 'console',
      onClick: () => this.actions.toggleConsole(),
    });
    this.themeToggle = new ThemeToggle(() => actions.toggleTheme());
    this.previewButton = button({
      label: 'Preview',
      iconName: 'play',
      shortcut: 'F5',
      variant: 'ghost',
      title: 'Re-render with $preview = true',
      onClick: () => actions.preview(),
    });
    // Render carries the accent, not Preview: it is the one that produces the
    // geometry Export writes, and it is the end of the loop rather than a step
    // in it. Preview is also the button that hides itself under auto-render,
    // which is no place for the only primary action in the toolbar.
    this.renderButton = button({
      label: 'Render',
      iconName: 'render',
      shortcut: 'F6',
      variant: 'primary',
      title: 'Re-render with $preview = false — the geometry Export produces',
      onClick: () => actions.render(),
    });

    this.element = el('header', { class: 'toolbar', role: 'toolbar' }, [
      el('div', { class: 'toolbar__brand' }, [
        el('img', { src: './betterscad-mark.svg', width: '22', height: '22', alt: '' }),
        // One colour: an amber `SCAD` would spend the accent on decoration,
        // and the accent is reserved for state and action.
        el('span', { text: 'BetterSCAD' }),
      ]),
      el('div', { class: 'toolbar__group' }, [
        button({ label: 'New', iconName: 'plus', shortcut: formatShortcut('Mod+N'), onClick: () => actions.newFile() }),
        button({ label: 'Open', iconName: 'open', shortcut: formatShortcut('Mod+O'), onClick: () => actions.open() }),
        splitButton({
          label: 'Save',
          iconName: 'save',
          shortcut: formatShortcut('Mod+S'),
          onClick: () => actions.save(),
          menuLabel: 'More save options',
          items: () => this.saveMenuItems(),
        }),
      ]),
      el('div', { class: 'toolbar__divider' }),
      el('div', { class: 'toolbar__group' }, [
        this.previewButton,
        this.renderButton,
        button({ label: 'Export', iconName: 'download', shortcut: formatShortcut('Mod+E'), onClick: () => actions.export() }),
      ]),
      el('div', { class: 'toolbar__spacer' }),
      // A search field rather than a button: it names what the palette is for,
      // and it is the only affordance in the toolbar that a newcomer can use to
      // find the things the toolbar has no room for.
      el('button', {
        class: 'toolbar__search',
        type: 'button',
        title: 'Search or run a command',
        onclick: () => actions.openPalette(),
      }, [
        icon('search', 13),
        el('span', { class: 'toolbar__searchlabel', text: 'Search or run a command' }),
        el('span', { class: 'btn__key', text: formatShortcut('Mod+K') }),
      ]),
      el('div', { class: 'toolbar__group' }, [
        this.customizerButton,
        this.consoleButton,
        button({ label: 'Fonts', iconName: 'font', onClick: () => actions.openFonts() }),
        el('div', { class: 'toolbar__divider' }),
        this.themeToggle.element,
      ]),
    ]);
  }

  /**
   * The Save menu, rebuilt on every open.
   *
   * Every way of writing this document to disk lives here, so the question
   * "how do I get a plain .scad out of this?" has one answer and it is next to
   * Save. The stock-OpenSCAD item is listed whatever the document's extension
   * is: it is the only item that *guarantees* the result opens in OpenSCAD, and
   * a `.scad` file that uses extensions is exactly the case where the guarantee
   * is worth having and the file name does not give it away.
   */
  private saveMenuItems(): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Save as…',
        shortcut: formatShortcut('Mod+Shift+S'),
        onSelect: () => this.actions.saveAs(),
      },
    ];

    if (this.documentFormat === 'scad') {
      items.push({
        label: 'Save as .bscad…',
        description: 'Keeps presets, camera and panel layout in the file',
        onSelect: () => this.actions.saveAs('bscad'),
      });
    }

    items.push({
      label: 'Save as OpenSCAD .scad…',
      description: 'Rewrites BetterSCAD syntax, if the file uses any',
      onSelect: () => this.actions.saveAsStockScad(),
    });

    return items;
  }

  update(state: {
    customizerVisible: boolean;
    consoleVisible: boolean;
    theme: 'light' | 'dark';
    autoRender: boolean;
    showingFinalRender: boolean;
    documentFormat: DocumentFormat;
  }): void {
    this.documentFormat = state.documentFormat;

    this.customizerButton.classList.toggle('btn--active', state.customizerVisible);
    this.consoleButton.classList.toggle('btn--active', state.consoleVisible);

    // Auto-render already re-renders in preview mode on every edit, so the
    // Preview button would do exactly nothing. F5 still works — hiding a
    // button should not remove its shortcut.
    this.previewButton.hidden = state.autoRender;

    // Render is not redundant: it is the only way to see $preview = false,
    // which is what Export produces. Marking it active when that is what is on
    // screen is the difference between a useful button and a mystery one.
    this.renderButton.classList.toggle('btn--active', state.showingFinalRender);
    this.renderButton.title = state.showingFinalRender
      ? 'Showing the final render ($preview = false)'
      : 'Re-render with $preview = false — the geometry Export produces';

    this.setTheme(state.theme);
  }

  private setTheme(theme: 'light' | 'dark'): void {
    this.themeToggle.setTheme(theme);
  }
}

// ---------------------------------------------------------------------------
// Tabs (spec feature 12)
// ---------------------------------------------------------------------------

export class TabStrip {
  readonly element: HTMLElement;

  constructor(
    private readonly onSelect: (id: string) => void,
    private readonly onClose: (id: string) => void,
    private readonly onNew: () => void,
  ) {
    this.element = el('div', { class: 'tabs', role: 'tablist' });
  }

  update(documents: Document[], activeId: string, isDirty: (doc: Document) => boolean): void {
    clear(this.element);

    for (const doc of documents) {
      const active = doc.id === activeId;
      const dirty = isDirty(doc);

      const tab = el(
        'div',
        {
          class: `tab${active ? ' tab--active' : ''}`,
          role: 'tab',
          'aria-selected': active,
          tabindex: active ? '0' : '-1',
          title: doc.handle ? `${doc.name} — saved to disk` : doc.name,
          onclick: () => this.onSelect(doc.id),
          // Middle-click closes, matching every editor people already use.
          onauxclick: ((event: MouseEvent) => {
            if (event.button === 1) {
              event.preventDefault();
              this.onClose(doc.id);
            }
          }) as EventListener,
          onkeydown: ((event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              this.onSelect(doc.id);
            }
          }) as EventListener,
        },
        [
          el('span', { class: 'tab__name', text: doc.name }),
          dirty ? el('span', { class: 'tab__dirty', title: 'Unsaved changes' }) : null,
        ],
      );

      const close = el('button', {
        class: 'tab__close',
        type: 'button',
        'aria-label': `Close ${doc.name}`,
        'data-hint': `Close ${doc.name}`,
        onclick: ((event: Event) => {
          event.stopPropagation();
          this.onClose(doc.id);
        }) as EventListener,
      });
      close.appendChild(icon('close', 11));
      tab.appendChild(close);

      this.element.appendChild(tab);
    }

    const add = el('button', {
      class: 'tab',
      type: 'button',
      'aria-label': 'New file',
      'data-hint': 'New file',
      onclick: () => this.onNew(),
    });
    add.appendChild(icon('plus', 13));
    this.element.appendChild(add);
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export interface StatusState {
  /** Active document name, and whether it still matches what is on disk. */
  document?: { name: string; dirty: boolean; onDisk: boolean };
  /** Whether the file is stock OpenSCAD, or uses extensions. */
  compatibility: 'full' | 'extended';
  cursor: { line: number; column: number };
  errors: number;
  warnings: number;
  stats?: RenderStats;
  fileMode: string;
  busy: boolean;
  dimension: 2 | 3 | 0;
  autoRender: boolean;
}

export class StatusBar {
  readonly element: HTMLElement;

  constructor(private readonly onToggleAutoRender: () => void) {
    this.element = el('footer', { class: 'statusbar' });
  }

  update(state: StatusState): void {
    clear(this.element);

    // Left to right, the questions people actually ask of a status bar: is my
    // work safe, what am I editing, where am I, and is anything wrong.
    if (state.document) {
      const { dirty, onDisk, name } = state.document;
      const label = dirty ? 'Unsaved changes' : onDisk ? 'Saved to disk' : 'Not saved to a file';
      this.element.appendChild(
        el('span', { class: `statusbar__item statusbar__save${dirty ? ' statusbar__save--dirty' : ''}` }, [
          el('span', { class: 'dot' }),
          el('span', { text: label }),
        ]),
      );
      this.element.appendChild(el('span', { class: 'statusbar__item statusbar__path', text: name }));
    }

    this.element.appendChild(
      el('span', { class: 'statusbar__item', text: `Ln ${state.cursor.line}, Col ${state.cursor.column}` }),
    );

    this.element.appendChild(
      el('span', {
        class: 'statusbar__item',
        title:
          state.compatibility === 'full'
            ? 'Every construct in this file is stock OpenSCAD'
            : 'This file uses BetterSCAD extensions; saving as .scad rewrites them',
        text: `OpenSCAD compat: ${state.compatibility}`,
      }),
    );

    if (state.errors > 0) {
      this.element.appendChild(
        el('span', { class: 'statusbar__item statusbar__item--error' }, [
          el('span', { class: 'dot' }),
          el('span', { text: `${state.errors} error${state.errors === 1 ? '' : 's'}` }),
        ]),
      );
    }
    if (state.warnings > 0) {
      this.element.appendChild(
        el('span', { class: 'statusbar__item statusbar__item--warning' }, [
          el('span', { class: 'dot' }),
          el('span', { text: `${state.warnings} warning${state.warnings === 1 ? '' : 's'}` }),
        ]),
      );
    }

    this.element.appendChild(el('span', { class: 'statusbar__spacer' }));

    if (state.stats && !state.busy) {
      const parts = [
        `${state.stats.triangles.toLocaleString()} tris`,
        state.dimension === 2 ? '2D' : '3D',
        formatDuration(state.stats.totalMs),
      ];
      this.element.appendChild(el('span', { class: 'statusbar__item', text: parts.join(' · ') }));
    }

    const autoRender = button({
      label: state.autoRender ? 'Auto-render on' : 'Auto-render off',
      title: 'Re-render automatically as you type',
      onClick: () => this.onToggleAutoRender(),
    });
    autoRender.classList.toggle('btn--active', state.autoRender);
    this.element.appendChild(autoRender);

    this.element.appendChild(el('span', { class: 'statusbar__item', text: state.fileMode }));
  }
}

// ---------------------------------------------------------------------------
// Animation bar (spec feature 20)
// ---------------------------------------------------------------------------

export interface AnimationCallbacks {
  onTime(t: number): void;
  onPlayState(playing: boolean): void;
  onExportFrames(): void;
  onClose(): void;
}

export class AnimationBar {
  readonly element: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly playButton: HTMLButtonElement;

  private playing = false;
  private frame = 0;
  private handle: number | undefined;
  /** Frames per full 0..1 cycle. */
  steps = 60;
  fps = 20;

  constructor(private readonly callbacks: AnimationCallbacks) {
    this.timeLabel = el('span', { class: 'animbar__time', text: '0.000' });

    this.slider = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.001',
      value: '0',
      'aria-label': 'Animation time ($t)',
      oninput: ((event: Event) => {
        this.stop();
        const t = Number((event.target as HTMLInputElement).value);
        this.setTime(t);
      }) as EventListener,
    });

    this.playButton = button({ label: 'Play', iconName: 'play', onClick: () => this.toggle() });

    const stepsInput = el('input', {
      type: 'number',
      min: '2',
      max: '600',
      value: String(this.steps),
      'aria-label': 'Frames per cycle',
      style: 'width: 68px',
      oninput: ((event: Event) => {
        const value = Number((event.target as HTMLInputElement).value);
        if (Number.isFinite(value) && value >= 2) this.steps = Math.floor(value);
      }) as EventListener,
    });

    this.element = el('div', { class: 'animbar' }, [
      this.playButton,
      el('span', { text: '$t' }),
      this.slider,
      this.timeLabel,
      el('label', {}, [el('span', { text: 'Frames ' }), stepsInput]),
      button({ label: 'Export frames', onClick: () => callbacks.onExportFrames() }),
      button({ label: 'Close', iconName: 'close', onClick: () => callbacks.onClose() }),
    ]);
  }

  private setTime(t: number): void {
    this.slider.value = String(t);
    this.timeLabel.textContent = t.toFixed(3);
    this.callbacks.onTime(t);
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.play();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.playButton.replaceChildren(document.createTextNode('Pause'));
    this.callbacks.onPlayState(true);

    // A timer rather than rAF: playback speed should be the chosen frame rate,
    // not the display's refresh rate, and each frame needs a full re-render.
    this.handle = window.setInterval(() => {
      this.frame = (this.frame + 1) % this.steps;
      this.setTime(this.frame / this.steps);
    }, 1000 / this.fps);
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.handle !== undefined) window.clearInterval(this.handle);
    this.handle = undefined;
    this.playButton.replaceChildren(document.createTextNode('Play'));
    this.callbacks.onPlayState(false);
  }

  get time(): number {
    return Number(this.slider.value);
  }

  dispose(): void {
    this.stop();
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export class Toasts {
  private readonly container: HTMLElement;

  constructor() {
    this.container = el('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(this.container);
  }

  show(message: string, variant: 'info' | 'success' | 'error' = 'info', durationMs = 4500): void {
    const toast = el('div', { class: `toast toast--${variant}` }, [el('span', { text: message })]);
    this.container.appendChild(toast);
    // Errors stay until dismissed; they usually need reading.
    if (variant !== 'error') {
      setTimeout(() => toast.remove(), durationMs);
    } else {
      toast.appendChild(
        button({
          label: 'Dismiss',
          onClick: () => toast.remove(),
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Extension banner (spec feature 21)
// ---------------------------------------------------------------------------

/**
 * A strip under the editor naming the BetterSCAD syntax the open file uses.
 *
 * The alternative is silence until export, which is the wrong moment: by then
 * the file is written and the author has stopped thinking about it. Shown while
 * the code is on screen, it reads as a property of the file rather than as an
 * error about it — which is what it is. Absent entirely for a stock file, so it
 * costs nothing to anyone not using an extension.
 */
export class ExtensionBanner {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private signature = '';

  constructor(private readonly onPreview: () => void) {
    this.body = el('span', { class: 'extbanner__text' });
    this.element = el('div', { class: 'extbanner', hidden: true }, [
      el('span', { class: 'extbanner__badge', text: 'EXT' }),
      this.body,
    ]);
  }

  update(extensions: ExtensionUse[]): void {
    // Rebuilt only when the content actually changes: this is asked on every
    // keystroke, and replacing the DOM each time would drop the link mid-click.
    const next = extensions.map((e) => `${e.name}@${e.lines.join(',')}`).join('|');
    if (next === this.signature) return;
    this.signature = next;

    this.element.hidden = extensions.length === 0;
    if (extensions.length === 0) return;

    clear(this.body);
    // The precise rewrite is long and belongs in the preview, which is one
    // click away. Here the job is to say *that* this file is not stock, and
    // where — a banner nobody finishes reading has told them nothing.
    for (const [index, use] of extensions.entries()) {
      if (index > 0) this.body.append(document.createTextNode(' '));
      this.body.append(
        document.createTextNode(
          `${formatLineList(use.lines)} ${use.lines.length === 1 ? 'uses' : 'use'} `,
        ),
        el('code', { text: use.name }),
        document.createTextNode(
          index === extensions.length - 1
            ? `, ${extensions.length === 1 ? 'a BetterSCAD extension' : 'BetterSCAD extensions'}. Rewritten when you save as OpenSCAD .scad.`
            : ',',
        ),
      );
    }
    this.body.append(
      document.createTextNode(' '),
      el('button', {
        class: 'extbanner__link',
        type: 'button',
        onclick: () => this.onPreview(),
        text: 'Preview downgrade',
      }),
    );
  }
}

/** "Line 19" / "Lines 19, 24" / "Lines 19, 24 and 3 more". */
function formatLineList(lines: number[]): string {
  const shown = lines.slice(0, 2).join(', ');
  const rest = lines.length > 2 ? ` and ${lines.length - 2} more` : '';
  return `${lines.length === 1 ? 'Line' : 'Lines'} ${shown}${rest}`;
}
