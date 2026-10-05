/**
 * The workspace's panels: where they sit, how big they are, and moving them.
 *
 * Renders an {@link Arrangement} — two columns, each a stack of panels — and
 * turns what people do to it back into a new arrangement for the caller to
 * keep. Dividers resize, a panel's grip drags it to another column or another
 * place in its own, and any panel can be hidden or maximized over the rest.
 *
 * The panels' own elements are created once by the caller and only ever moved
 * between containers here, never rebuilt: the editor keeps its undo history and
 * the viewport its WebGL context however often the layout changes around them.
 */

import {
  type Arrangement,
  type PanelId,
  PANEL_IDS,
  PANEL_NAMES,
  clampSplit,
  fromPreset,
  locate,
  movePanel,
  shown,
} from '../state/panels.js';
import { el, icon } from './dom.js';
import { setHint } from './tooltip.js';

export interface PanelLayoutOptions {
  /** Each panel's content, created by the caller and kept for the app's life. */
  content: Record<PanelId, HTMLElement>;
  arrangement: Arrangement;
  /** The arrangement changed and should be kept. */
  onChange(arrangement: Arrangement): void;
  /** Panels moved or resized: anything that measures itself should do so now. */
  onLayout(): void;
}

/** Where a dragged panel would land if dropped now. */
interface DropTarget {
  column: 0 | 1;
  /** Slot in the column's full list, hidden panels included. */
  index: number;
  /** Where to draw the indicator, relative to the workspace. */
  box: { left: number; top: number; width: number; height: number };
}

/** Pixels a press has to travel before it counts as a drag rather than a click. */
const DRAG_SLOP = 4;

/** The smallest share of a pair a divider drag leaves either panel. */
const MIN_SHARE = 0.08;

export class PanelLayout {
  readonly element: HTMLElement;
  private arrangement: Arrangement;
  private readonly frames = {} as Record<PanelId, HTMLElement>;
  private readonly controls = {} as Record<PanelId, {
    element: HTMLElement;
    grip: HTMLButtonElement;
    maximize: HTMLButtonElement;
  }>;
  /** The rendered columns, for hit-testing a drag. */
  private columnElements: { column: 0 | 1; element: HTMLElement }[] = [];
  private indicator = el('div', { class: 'layout__drop', hidden: true });

  constructor(private readonly options: PanelLayoutOptions) {
    this.arrangement = options.arrangement;
    this.element = el('div', { class: 'workspace layout' });
    for (const id of PANEL_IDS) {
      this.frames[id] = el('div', { class: `layout__panel layout__panel--${id}`, 'data-panel': id }, [
        options.content[id],
      ]);
      this.controls[id] = this.buildControls(id);
    }
    this.render();
  }

  get state(): Arrangement {
    return this.arrangement;
  }

  /**
   * The grip and maximize buttons for a panel, for the caller to place in that
   * panel's own header — every panel already has a strip along its top, and a
   * second one just for these would cost each of them a row.
   */
  controlsFor(id: PanelId): HTMLElement {
    return this.controls[id].element;
  }

  /** Replaces the whole arrangement — a preset, or a reset. */
  set(arrangement: Arrangement): void {
    this.commit(arrangement);
  }

  setVisible(id: PanelId, visible: boolean): void {
    if (this.arrangement.visible[id] === visible && !(visible && this.arrangement.maximized)) return;
    this.commit({
      ...this.arrangement,
      visible: { ...this.arrangement.visible, [id]: visible },
      // Showing a panel while another fills the screen would show nothing;
      // hiding the one that fills it would leave an empty workspace. Either
      // way, the maximized view has stopped being what was asked for.
      maximized:
        this.arrangement.maximized === id || (visible && this.arrangement.maximized) ? null : this.arrangement.maximized,
    });
  }

