/**
 * Toolbar, tab strip, status bar, animation bar and toasts.
 *
 * These are thin views over state the app owns: each exposes an `update()`
 * that re-reads everything rather than trying to patch incrementally, which
 * for a handful of elements is both simpler and fast enough.
 */

import {
  button,
  clear,
  el,
  formatDuration,
  icon,
  openMenu,
  splitButton,
  type MenuItem,
} from './dom.js';
import { setHint } from './tooltip.js';
import { formatShortcut } from './command-palette.js';
import type { Document, DocumentFormat, LayoutState } from '../state/workspace.js';
import type { RenderStats } from '../render/protocol.js';

/** The project's source. */
export const REPO_URL = 'https://github.com/theanam/betterScad';
/** Where a bug goes. Issues are public and searchable, which is the point. */
export const ISSUES_URL = `${REPO_URL}/issues`;
/** Where everything that is not a bug goes. */
export const CONTACT_EMAIL = 'anam.ahmed.a@gmail.com';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The handful of things this app asks rather than assumes.
 *
 * Deliberately a handful. Every one of these was a default somebody would
 * eventually disagree with, and none of them changes what a saved file means —
 * a model written with either `roundMeasure` opens the same everywhere.
 */
export type AppSettings = Pick<
  LayoutState,
  'theme' | 'roundMeasure' | 'inchEntry' | 'tabCompletion' | 'autoRender' | 'indentWidth'
>;

/**
 * The gear: one button, one menu, all of it.
 *
 * The theme used to be a sun/moon switch sitting in the toolbar on its own.
 * That worked while it was the only preference; it does not generalise, and a
 * row of little switches is worse than a menu the moment there are three of
 * them. The menu is built on open so it always shows what is actually set.
 */
export class SettingsButton {
  readonly element: HTMLButtonElement;
  private settings: AppSettings | undefined;

