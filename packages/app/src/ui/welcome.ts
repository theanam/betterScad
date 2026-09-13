/**
 * First-run welcome (spec feature 1: a small static site anyone can just open).
 *
 * Shown once, on the first visit, and reachable afterwards from the command
 * palette. It exists to answer the two questions a new arrival actually has —
 * *what is this* and *what do I do now* — and then get out of the way.
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
  home: 'https://openscad.org/documentation.html',
};

export interface WelcomeChoices {
  /** Keep the sample already open. */
  sample(): void;
  /** Replace it with an empty file. */
  blank(): void;
}

interface CardOptions {
  eyebrow: string;
  title: string;
  body: string;
  /** A few lines of what the file will actually contain. */
  preview: string[];
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
    el('span', { class: 'welcomecard__eyebrow', text: options.eyebrow }),
    el('span', { class: 'welcomecard__title', text: options.title }),
    el('span', { class: 'welcomecard__body', text: options.body }),
    // A sample of the actual file. On a tool whose subject is code, showing the
    // code is a more honest preview than any thumbnail would be.
    el('span', { class: 'welcomecard__preview', 'aria-hidden': 'true' }, [
      el('code', { text: options.preview.join('\n') }),
    ]),
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

  const sampleCard = card({
    eyebrow: 'Sample',
    title: 'Open the sample model',
    body:
      'A parametric box with a sphere cut out of it, wired to Customizer sliders. ' +
      'It renders the moment you close this, and every part of it is editable.',
    preview: ['size = 40;   // [10:80]', 'difference() {', '  rounded_box(size, fillet);', '  sphere(d = bite);', '}'],
    primary: true,
    onSelect: () => choose(choices.sample),
  });

  const blankCard = card({
    eyebrow: 'Blank',
    title: 'Start from an empty file',
    body: 'Nothing but a cube to delete. Use this if you already know what you are building.',
    preview: ['// New model', '', 'cube(10, center = true);'],
    onSelect: () => choose(choices.blank),
  });

  const facts = el('ul', { class: 'welcome__facts' }, [
    el('li', {}, [icon('save', 13), el('span', { text: 'Files open and save straight from your disk' })]),
    el('li', {}, [icon('render', 13), el('span', { text: 'F5 previews, F6 renders what Export writes' })]),
    el('li', {}, [icon('console', 13), el('span', { text: 'Runs offline — nothing is uploaded, ever' })]),
  ]);

  const compatibility = el('p', { class: 'welcome__compat' }, [
    el('strong', { text: 'Fully OpenSCAD-compatible.' }),
    document.createTextNode(
      ' Existing .scad files open and render unmodified, so the language to learn is ' +
        'OpenSCAD’s own: ',
    ),
    link(OPENSCAD_DOCS.cheatsheet, 'cheat sheet'),
    document.createTextNode(' · '),
    link(OPENSCAD_DOCS.manual, 'user manual'),
    document.createTextNode(' · '),
    link(OPENSCAD_DOCS.home, 'all documentation'),
    document.createTextNode(
      '. BetterSCAD adds a little on top — and every addition has a defined rewrite ' +
        'back to stock .scad, so nothing you write here can strand you.',
    ),
  ]);

  dialog.append(
    el('div', { class: 'welcome__head' }, [
      el('img', { class: 'welcome__mark', src: './betterscad-mark.svg', width: '52', height: '52', alt: '' }),
      el('div', {}, [
        el('div', { class: 'welcome__wordmark', text: 'BetterSCAD' }),
        el('div', { class: 'welcome__tagline', text: 'Code it. See it. Print it.' }),
      ]),
    ]),
    el('p', { class: 'welcome__lede', text: 'A parametric CAD editor that runs entirely in this browser tab.' }),
    el('div', { class: 'welcome__choices' }, [sampleCard, blankCard]),
    facts,
    compatibility,
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
