/**
 * Small DOM helpers.
 *
 * The app builds its UI imperatively rather than with a framework: it is a
 * handful of long-lived panels around an editor and a canvas, and a framework's
 * bundle cost buys nothing here (spec feature 1: a small static site).
 */

import { setHint } from './tooltip.js';

type Attributes = Record<string, string | number | boolean | undefined | EventListener>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attributes = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Formats a number for display: compact, but never misleadingly rounded to 0. */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) < 0.01) return value.toExponential(1);
  if (Math.abs(value) >= 1e6) return value.toExponential(2);
  // Strip trailing zeros only *after* a decimal point. Without the guard,
  // `formatNumber(60, 0)` returns "6" and `formatNumber(100, 0)` returns "1".
  return value
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Trailing-edge debounce, used for auto-render on typing. */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
): ((...args: T) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: T): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

const ICONS: Record<string, string> = {
  play: 'M4 2.5v11l9-5.5z',
  render: 'M8 1.5 14.5 5v6L8 14.5 1.5 11V5zM8 3 3 5.9v4.2L8 13l5-2.9V5.9z',
  open: 'M1.5 3.5h4.2l1.4 1.6h7.4v7.4H1.5z',
  save: 'M2 2h9l3 3v9H2zm3 0v4h5V2zM4 9h8v5H4z',
  download: 'M7.25 1.5h1.5v7.2l2.6-2.6 1.06 1.06L8 12.62 3.59 7.16 4.65 6.1l2.6 2.6zM2.5 12.5h11v1.5h-11z',
  grid: 'M2 2h12v12H2zm4 0v12M10 2v12M2 6h12M2 10h12',
  axes: 'M2 14V2M2 14h12M2 14 8 8',
  ruler: 'M1.5 5.5h13v5h-13zM4 5.5v2M6.5 5.5v3M9 5.5v2M11.5 5.5v3',
  frame: 'M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3',
  console: 'M2 3h12v10H2zm2.5 2.5 2 2-2 2M8 9.5h3.5',
  sliders: 'M2 4h8M12 4h2M2 8h2M6 8h8M2 12h6M10 12h4M10 2v4M4 6v4M8 10v4',
  close: 'M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5',
  plus: 'M8 3v10M3 8h10',
  font: 'M3 13 7 3h2l4 10M4.8 9.5h6.4',
  // A question mark in a ring. The dot is a zero-length segment, which the
  // round line cap turns into a circle.
  help: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM6.1 6.2a1.95 1.95 0 0 1 3.8.6c0 1.3-1.9 1.5-1.9 2.9M8 11.9v.01',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  caret: 'M4.5 6.5 8 10l3.5-3.5',
  // GitHub's own mark (Octicons `mark-github-16`), filled rather than stroked.
  github:
    'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.27-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.71-2.33-.5-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8z',
  search: 'M7.2 2.5a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4zM10.6 10.6 14 14',
  // Crescent: a disc with a second disc subtracted, drawn as one outline. Its
  // ink is asymmetric, so the start point is offset by (+0.52, -0.52) to put
  // the bounding box centre on (8, 8) — otherwise it hangs low and left of the
  // sun beside it.
  moon: 'M13.92 9.28A6 6 0 0 1 6.72 2.08a6 6 0 1 0 7.2 7.2z',
  sun: 'M8 5.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4zM8 1.2v1.5M8 13.3v1.5M14.8 8h-1.5M2.7 8H1.2M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1M12.8 12.8l-1.1-1.1M4.3 4.3 3.2 3.2',
  // A 300-degree arc with a chevron at its head: the usual "reset" glyph.
  reset: 'M8 2.5A5.5 5.5 0 1 1 3.24 5.25M5.8 1.5 8 2.5 7.05 4.75',
  // Isometric cube: a hexagon outline with the three edges that meet at the
  // near corner, which is what makes it read as a cube rather than a hexagon.
  cube: 'M8 1.8 13.4 4.9 13.4 11.1 8 14.2 2.6 11.1 2.6 4.9Z M8 8 13.4 4.9M8 8 2.6 4.9M8 8v6.2',
};

/**
 * Icons drawn as a filled silhouette rather than a stroked outline.
 *
 * The rest of the set is hand-drawn to one stroke weight; a borrowed logo is
 * not. Stroking the GitHub mark would trace every contour of its silhouette and
 * read as noise at 16px, so it is filled the way its owner draws it.
 */
const FILLED_ICONS = new Set(['github']);

