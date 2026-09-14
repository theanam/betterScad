/**
 * Help & Reference: the whole language, browsable, with a picture of what every
 * element makes.
 *
 * A dialog rather than a panel. It is read for a minute and closed, it wants
 * more width than the editor column has, and a panel would put it in
 * competition with the Customizer and the Console for the same space — which
 * would be a poor trade for something nobody keeps open.
 *
 * All of its content comes from `src/reference/`, which also generates
 * `docs/reference.md` and every screenshot on this page. Nothing here is
 * written twice.
 */

import { IMAGE_DIR, SECTIONS, searchText } from '../reference/index.js';
import type { ReferenceEntry, ReferenceExample, ReferenceSection } from '../reference/index.js';
import { button, clear, el, icon } from './dom.js';

export interface ReferenceCallbacks {
  /** Drops an example into the editor at the cursor. */
  insert(code: string): void;
}

/** Inline Markdown, cut down to what the catalogue actually uses. */
function inline(text: string): Node[] {
  const nodes: Node[] = [];

  // Code first and separately: a backtick span is literal, so `**` inside one
  // has to survive rather than turn into emphasis.
  text.split('`').forEach((part, index) => {
    if (index % 2 === 1) {
      nodes.push(el('code', { text: part }));
      return;
    }
    // `**bold**` before `*italic*`, so the longer marker wins.
    const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/g;
    let at = 0;
    for (const match of part.matchAll(pattern)) {
      if (match.index > at) nodes.push(document.createTextNode(part.slice(at, match.index)));
      nodes.push(
        match[1] !== undefined
          ? el('strong', { text: match[1] })
          : el('em', { text: match[2] }),
      );
      at = match.index + match[0].length;
    }
    if (at < part.length) nodes.push(document.createTextNode(part.slice(at)));
  });

  return nodes;
}

function paragraph(text: string, className?: string): HTMLElement {
  return el('p', { class: className }, inline(text));
}

// ---------------------------------------------------------------------------

