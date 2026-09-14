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

import { choiceCards, type StartChoices } from './choices.js';
import { el } from './dom.js';

/** Where the OpenSCAD language itself is documented. Verified 2026-09-14. */
const OPENSCAD_DOCS = {
  cheatsheet: 'https://openscad.org/cheatsheet/index.html',
  manual: 'https://en.wikibooks.org/wiki/OpenSCAD_User_Manual',
};

export type WelcomeChoices = StartChoices;

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

  // Wrapped so every card closes the dialog before acting. The cards are shared
  // with the empty state, which has no dialog to close — hence the wrapping
  // here rather than inside them.
  const cards = choiceCards(
    {
      sample: () => choose(choices.sample),
      blank: () => choose(choices.blank),
      openFile: choices.openFile && (() => choose(choices.openFile!)),
    },
    true,
  );

  dialog.append(
    el('div', { class: 'welcome__head' }, [
      el('img', { class: 'welcome__mark', src: './betterscad-mark.svg', width: '80', height: '80', alt: '' }),
      el('div', { class: 'welcome__wordmark', text: 'BetterSCAD' }),
      el('div', { class: 'welcome__tagline', text: 'Code it. See it. Print it.' }),
    ]),
    el('div', { class: 'welcome__choices' }, cards),
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
  cards[0]?.focus();
  return dialog;
}
