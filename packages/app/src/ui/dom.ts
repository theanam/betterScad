/**
 * Small DOM helpers.
 *
 * The app builds its UI imperatively rather than with a framework: it is a
 * handful of long-lived panels around an editor and a canvas, and a framework's
 * bundle cost buys nothing here (spec feature 1: a small static site).
 */

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
  return value.toFixed(digits).replace(/\.?0+$/, '');
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
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
};

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
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

export interface ButtonOptions {
  label?: string;
  title?: string;
  iconName?: string;
  variant?: 'default' | 'primary' | 'ghost';
  shortcut?: string;
  onClick(): void;
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const classes = ['btn'];
  if (options.variant === 'primary') classes.push('btn--primary');
  if (options.variant === 'ghost') classes.push('btn--ghost');

  const node = el('button', {
    class: classes.join(' '),
    type: 'button',
    title: options.shortcut ? `${options.title ?? options.label ?? ''} (${options.shortcut})` : options.title ?? options.label,
    'aria-label': options.label ?? options.title,
    onclick: () => options.onClick(),
  });

  if (options.iconName) node.appendChild(icon(options.iconName));
  if (options.label) node.appendChild(el('span', { text: options.label }));
  return node;
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