export function showReferenceDialog(
  callbacks: ReferenceCallbacks,
  options: { entry?: string } = {},
): HTMLDialogElement {
  // Focusable: it is a scrolling region, and without a tab stop a keyboard user
  // can reach the list and the buttons but not scroll the prose between them.
  const content = el('div', { class: 'reference__content', tabindex: '0' });
  const list = el('div', { class: 'reference__list' });
  const search = el('input', {
    class: 'reference__search',
    type: 'search',
    placeholder: 'Search the reference',
    'aria-label': 'Search the reference',
    autocomplete: 'off',
  }) as HTMLInputElement;

  let selected: string | undefined = options.entry;
  /** Section id, or undefined for all of them. */
  let scope: string | undefined;
  const buttons = new Map<string, HTMLButtonElement>();
  const tabs = el('div', { class: 'paneltabs reference__scopes', role: 'tablist' });

  const select = (id: string, { scrollNav = false } = {}): void => {
    selected = id;
    for (const [key, node] of buttons) {
      node.classList.toggle('reference__item--active', key === id);
    }
    const entry = findEntry(id);
    if (entry) {
      clear(content);
      content.appendChild(renderEntry(entry, select, callbacks));
      content.scrollTop = 0;
    }
    if (scrollNav) buttons.get(id)?.scrollIntoView({ block: 'nearest' });
  };

  const paint = (): void => {
    clear(list);
    buttons.clear();
    const query = search.value.trim().toLowerCase();
    let matches = 0;

    for (const section of SECTIONS) {
      if (scope && section.id !== scope) continue;

      const groups = section.groups
        .map((group) => ({
          group,
          entries: group.entries.filter((entry) => !query || searchText(entry).includes(query)),
        }))
        .filter(({ entries }) => entries.length > 0);
      if (groups.length === 0) continue;

      // The scope tab above already names the one section on show; repeating it
      // as a heading would just push the first group further down.
      if (!scope) list.appendChild(el('div', { class: 'reference__section', text: section.title }));

      for (const { group, entries } of groups) {
        list.appendChild(el('div', { class: 'reference__group', text: group.title }));
        for (const entry of entries) {
          matches++;
          const item = el('button', {
            class: 'reference__item',
            type: 'button',
            onclick: () => select(entry.id),
          }) as HTMLButtonElement;
          item.append(el('span', { class: 'reference__itemname', text: entry.name }));
          if (entry.extension) {
            item.append(el('span', { class: 'reference__badge', text: '+', title: 'BetterSCAD addition' }));
          }
          buttons.set(entry.id, item);
          list.appendChild(item);
        }
      }
    }

    if (matches === 0) {
      list.appendChild(el('p', { class: 'panel__empty', text: 'Nothing matches that.' }));

      // A search that finds nothing *here* but something next door is the one
      // case where "no results" is the wrong answer, so it offers the way out
      // rather than leaving the reader to work out that a filter is on.
      const elsewhere = scope
        ? SECTIONS.filter((section) => section.id !== scope)
            .flatMap((section) => section.groups)
            .flatMap((group) => group.entries)
            .filter((entry) => searchText(entry).includes(query)).length
        : 0;

      clear(content);
      content.appendChild(
        el('div', { class: 'reference__empty' }, [
          el('p', { text: `No entry in this section matches “${search.value.trim()}”.` }),
          elsewhere > 0
            ? el('div', {}, [
                el('p', {
                  class: 'reference__caption',
                  text: `${elsewhere} entr${elsewhere === 1 ? 'y' : 'ies'} elsewhere in the reference match.`,
                }),
                button({
                  label: 'Search the whole reference',
                  variant: 'primary',
                  onClick: () => setScope(undefined),
                }),
              ])
            : null,
        ]),
      );
      return;
    }

    // Keep the current entry selected when it survives the filter; otherwise
    // jump to the best remaining match, so typing never leaves the reader
    // looking at something the search has already ruled out.
    if (selected && buttons.has(selected)) select(selected);
    else select([...buttons.keys()][0]);
  };

  /**
   * Narrows the list to one section.
   *
   * The additions are the shorter half and they sit *below* seventy OpenSCAD
   * entries, so without this "what does BetterSCAD actually add?" is a question
   * you answer by scrolling to the bottom. One click is the whole point; the
   * count on the tab is the rest of the answer.
   */
  const setScope = (id: string | undefined): void => {
    scope = id;
    for (const [key, tab] of scopeTabs) {
      tab.setAttribute('aria-selected', String(key === id));
    }
    // Keep the reader where they were when the entry survives the narrowing.
    if (selected && scope && sectionOf(selected)?.id !== scope) selected = undefined;
    paint();
  };

  const scopeTabs = new Map<string | undefined, HTMLButtonElement>();
  const addScopeTab = (id: string | undefined, label: string, count: number, hint: string): void => {
    const tab = el('button', {
      class: 'paneltab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(id === undefined),
      title: hint,
      onclick: () => setScope(id),
    }) as HTMLButtonElement;
    tab.append(
      el('span', { text: label }),
      el('span', { class: 'paneltab__count', text: String(count) }),
    );
    scopeTabs.set(id, tab);
    tabs.appendChild(tab);
  };

  const countIn = (section: ReferenceSection): number =>
    section.groups.reduce((n, group) => n + group.entries.length, 0);
  const total = SECTIONS.reduce((n, section) => n + countIn(section), 0);

  addScopeTab(undefined, 'All', total, 'Every entry');
  for (const section of SECTIONS) {
    addScopeTab(
      section.id,
      section.id === 'betterscad' ? 'BetterSCAD' : section.title,
      countIn(section),
      section.blurb,
    );
  }

  search.addEventListener('input', paint);

  // Up and down move through the results without leaving the search field,
  // which is the whole point of putting the field above the list.
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const ids = [...buttons.keys()];
    const at = selected ? ids.indexOf(selected) : -1;
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    if (next >= 0 && next < ids.length) select(ids[next], { scrollNav: true });
  });

  const body = el('div', { class: 'reference' }, [
    el('div', { class: 'reference__nav' }, [
      el('div', { class: 'reference__searchwrap' }, [icon('search', 13), search]),
      list,
    ]),
    content,
  ]);

  const dialog = el('dialog', { class: 'dialog--wide' }, [
    el('div', { class: 'dialog__header reference__header' }, [
      el('span', { class: 'reference__heading', text: 'Help & Reference' }),
      tabs,
    ]),
    el('div', { class: 'dialog__body dialog__body--flush' }, [body]),
    el('div', { class: 'dialog__footer' }, [
      el('span', { class: 'reference__footnote' }, [
        ...inline('The same content is in `docs/reference.md`, generated from the same catalogue.'),
      ]),
      el('span', { class: 'toolbar__spacer' }),
      button({ label: 'Close', variant: 'primary', onClick: () => dialog.close() }),
    ]),
  ]) as HTMLDialogElement;

  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  paint();
  if (options.entry) select(options.entry, { scrollNav: true });


  dialog.showModal();
  search.focus();
  return dialog;
}

