/**
 * The three ways into a document, shared by the welcome screen and the empty
 * state.
 *
 * They are the same three offers in both places, so they are the same code in
 * both places: a card that looked subtly different on one of them would read as
 * a different set of options rather than the same one, twice.
 */

import { el, icon } from './dom.js';

export interface StartChoices {
  /** Open the sample model. */
  sample(): void;
  /** Start from an empty file. */
  blank(): void;
  /**
   * Open something already on disk. Omitted where the browser cannot open files
   * at all, in which case the card is not rendered — an inert option is worse
   * than one fewer.
   */
  openFile?(): void;
}

export interface ChoiceCardOptions {
  iconName: string;
  title: string;
  body: string;
  primary?: boolean;
  onSelect(): void;
}

export function choiceCard(options: ChoiceCardOptions): HTMLButtonElement {
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

/**
 * The three cards, in order.
 *
 * `sampleFirst` marks the sample as the recommended path on the welcome screen.
 * The empty state leaves it unmarked: by then the reader has used the app and
 * has a reason of their own for being here, so steering them is presumptuous.
 */
export function choiceCards(choices: StartChoices, sampleFirst: boolean): HTMLButtonElement[] {
  const cards = [
    choiceCard({
      iconName: 'cube',
      title: 'Sample model',
      body: 'A parametric box with Customizer sliders.',
      primary: sampleFirst,
      onSelect: () => choices.sample(),
    }),
    choiceCard({
      iconName: 'plus',
      title: 'Blank file',
      body: 'Start from nothing.',
      onSelect: () => choices.blank(),
    }),
  ];

  const { openFile } = choices;
  if (openFile) {
    cards.push(
      choiceCard({
        iconName: 'open',
        title: 'Open a file',
        body: 'A .scad or .bscad from your disk.',
        onSelect: () => openFile(),
      }),
    );
  }
  return cards;
}
