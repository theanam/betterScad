/**
 * Toolbar, tab strip, status bar, animation bar and toasts.
 *
 * These are thin views over state the app owns: each exposes an `update()`
 * that re-reads everything rather than trying to patch incrementally, which
 * for a handful of elements is both simpler and fast enough.
 */

import { button, clear, el, formatDuration, icon } from './dom.js';
import { formatShortcut } from './command-palette.js';
import type { Document } from '../state/workspace.js';
import type { RenderStats } from '../render/protocol.js';

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

/**
 * A sun/moon switch rather than a button.
 *
 * Both icons stay visible with a thumb resting over the active one, so the
 * control reads as a two-state switch at a glance and needs no label. It is
 * deliberately small and muted: theme is set once and then forgotten, so it
 * should not compete with the actions next to it.
 */
export class ThemeToggle {
  readonly element: HTMLButtonElement;

  constructor(onToggle: () => void) {
    const track = el('span', { class: 'themetoggle__track' });

    const sun = icon('sun', 13);
    sun.classList.add('themetoggle__icon', 'themetoggle__icon--sun');
    const moon = icon('moon', 13);
    moon.classList.add('themetoggle__icon', 'themetoggle__icon--moon');

    track.append(el('span', { class: 'themetoggle__thumb' }), sun, moon);

    // `role="switch"` gives the right affordance to assistive tech; `checked`
    // means dark, which the label below names explicitly so "on" is not
    // left to interpretation.
    this.element = el('button', {
      class: 'themetoggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'true',
      'aria-label': 'Dark theme',
      onclick: () => onToggle(),
    }) as HTMLButtonElement;
    this.element.appendChild(track);
  }

  setTheme(theme: 'light' | 'dark'): void {
    const dark = theme === 'dark';
    this.element.setAttribute('aria-checked', String(dark));
    this.element.title = `Switch to ${dark ? 'light' : 'dark'} theme`;
    this.element.setAttribute('aria-label', 'Dark theme');
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface ToolbarActions {
  newFile(): void;
  open(): void;
  save(): void;
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
  private readonly themeToggle: ThemeToggle;

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

    this.element = el('header', { class: 'toolbar', role: 'toolbar' }, [
      el('div', { class: 'toolbar__brand' }, [
        el('img', { src: './betterscad-mark.svg', width: '22', height: '22', alt: '' }),
        el('span', { html: 'Better<em>SCAD</em>' }),
      ]),
      el('div', { class: 'toolbar__group' }, [
        button({ label: 'New', iconName: 'plus', shortcut: formatShortcut('Mod+N'), onClick: () => actions.newFile() }),
        button({ label: 'Open', iconName: 'open', shortcut: formatShortcut('Mod+O'), onClick: () => actions.open() }),
        button({ label: 'Save', iconName: 'save', shortcut: formatShortcut('Mod+S'), onClick: () => actions.save() }),
      ]),
      el('div', { class: 'toolbar__divider' }),
      el('div', { class: 'toolbar__group' }, [
        button({ label: 'Preview', iconName: 'play', shortcut: 'F5', variant: 'primary', onClick: () => actions.preview() }),
        button({ label: 'Render', iconName: 'render', shortcut: 'F6', onClick: () => actions.render() }),
        button({ label: 'Export', iconName: 'download', shortcut: formatShortcut('Mod+E'), onClick: () => actions.export() }),
      ]),
      el('div', { class: 'toolbar__spacer' }),
      el('div', { class: 'toolbar__group' }, [
        this.customizerButton,
        this.consoleButton,
        button({ label: 'Fonts', iconName: 'font', onClick: () => actions.openFonts() }),
        button({
          label: 'Commands',
          title: 'Command palette',
          shortcut: formatShortcut('Mod+Shift+P'),
          onClick: () => actions.openPalette(),
        }),
        el('div', { class: 'toolbar__divider' }),
        this.themeToggle.element,
      ]),
    ]);
  }

  update(state: {
    customizerVisible: boolean;
    consoleVisible: boolean;
    theme: 'light' | 'dark';
  }): void {
    this.customizerButton.classList.toggle('btn--active', state.customizerVisible);
    this.consoleButton.classList.toggle('btn--active', state.consoleVisible);
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
      title: 'New file',
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

    this.element.appendChild(
      el('span', { class: 'statusbar__item', text: `Ln ${state.cursor.line}, Col ${state.cursor.column}` }),
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
