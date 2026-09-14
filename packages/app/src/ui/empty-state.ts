/**
 * What the app looks like with no document open.
 *
 * Reachable only by closing the last tab. Before this, closing it reopened the
 * sample — which made the last tab the one tab you could not close, and quietly
 * replaced whatever you had been doing with a file you did not ask for.
 *
 * Two halves, matching the two panes. The editor side offers the same three
 * ways back in as the welcome screen. The viewport side says what that space is
 * for, because an empty panel with a grid in it looks like a render that failed.
 */

import { choiceCards, type StartChoices } from './choices.js';
import { el } from './dom.js';

/** The editor pane's empty state: a heading and the three offers. */
export function editorEmptyState(choices: StartChoices): HTMLElement {
  return el('div', { class: 'empty empty--editor' }, [
    el('div', { class: 'empty__inner' }, [
      el('h2', { class: 'empty__title', text: 'No file open' }),
      el('p', { class: 'empty__body', text: 'Pick up where you left off, or start something new.' }),
      el('div', { class: 'empty__choices' }, choiceCards(choices, false)),
    ]),
  ]);
}

/**
 * The viewport's empty state.
 *
 * An outlined cube rather than the brand mark: this is a placeholder for a
 * model, and putting the logo here would read as branding sitting where the
 * user's own work belongs. Drawn as a wireframe, with the hidden back edges
 * faint, so it reads as *a shape that is not there yet*.
 */
export function viewportEmptyState(): HTMLElement {
  const svg = `
    <svg viewBox="0 0 120 120" width="108" height="108" aria-hidden="true" fill="none"
         stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <!-- The three edges hidden behind the solid, drawn faint. -->
      <g opacity="0.28" stroke-width="1.6" stroke-dasharray="3 4">
        <path d="M18 34 L60 58 L102 34" />
        <path d="M60 58 L60 106" />
      </g>
      <!-- The silhouette and the three edges that meet at the near corner. -->
      <g stroke-width="2">
        <path d="M60 10 L102 34 L102 82 L60 106 L18 82 L18 34 Z" />
        <path d="M60 10 L60 58" opacity="0" />
      </g>
      <g stroke-width="1.6" opacity="0.55">
        <path d="M18 34 L60 10 L102 34" />
      </g>
    </svg>`;

  return el('div', { class: 'empty empty--viewport' }, [
    el('div', { class: 'empty__inner' }, [
      el('div', { class: 'empty__art', html: svg }),
      el('p', { class: 'empty__caption', text: 'Your model appears here' }),
      el('p', { class: 'empty__body', text: 'Open or create a file to see it rendered.' }),
    ]),
  ]);
}