  toggleMaximized(id: PanelId): void {
    const maximized = this.arrangement.maximized === id ? null : id;
    this.commit({
      ...this.arrangement,
      maximized,
      visible: maximized ? { ...this.arrangement.visible, [id]: true } : this.arrangement.visible,
    });
  }

  private commit(arrangement: Arrangement): void {
    this.arrangement = arrangement;
    this.render();
    this.options.onChange(arrangement);
  }

  // -- rendering ------------------------------------------------------------

  private render(): void {
    const a = this.arrangement;
    const children: HTMLElement[] = [];
    this.columnElements = [];

    if (a.maximized) {
      children.push(this.column(locate(a, a.maximized).column, [a.maximized], '1 1 0'));
    } else {
      const left = shown(a, 0);
      const right = shown(a, 1);
      if (left.length > 0 && right.length > 0) {
        children.push(
          this.column(0, left, `0 0 ${(a.split * 100).toFixed(3)}%`),
          this.columnDivider(),
          this.column(1, right, '1 1 0'),
        );
      } else if (left.length > 0 || right.length > 0) {
        children.push(left.length > 0 ? this.column(0, left, '1 1 0') : this.column(1, right, '1 1 0'));
      } else {
        children.push(this.emptyState());
      }
    }

    this.element.replaceChildren(...children, this.indicator);
    for (const id of PANEL_IDS) this.syncControls(id);
    this.options.onLayout();
  }

  private column(column: 0 | 1, ids: PanelId[], flex: string): HTMLElement {
    const node = el('div', { class: 'layout__column', style: `flex: ${flex}` });
    ids.forEach((id, i) => {
      if (i > 0) node.append(this.rowDivider(ids[i - 1], id));
      const frame = this.frames[id];
      frame.style.flex = ids.length === 1 ? '1 1 0' : `${this.arrangement.weights[id]} 1 0`;
      node.append(frame);
    });
    this.columnElements.push({ column, element: node });
    return node;
  }