function findEntry(id: string): ReferenceEntry | undefined {
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      const found = group.entries.find((entry) => entry.id === id);
      if (found) return found;
    }
  }
  return undefined;
}

function sectionOf(id: string): ReferenceSection | undefined {
  return SECTIONS.find((section) =>
    section.groups.some((group) => group.entries.some((entry) => entry.id === id)),
  );
}

// ---------------------------------------------------------------------------
// One entry
// ---------------------------------------------------------------------------

function renderEntry(
  entry: ReferenceEntry,
  select: (id: string) => void,
  callbacks: ReferenceCallbacks,
): HTMLElement {
  const node = el('article', { class: 'reference__entry' });

  const heading = el('div', { class: 'reference__head' }, [
    el('h2', { class: 'reference__title', text: entry.name }),
  ]);
  if (entry.extension) {
    heading.appendChild(
      el('span', {
        class: 'reference__tag',
        text: 'BetterSCAD',
        title: 'Not in stock OpenSCAD. Has a defined way back to plain .scad.',
      }),
    );
  } else {
    heading.appendChild(el('span', { class: 'reference__tag reference__tag--stock', text: 'OpenSCAD' }));
  }
  node.appendChild(heading);

  if (entry.signature) {
    node.appendChild(el('pre', { class: 'reference__sig' }, [el('code', { text: entry.signature })]));
  }

  node.appendChild(paragraph(entry.plain, 'reference__plain'));

  for (const example of entry.examples ?? []) {
    node.appendChild(renderExample(example, entry, callbacks));
  }

  if (entry.params?.length) {
    const table = el('table', { class: 'reference__params' });
    for (const param of entry.params) {
      table.appendChild(
        el('tr', {}, [
          el('th', {}, [el('code', { text: param.name })]),
          el('td', {}, inline(param.description)),
        ]),
      );
    }
    node.appendChild(el('h3', { class: 'reference__subhead', text: 'Arguments' }));
    node.appendChild(table);
  }

  if (entry.details?.length) {
    node.appendChild(el('h3', { class: 'reference__subhead', text: 'Details' }));
    const details = el('div', { class: 'reference__details' });
    for (const detail of entry.details) details.appendChild(paragraph(detail));
    node.appendChild(details);
  }

  if (entry.downgrade) {
    node.appendChild(
      el('div', { class: 'reference__downgrade' }, [
        el('div', { class: 'reference__downgradehead', text: 'Saved as OpenSCAD .scad' }),
        paragraph(entry.downgrade),
      ]),
    );
  }

  if (entry.see?.length) {
    const see = el('div', { class: 'reference__see' }, [
      el('span', { class: 'reference__seelabel', text: 'See also' }),
    ]);
    for (const id of entry.see) {
      const target = findEntry(id);
      if (!target) continue;
      see.appendChild(
        el('button', {
          class: 'reference__link',
          type: 'button',
          onclick: () => select(id),
          text: target.name,
        }),
      );
    }
    if (see.childElementCount > 1) node.appendChild(see);
  }

  const section = sectionOf(entry.id);
  if (section) {
    node.appendChild(
      el('p', { class: 'reference__origin' }, inline(section.blurb)),
    );
  }

  return node;
}

function renderExample(
  example: ReferenceExample,
  entry: ReferenceEntry,
  callbacks: ReferenceCallbacks,
): HTMLElement {
  const actions = el('div', { class: 'reference__exampleactions' }, [
    button({
      label: 'Copy',
      variant: 'ghost',
      title: 'Copy this example to the clipboard',
      onClick: () => void navigator.clipboard?.writeText(example.code),
    }),
    button({
      label: 'Insert',
      title: 'Insert this example at the cursor',
      onClick: () => callbacks.insert(example.code),
    }),
  ]);

  const node = el('section', { class: 'reference__example' }, [
    el('div', { class: 'reference__codewrap' }, [
      el('pre', { class: 'reference__code' }, [el('code', { text: example.code })]),
      actions,
    ]),
  ]);

  if (example.image) {
    node.appendChild(
      el('img', {
        class: 'reference__shot',
        // Lazily, and never precached: sixty screenshots is a lot to make
        // someone download to open a dialog they may not open.
        loading: 'lazy',
        decoding: 'async',
        src: `./${IMAGE_DIR}/${example.image}.png`,
        alt: example.caption ?? `The result of the ${entry.name} example`,
      }),
    );
  }

  if (example.output) {
    node.appendChild(el('pre', { class: 'reference__output' }, [el('code', { text: example.output })]));
  }

  if (example.caption) node.appendChild(paragraph(example.caption, 'reference__caption'));

  return node;
}
