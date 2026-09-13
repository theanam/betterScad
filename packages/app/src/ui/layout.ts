/**
 * Resizable split-pane layout (spec feature 5).
 *
 * Panels are side-by-side by default and draggable, and the fractions are
 * handed back to the caller to persist — which answers the spec's open
 * question about saving panel arrangement between sessions.
 */

import { el } from './dom.js';

export type Orientation = 'vertical' | 'horizontal';

export interface SplitOptions {
  orientation: Orientation;
  /** Size of the first pane as a fraction of the container, 0..1. */
  initialFraction: number;
  minFraction?: number;
  maxFraction?: number;
  onResize?(fraction: number): void;
}

export class Split {
  readonly element: HTMLElement;
  readonly first: HTMLElement;
  readonly second: HTMLElement;
  private readonly splitter: HTMLElement;
  private fraction: number;
  private dragging = false;

  constructor(private readonly options: SplitOptions) {
    this.fraction = options.initialFraction;

    this.first = el('div', { class: 'pane' });
    this.second = el('div', { class: 'pane' });
    this.splitter = el('div', {
      class: `splitter splitter--${options.orientation}`,
      role: 'separator',
      tabindex: '0',
      'aria-orientation': options.orientation === 'vertical' ? 'vertical' : 'horizontal',
      'aria-label': 'Resize panels',
    });

    this.element = el(
      'div',
      {
        class: 'workspace',
        style: options.orientation === 'vertical' ? 'flex-direction: row' : 'flex-direction: column',
      },
      [this.first, this.splitter, this.second],
    );

    this.splitter.addEventListener('pointerdown', this.onPointerDown);
    this.splitter.addEventListener('keydown', this.onKeyDown);
    // A double-click resets to the default, which is the fastest way back from
    // an accidental drag to zero.
    this.splitter.addEventListener('dblclick', () => this.setFraction(options.initialFraction));

    this.apply();
  }

  private get isVertical(): boolean {
    return this.options.orientation === 'vertical';
  }

  setFraction(value: number): void {
    const min = this.options.minFraction ?? 0.12;
    const max = this.options.maxFraction ?? 0.88;
    this.fraction = Math.min(max, Math.max(min, value));
    this.apply();
    this.options.onResize?.(this.fraction);
  }

  get value(): number {
    return this.fraction;
  }

  private apply(): void {
    const percent = `${(this.fraction * 100).toFixed(3)}%`;
    // `flex-basis` with `flex-grow: 0` keeps the ratio stable while the window
    // resizes; percentage widths would fight the splitter's fixed size.
    this.first.style.flex = `0 0 ${percent}`;
    this.second.style.flex = '1 1 0';
  }

  private onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.dragging = true;
    this.splitter.classList.add('splitter--dragging');
    this.splitter.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp, { once: true });
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const rect = this.element.getBoundingClientRect();
    const position = this.isVertical
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    this.setFraction(position);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
    this.splitter.classList.remove('splitter--dragging');
    window.removeEventListener('pointermove', this.onPointerMove);
  };

  /** Keyboard resizing, so the layout is reachable without a pointer. */
  private onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const decrease = this.isVertical ? 'ArrowLeft' : 'ArrowUp';
    const increase = this.isVertical ? 'ArrowRight' : 'ArrowDown';

    if (event.key === decrease) {
      this.setFraction(this.fraction - step);
    } else if (event.key === increase) {
      this.setFraction(this.fraction + step);
    } else if (event.key === 'Home') {
      this.setFraction(this.options.minFraction ?? 0.12);
    } else if (event.key === 'End') {
      this.setFraction(this.options.maxFraction ?? 0.88);
    } else {
      return;
    }
    event.preventDefault();
  };

  /** Hides the second pane entirely (used to collapse the console). */
  setSecondVisible(visible: boolean): void {
    this.splitter.hidden = !visible;
    this.second.hidden = !visible;
    this.first.style.flex = visible ? `0 0 ${(this.fraction * 100).toFixed(3)}%` : '1 1 0';
  }
}