  private emptyState(): HTMLElement {
    const reset = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Reset layout',
      onclick: () => this.set(fromPreset('default')),
    });
    return el('div', { class: 'layout__empty' }, [
      el('p', { text: 'Every panel is hidden.' }),
      el('p', { class: 'layout__emptyhint', text: 'Show one from the Layout menu, or start again:' }),
      reset,
    ]);
  }

  private syncControls(id: PanelId): void {
    const { grip, maximize } = this.controls[id];
    const max = this.arrangement.maximized === id;
    maximize.replaceChildren(icon(max ? 'unmaximize' : 'maximize', 14));
    maximize.setAttribute('aria-pressed', String(max));
    maximize.setAttribute('aria-label', max ? `Restore ${PANEL_NAMES[id]}` : `Maximize ${PANEL_NAMES[id]}`);
    setHint(maximize, max ? 'Restore the other panels' : `Maximize — fill the window with the ${PANEL_NAMES[id].toLowerCase()}`);
    // There is nowhere to drag to while one panel fills the window.
    grip.disabled = this.arrangement.maximized !== null;
  }

  // -- controls ---------------------------------------------------------------

  private buildControls(id: PanelId): {
    element: HTMLElement;
    grip: HTMLButtonElement;
    maximize: HTMLButtonElement;
  } {
    const name = PANEL_NAMES[id];
    const grip = el('button', {
      class: 'panelctl__btn panelctl__grip',
      type: 'button',
      'aria-label': `Move ${name}`,
    }) as HTMLButtonElement;
    grip.append(icon('grip', 14));
    setHint(grip, `Drag to move the ${name.toLowerCase()} — or focus and use the arrow keys`);
    grip.addEventListener('pointerdown', (event) => this.startDrag(id, event, grip));
    grip.addEventListener('keydown', (event) => this.onGripKey(id, event));
    grip.addEventListener('dblclick', () => this.toggleMaximized(id));

    const maximize = el('button', {
      class: 'panelctl__btn',
      type: 'button',
      onclick: () => this.toggleMaximized(id),
    }) as HTMLButtonElement;

    return { element: el('div', { class: 'panelctl' }, [grip, maximize]), grip, maximize };
  }

  /**
   * Arrow keys move a panel the way a drag would: up and down within its
   * column, left and right to the end of the other one.
   */
  private onGripKey(id: PanelId, event: KeyboardEvent): void {
    const { column, index } = locate(this.arrangement, id);
    let next: Arrangement | undefined;
    if (event.key === 'ArrowUp' && index > 0) next = movePanel(this.arrangement, id, column, index - 1);
    else if (event.key === 'ArrowDown' && index < this.arrangement.columns[column].length - 1) {
      next = movePanel(this.arrangement, id, column, index + 2);
    } else if (event.key === 'ArrowLeft' && column === 1) {
      next = movePanel(this.arrangement, id, 0, this.arrangement.columns[0].length);
    } else if (event.key === 'ArrowRight' && column === 0) {
      next = movePanel(this.arrangement, id, 1, this.arrangement.columns[1].length);
    } else {
      return;
    }
    event.preventDefault();
    this.commit(next);
    this.controls[id].grip.focus();
  }

  // -- dragging a panel -------------------------------------------------------

  private startDrag(id: PanelId, event: PointerEvent, grip: HTMLButtonElement): void {
    if (event.button !== 0 || this.arrangement.maximized) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let target: DropTarget | undefined;
    const ghost = el('div', { class: 'layout__ghost', text: PANEL_NAMES[id] });

    const move = (e: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SLOP) return;
        dragging = true;
        this.element.classList.add('layout--dragging');
        this.frames[id].classList.add('layout__panel--lifted');
        document.body.append(ghost);
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      target = this.dropTarget(e.clientX, e.clientY);
      this.showIndicator(target);
    };
    const end = (commit: boolean): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      ghost.remove();
      this.showIndicator(undefined);
      this.element.classList.remove('layout--dragging');
      this.frames[id].classList.remove('layout__panel--lifted');
      if (commit && dragging && target) {
        const from = locate(this.arrangement, id);
        const unchanged =
          from.column === target.column && (target.index === from.index || target.index === from.index + 1);
        if (!unchanged) this.commit(movePanel(this.arrangement, id, target.column, target.index));
      }
    };
    const up = (): void => end(true);
    const cancel = (): void => end(false);
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  }

  /**
   * Where a drop at this point would put the panel.
   *
   * With both columns showing, the column under the pointer, at the gap between
   * panels nearest it. With one, the outer fifth of the window on the empty
   * side makes a new column there — the only way to bring a second column back
   * after every panel has been dragged out of it.
   */
  private dropTarget(x: number, y: number): DropTarget | undefined {
    const root = this.element.getBoundingClientRect();
    const rendered = this.columnElements;
    if (rendered.length === 0) return undefined;

    if (rendered.length === 1) {
      const empty: 0 | 1 = rendered[0].column === 0 ? 1 : 0;
      const band = root.width * 0.2;
      const inBand = empty === 0 ? x < root.left + band : x > root.right - band;
      if (inBand) {
        return {
          column: empty,
          index: this.arrangement.columns[empty].length,
          box: { left: empty === 0 ? 0 : root.width - band, top: 0, width: band, height: root.height },
        };
      }
    }

    const hit =
      rendered.find(({ element }) => {
        const r = element.getBoundingClientRect();
        return x >= r.left && x <= r.right;
      }) ?? (x < root.left + root.width / 2 ? rendered[0] : rendered[rendered.length - 1]);

    const column = hit.column;
    const visible = shown(this.arrangement, column);
    const rects = visible.map((id) => this.frames[id].getBoundingClientRect());
    let slot = rects.findIndex((r) => y < r.top + r.height / 2);
    if (slot < 0) slot = visible.length;

    const colRect = hit.element.getBoundingClientRect();
    const lineY =
      slot === 0 ? rects[0]?.top ?? colRect.top : slot === visible.length ? rects[slot - 1].bottom : rects[slot].top;
    const full = this.arrangement.columns[column];
    return {
      column,
      index: slot < visible.length ? full.indexOf(visible[slot]) : full.length,
      box: {
        left: colRect.left - root.left,
        top: Math.min(Math.max(lineY - root.top - 2, 0), root.height - 4),
        width: colRect.width,
        height: 4,
      },
    };
  }

  private showIndicator(target: DropTarget | undefined): void {
    this.indicator.hidden = !target;
    if (!target) return;
    const { left, top, width, height } = target.box;
    Object.assign(this.indicator.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.indicator.classList.toggle('layout__drop--column', height > 4);
  }

  // -- dividers ---------------------------------------------------------------

  /** Between the two columns: drags the left column's share of the width. */
  private columnDivider(): HTMLElement {
    const node = this.divider('vertical', 'Resize the columns');
    const left = (): HTMLElement => node.previousElementSibling as HTMLElement;

    const set = (split: number, keep: boolean): void => {
      this.arrangement = { ...this.arrangement, split: clampSplit(split) };
      left().style.flex = `0 0 ${(this.arrangement.split * 100).toFixed(3)}%`;
      this.options.onLayout();
      if (keep) this.options.onChange(this.arrangement);
    };

    this.dragDivider(node, (x) => {
      const r = this.element.getBoundingClientRect();
      set((x - r.left) / r.width, false);
    }, () => this.options.onChange(this.arrangement));
    node.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') set(this.arrangement.split - step, true);
      else if (event.key === 'ArrowRight') set(this.arrangement.split + step, true);
      else return;
      event.preventDefault();
    });
    // Back to the default share: the quickest way out of an accidental drag.
    node.addEventListener('dblclick', () => set(fromPreset('default').split, true));
    return node;
  }

  /** Between two panels in a column: trades height between exactly those two. */
  private rowDivider(above: PanelId, below: PanelId): HTMLElement {
    const node = this.divider('horizontal', `Resize the ${PANEL_NAMES[above].toLowerCase()} and the ${PANEL_NAMES[below].toLowerCase()}`);

    const set = (share: number, keep: boolean): void => {
      const w = this.arrangement.weights;
      const total = w[above] + w[below];
      const a = total * Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share));
      this.arrangement = { ...this.arrangement, weights: { ...w, [above]: a, [below]: total - a } };
      this.frames[above].style.flex = `${a} 1 0`;
      this.frames[below].style.flex = `${total - a} 1 0`;
      this.options.onLayout();
      if (keep) this.options.onChange(this.arrangement);
    };
    const share = (): number => {
      const w = this.arrangement.weights;
      return w[above] / (w[above] + w[below]);
    };

    this.dragDivider(node, (_x, y) => {
      const top = this.frames[above].getBoundingClientRect();
      const bottom = this.frames[below].getBoundingClientRect();
      set((y - top.top) / (bottom.bottom - top.top), false);
    }, () => this.options.onChange(this.arrangement));
    node.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowUp') set(share() - step, true);
      else if (event.key === 'ArrowDown') set(share() + step, true);
      else return;
      event.preventDefault();
    });
    return node;
  }

  private divider(orientation: 'vertical' | 'horizontal', label: string): HTMLElement {
    return el('div', {
      class: `splitter splitter--${orientation}`,
      role: 'separator',
      tabindex: '0',
      'aria-orientation': orientation,
      'aria-label': label,
    });
  }

  private dragDivider(node: HTMLElement, move: (x: number, y: number) => void, done: () => void): void {
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      node.setPointerCapture(event.pointerId);
      node.classList.add('splitter--dragging');
      const onMove = (e: PointerEvent): void => move(e.clientX, e.clientY);
      const onUp = (): void => {
        node.classList.remove('splitter--dragging');
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        done();
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }
}
