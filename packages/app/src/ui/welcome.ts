/**
 * First-run welcome (spec feature 1: a small static site anyone can just open).
 *
 * Shown once, on the first visit, and reachable afterwards from the command
 * palette. It exists to answer one question — *what do I do now* — with three
 * answers and then get out of the way.
 *
 * The app boots with the sample already loaded, so this is a genuine choice
 * rather than a gate: dismissing it leaves the sample open and working. That is
 * what lets the dialog be escapable without stranding anyone on an empty editor.
 */

import { el, icon } from './dom.js';

/** Where the OpenSCAD language itself is documented. Verified 2026-09-14. */
const OPENSCAD_DOCS = {
  cheatsheet: 'https://openscad.org/cheatsheet/index.html',
  manual: 'https://en.wikibooks.org/wiki/OpenSCAD_User_Manual',
};

export interface WelcomeChoices {
  /** Keep the sample already open. */
  sample(): void;
  /** Replace it with an empty file. */
  blank(): void;
  /**
   * Open something already on disk. Omitted where the browser cannot open
   * files at all, in which case the card is not rendered — an inert third
   * option is worse than two.
   */
  openFile?(): void;
}

interface CardOptions {
  iconName: string;
  title: string;
  body: string;
  primary?: boolean;
  onSelect(): void;
}

function card(options: CardOptions): HTMLButtonElement {
  const node = el('button', {
    class: `welcomecard${options.primary ? ' welcomecard--primary' : ''}`,
    type: 'button',
    onclick: () => options.onSelect(),
  }) as HTMLButtonElement;

  node.append(
    icon(options.iconName, 20),
    el('span', { class: 'welcomecard__title', text: options.title }),
    el('span', { class: 'welcomecard__body', text: options.body }),
  );
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  return el('a', {
    class: 'welcome__link',
    href,
    target: '_blank',
    rel: 'noreferrer noopener',
    text,
  }) as HTMLAnchorElement;
}

export function showWelcome(choices: WelcomeChoices): HTMLDialogElement {
  const dialog = el('dialog', { class: 'welcome', 'aria-label': 'Welcome to BetterSCAD' }) as HTMLDialogElement;

  const choose = (run: () => void): void => {
    dialog.close();
    run();
  };

  const { openFile } = choices;

  const sampleCard = card({
    iconName: 'cube',
    title: 'Sample model',
    body: 'A parametric box with Customizer sliders.',
    primary: true,
    onSelect: () => choose(choices.sample),
  });

  dialog.append(
    el('div', { class: 'welcome__head' }, [
      el('img', { class: 'welcome__mark', src: './betterscad-mark.svg', width: '80', height: '80', alt: '' }),
      el('div', { class: 'welcome__wordmark', text: 'BetterSCAD' }),
      el('div', { class: 'welcome__tagline', text: 'Code it. See it. Print it.' }),
    ]),
    el('div', { class: 'welcome__choices' }, [
      sampleCard,
      card({
        iconName: 'plus',
        title: 'Blank file',
        body: 'Start from nothing.',
        onSelect: () => choose(choices.blank),
      }),
      openFile
        ? card({
            iconName: 'open',
            title: 'Open a file',
            body: 'A .scad or .bscad from your disk.',
            // Closing first keeps the picker's user gesture intact — it is
            // still the same click — and leaves the sample behind if the
            // picker is cancelled.
            onSelect: () => choose(openFile),
          })
        : null,
    ]),
    el('p', { class: 'welcome__compat' }, [
      el('strong', { text: 'Fully OpenSCAD-compatible.' }),
      document.createTextNode(' Existing .scad files open and render unmodified — '),
      link(OPENSCAD_DOCS.cheatsheet, 'cheat sheet'),
      document.createTextNode(', '),
      link(OPENSCAD_DOCS.manual, 'user manual'),
      document.createTextNode('.'),
    ]),
  );

  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  // Dismissing is safe — the sample is already loaded — so a backdrop click and
  // Escape both mean "the sample is fine", which is what they look like.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.showModal();
  sampleCard.focus();
  return dialog;
}