  constructor(
    private readonly onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void,
  ) {
    this.element = button({
      label: 'Settings',
      iconName: 'gear',
      title: 'Theme, units and editor settings',
      onClick: () => this.open(),
    });
    this.element.setAttribute('aria-haspopup', 'menu');
    this.element.setAttribute('aria-expanded', 'false');
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  private open(): void {
    const settings = this.settings;
    if (!settings) return;
    openMenu(this.element, [
      {
        kind: 'choice',
        label: 'Theme',
        value: settings.theme,
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
        onChange: (value) => this.onChange('theme', value as AppSettings['theme']),
      },
      {
        kind: 'choice',
        label: 'Round dimensions',
        description: 'Which one autocomplete offers first for cylinder, sphere and circle',
        value: settings.roundMeasure,
        options: [
          { value: 'radius', label: 'Radius', hint: 'cylinder(h, r)' },
          { value: 'diameter', label: 'Diameter', hint: 'cylinder(h, d)' },
        ],
        onChange: (value) => this.onChange('roundMeasure', value as AppSettings['roundMeasure']),
      },
      {
        kind: 'toggle',
        label: 'Inch entry',
        description: 'Type 5in and get 127 — models stay in millimetres',
        value: settings.inchEntry,
        onChange: (value) => this.onChange('inchEntry', value),
      },
      {
        kind: 'toggle',
        label: 'Tab completion',
        description: 'Tab takes the open suggestion; with none open it indents as usual',
        value: settings.tabCompletion,
        onChange: (value) => this.onChange('tabCompletion', value),
      },
      {
        kind: 'toggle',
        label: 'Auto-render',
        description: 'Re-render as you type, instead of on F5',
        value: settings.autoRender,
        onChange: (value) => this.onChange('autoRender', value),
      },
      {
        kind: 'choice',
        label: 'Indent',
        value: String(settings.indentWidth),
        options: [
          { value: '2', label: '2 spaces' },
          { value: '4', label: '4 spaces' },
        ],
        onChange: (value) => this.onChange('indentWidth', Number(value) as AppSettings['indentWidth']),
      },
    ]);
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
  /** The document plus every project file it uses, as one archive. */
  saveAsZip(): void;
  preview(): void;
  render(): void;
  export(): void;
  toggleCustomizer(): void;
  toggleConsole(): void;
  toggleFiles(): void;
  /** One setting changed in the gear menu. */
  changeSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  openPalette(): void;
  openFonts(): void;
  openHelp(): void;
}

export class Toolbar {
  readonly element: HTMLElement;
  private readonly customizerButton: HTMLButtonElement;
  private readonly consoleButton: HTMLButtonElement;
  private readonly filesButton: HTMLButtonElement;
  private readonly previewButton: HTMLButtonElement;
  private readonly renderButton: HTMLButtonElement;
  private readonly settingsButton: SettingsButton;

  /** Drives the Save menu; a `.scad` gets the extra "Save as .bscad" item. */
  private documentFormat: DocumentFormat = 'bscad';
  /** Whether the model on screen resolved anything from the project directory. */
  private usesProjectFiles = false;
  /** Buttons that act on the open document, and mean nothing without one. */
  private readonly documentActions: HTMLButtonElement[] = [];

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
    this.filesButton = button({
      label: 'Files',
      iconName: 'files',
      title: 'Files every tab can use by name — images, drawings, meshes, fonts and libraries',
      onClick: () => this.actions.toggleFiles(),
    });
    this.settingsButton = new SettingsButton((key, value) => actions.changeSetting(key, value));
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

    const exportButton = button({
      label: 'Export',
      iconName: 'download',
      shortcut: formatShortcut('Mod+E'),
      onClick: () => actions.export(),
    });
    const saveButton = splitButton({
      label: 'Save',
      iconName: 'save',
      shortcut: formatShortcut('Mod+S'),
      onClick: () => actions.save(),
      menuLabel: 'More save options',
      items: () => this.saveMenuItems(),
    });

    // Everything that acts on the open document. `splitButton` returns the
    // wrapper, so both halves are collected from inside it.
    this.documentActions.push(
      this.previewButton,
      this.renderButton,
      exportButton,
      ...(Array.from(saveButton.querySelectorAll('button')) as HTMLButtonElement[]),
    );

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
        saveButton,
      ]),
      el('div', { class: 'toolbar__divider' }),
      el('div', { class: 'toolbar__group' }, [
        this.previewButton,
        this.renderButton,
        exportButton,
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
        this.filesButton,
        this.customizerButton,
        this.consoleButton,
        button({ label: 'Fonts', iconName: 'font', onClick: () => actions.openFonts() }),
        // Help sits with the panels rather than out by the GitHub link: it is
        // part of the app, not a way out of it, and a newcomer looking for
        // "where do I find out what cylinder() takes" looks along this row.
        button({
          label: 'Help',
          iconName: 'help',
          shortcut: 'F1',
          title: 'Help & Reference — every element of the language, with examples',
          onClick: () => actions.openHelp(),
        }),
        el('div', { class: 'toolbar__divider' }),
        this.settingsButton.element,
        githubLink(),
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

    // Listed only when there is something to package. A model that depends on
    // nothing zips to one file in a folder, which is a worse way of saving it
    // than Save — and an item that always appears would imply otherwise.
    if (this.usesProjectFiles) {
      items.push({
        label: 'Save as .zip…',
        description: 'This file and every file it uses, in one folder',
        onSelect: () => this.actions.saveAsZip(),
      });
    }

    return items;
  }

  update(state: {
    customizerVisible: boolean;
    consoleVisible: boolean;
    filesVisible: boolean;
    settings: AppSettings;
    showingFinalRender: boolean;
    documentFormat: DocumentFormat;
    /** Drives the Save menu's zip item; see `saveMenuItems`. */
    usesProjectFiles: boolean;
    /** False with no document open, which leaves half the toolbar inert. */
    hasDocument: boolean;
  }): void {
    this.documentFormat = state.documentFormat;
    this.usesProjectFiles = state.usesProjectFiles;

    // Disabled rather than hidden: a toolbar that changes shape as tabs open
    // and close is harder to aim at than one whose buttons grey out.
    for (const node of this.documentActions) node.disabled = !state.hasDocument;

    this.customizerButton.classList.toggle('btn--active', state.customizerVisible);
    this.consoleButton.classList.toggle('btn--active', state.consoleVisible);
    this.filesButton.classList.toggle('btn--active', state.filesVisible);

    // Auto-render already re-renders in preview mode on every edit, so the
    // Preview button would do exactly nothing. F5 still works — hiding a
    // button should not remove its shortcut.
    this.previewButton.hidden = state.settings.autoRender;

    // Render is not redundant: it is the only way to see $preview = false,
    // which is what Export produces. Marking it active when that is what is on
    // screen is the difference between a useful button and a mystery one.
    this.renderButton.classList.toggle('btn--active', state.showingFinalRender);
    this.renderButton.title = state.showingFinalRender
      ? 'Showing the final render ($preview = false)'
      : 'Re-render with $preview = false — the geometry Export produces';

    this.settingsButton.setSettings(state.settings);
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
      close.appendChild(icon('close', 15));
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
  /** Whether the file is stock OpenSCAD, or uses extensions. Absent with none open. */
  compatibility?: 'full' | 'extended';
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

    // A cursor position and a compatibility verdict are both claims about a
    // file. With none open they would be claims about nothing.
    if (state.document) {
      this.element.appendChild(
        el('span', { class: 'statusbar__item', text: `Ln ${state.cursor.line}, Col ${state.cursor.column}` }),
      );
    }

    if (state.compatibility) {
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
    }

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

/**
 * Link to the source, as a round icon at the end of the toolbar.
 *
 * An anchor rather than a button: it navigates, so it should behave like a link
 * — middle-click, copy address, open in a new tab. Round because it is the one
 * control here that leaves the app, and the shape says so before the glyph does.
 */
function githubLink(): HTMLAnchorElement {
  const node = el('a', {
    class: 'toolbar__github',
    href: REPO_URL,
    target: '_blank',
    rel: 'noreferrer noopener',
  }) as HTMLAnchorElement;
  node.appendChild(icon('github', 15));
  setHint(node, 'Source on GitHub');
  return node;
}