/** Inline SVG icon; `stroke` style keeps them crisp at 16px. */
export function icon(name: keyof typeof ICONS | string, size = 15): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flex = 'none';

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.gear);

  if (FILLED_ICONS.has(name)) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(path);
  return svg;
}

export interface ButtonOptions {
  label?: string;
  title?: string;
  iconName?: string;
  variant?: 'default' | 'primary' | 'ghost';
  shortcut?: string;
  /**
   * Hover/focus hint. Defaults to the title, and is what an icon-only control
   * relies on to explain itself.
   */
  hint?: string;
  onClick(): void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const classes = ['btn'];
  if (options.variant === 'primary') classes.push('btn--primary');
  if (options.variant === 'ghost') classes.push('btn--ghost');

  const described = options.title ?? options.label ?? '';
  const text = options.shortcut ? `${described} (${options.shortcut})` : described;

  const node = el('button', {
    class: classes.join(' '),
    type: 'button',
    'aria-label': options.label ?? options.title,
    onclick: () => options.onClick(),
  });

  // `setHint` also strips `title`, so the styled hint and the OS tooltip can
  // never both appear.
  const hintText = options.hint ?? text;
  if (hintText) setHint(node, hintText);

  if (options.iconName) node.appendChild(icon(options.iconName));
  if (options.label) node.appendChild(el('span', { text: options.label }));
  return node;
}

export interface MenuItem {
  label: string;
  /** A second line explaining what the item does, for the less obvious ones. */
  description?: string;
  shortcut?: string;
  onSelect(): void;
}

/**
 * Opens a popup menu anchored under an element.
 *
 * Positioned `fixed` against the anchor's rect rather than nested inside it:
 * the toolbar is a flex row with its own overflow, and a nested absolute menu
 * would be clipped by it. Flipping above the anchor when there is no room
 * below keeps the last item reachable at short window heights.
 */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  const node = el('div', { class: 'menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];

  const close = (): void => {
    node.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus();
  };

  const onOutside = (event: MouseEvent): void => {
    if (!node.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  for (const item of items) {
    const entry = el('button', {
      class: 'menu__item',
      type: 'button',
      role: 'menuitem',
      onclick: () => {
        close();
        item.onSelect();
      },
    }) as HTMLButtonElement;
    entry.append(
      el('span', { class: 'menu__label' }, [
        el('span', { text: item.label }),
        item.shortcut ? el('span', { class: 'btn__key', text: item.shortcut }) : null,
      ]),
    );
    if (item.description) entry.append(el('span', { class: 'menu__hint', text: item.description }));
    buttons.push(entry);
    node.appendChild(entry);
  }

  document.body.appendChild(node);

  const rect = anchor.getBoundingClientRect();
  const height = node.offsetHeight;
  const below = window.innerHeight - rect.bottom;
  node.style.top = below >= height + 8 ? `${rect.bottom + 4}px` : `${Math.max(8, rect.top - height - 4)}px`;
  // Right-aligned to the anchor, then pulled back inside the viewport.
  const left = Math.min(rect.right - node.offsetWidth, window.innerWidth - node.offsetWidth - 8);
  node.style.left = `${Math.max(8, left)}px`;

  anchor.setAttribute('aria-expanded', 'true');
  buttons[0]?.focus();

  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
}

export interface SplitButtonOptions extends ButtonOptions {
  /** Accessible name for the caret half. */
  menuLabel: string;
  /** Built on open, so the menu can reflect the document that is active now. */
  items(): MenuItem[];
}

/**
 * A primary action with a caret beside it for its variants.
 *
 * Two real buttons rather than one with a hit-test: the common case (Save)
 * stays a single click and a single tab stop's worth of muscle memory, and the
 * variants stay reachable by keyboard without learning a modifier.
 */
export function splitButton(options: SplitButtonOptions): HTMLElement {
  const main = button(options);
  main.classList.add('splitbtn__main');

  const toggle = el('button', {
    class: 'btn splitbtn__toggle',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': options.menuLabel,
    onclick: () => openMenu(toggle, options.items()),
  }) as HTMLButtonElement;
  setHint(toggle, options.menuLabel);
  toggle.appendChild(icon('caret', 13));

  return el('div', { class: 'splitbtn' }, [main, toggle]);
}

/** Announces a message to screen readers without changing the visual layout. */
export function announce(message: string): void {
  let region = document.getElementById('bs-live');
  if (!region) {
    region = el('div', { id: 'bs-live', class: 'visually-hidden', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  region.textContent = message;
}
