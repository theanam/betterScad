/**
 * Hover hints for controls that show only an icon.
 *
 * The native `title` attribute is not good enough here: it waits about a
 * second, cannot be styled to match the app, and never appears for keyboard
 * users. This is a single delegated tooltip driven by `data-hint`, so any
 * control can opt in by setting one attribute and nothing has to be wired up
 * per call site.
 *
 * `data-hint` is presentation only. The accessible name still comes from
 * `aria-label`, so screen readers are unaffected by any of this.
 */

const SHOW_DELAY_MS = 320;
/** Once one hint is up, moving to a neighbouring control should feel instant. */
const CHAINED_DELAY_MS = 60;
const GAP = 8;

let tip: HTMLElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let current: HTMLElement | undefined;
let recentlyShown = false;
let recentTimer: ReturnType<typeof setTimeout> | undefined;

function ensureElement(): HTMLElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'hint';
    // Purely decorative: the control it describes is already labelled.
    tip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tip);
  }
  return tip;
}

function place(target: HTMLElement, text: string): void {
  const node = ensureElement();
  node.textContent = text;
  node.classList.add('hint--visible');

  const anchor = target.getBoundingClientRect();
  const size = node.getBoundingClientRect();

  // Prefer below; flip above when the control sits near the bottom edge.
  const below = anchor.bottom + GAP;
  const above = anchor.top - size.height - GAP;
  const top = below + size.height <= window.innerHeight - 4 ? below : Math.max(4, above);

  // Centre on the control, then clamp so it never runs off either edge.
  const ideal = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.min(Math.max(4, ideal), window.innerWidth - size.width - 4);

  node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function show(target: HTMLElement): void {
  const text = target.dataset.hint;
  if (!text) return;
  current = target;
  place(target, text);

  recentlyShown = true;
  if (recentTimer) clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    recentlyShown = false;
  }, 600);
}

function hide(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  current = undefined;
  tip?.classList.remove('hint--visible');
}

function schedule(target: HTMLElement): void {
  if (target === current) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => show(target), recentlyShown ? CHAINED_DELAY_MS : SHOW_DELAY_MS);
}

function hintTarget(node: EventTarget | null): HTMLElement | undefined {
  if (!(node instanceof Element)) return undefined;
  const found = node.closest<HTMLElement>('[data-hint]');
  return found ?? undefined;
}

/** Installs the delegated listeners. Safe to call once, at boot. */
export function installTooltips(): void {
  document.addEventListener('pointerover', (event) => {
    // Touch has no hover, and a hint that appears on tap just covers the UI.
    if (event.pointerType === 'touch') return;
    const target = hintTarget(event.target);
    if (target) schedule(target);
    else hide();
  });

  document.addEventListener('pointerout', (event) => {
    const target = hintTarget(event.target);
    if (target && target === current) hide();
    else if (target) {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  });

  // Acting on a control makes its hint redundant and usually in the way.
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });

  // Keyboard users get the same hints, which `title` never gave them.
  document.addEventListener('focusin', (event) => {
    const target = hintTarget(event.target);
    if (target && target.matches(':focus-visible')) show(target);
  });
  document.addEventListener('focusout', hide);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });

  window.addEventListener('blur', hide);
}

/** Sets a control's hint, replacing the native tooltip so both never show. */
export function setHint(element: HTMLElement, text: string): void {
  element.dataset.hint = text;
  element.removeAttribute('title');
  if (!element.getAttribute('aria-label')) element.setAttribute('aria-label', text);
  // Keep a live hint in step when a toggle relabels itself under the pointer.
  if (element === current) place(element, text);
}
