/**
 * Modal dialogs: export, fonts, legacy export, and confirmations.
 */

import { EXPORT_FORMATS, type ExportFormat } from '@betterscad/engine';
import { button, clear, el } from './dom.js';
import type { CatalogEntry } from '../files/font-library.js';

function shell(title: string, body: HTMLElement, footer: HTMLElement[]): HTMLDialogElement {
  const dialog = el('dialog', {}, [
    el('div', { class: 'dialog__header', text: title }),
    el('div', { class: 'dialog__body' }, [body]),
    el('div', { class: 'dialog__footer' }, footer),
  ]) as HTMLDialogElement;
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  // Clicking the backdrop dismisses, matching the command palette.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

// ---------------------------------------------------------------------------

export interface ExportChoice {
  format: ExportFormat;
  filename: string;
}

/** Export dialog (spec feature 10). Resolves to `undefined` when cancelled. */
export function showExportDialog(
  baseName: string,
  dimension: 2 | 3 | 0,
): Promise<ExportChoice | undefined> {
  return new Promise((resolve) => {
    // Offer the formats that match what was actually rendered first, but keep
    // the rest visible so the mismatch is explainable rather than mysterious.
    const matching = EXPORT_FORMATS.filter((f) => dimension === 0 || f.dimension === dimension);
    const other = EXPORT_FORMATS.filter((f) => !matching.includes(f));

    let selected: ExportFormat = matching[0]?.format ?? 'stl';

    const filenameInput = el('input', {
      type: 'text',
      value: `${baseName}.${EXPORT_FORMATS.find((f) => f.format === selected)?.extension ?? 'stl'}`,
      'aria-label': 'File name',
      style: 'width: 100%; padding: 6px 8px;',
    });

    const setFormat = (format: ExportFormat): void => {
      selected = format;
      const extension = EXPORT_FORMATS.find((f) => f.format === format)?.extension ?? 'stl';
      filenameInput.value = `${filenameInput.value.replace(/\.[^.]*$/, '')}.${extension}`;
    };

    const list = el('div', { class: 'fontlist' });
    const addOption = (descriptor: (typeof EXPORT_FORMATS)[number], dimmed: boolean): void => {
      const radio = el('input', {
        type: 'radio',
        name: 'export-format',
        value: descriptor.format,
        checked: descriptor.format === selected,
        onchange: () => setFormat(descriptor.format),
      });
      list.appendChild(
        el('label', { class: 'fontlist__item', style: dimmed ? 'opacity: .55' : undefined }, [
          el('span', {}, [radio, document.createTextNode(` ${descriptor.label}`)]),
          el('span', {
            class: 'fontlist__meta',
            text: `.${descriptor.extension} · ${descriptor.dimension}D`,
          }),
        ]),
      );
    };

    for (const descriptor of matching) addOption(descriptor, false);
    if (other.length > 0 && matching.length > 0) {
      list.appendChild(
        el('p', {
          class: 'param__hint',
          text: `This model rendered as ${dimension}D. The formats below are for ${dimension === 3 ? '2D' : '3D'} geometry.`,
        }),
      );
      for (const descriptor of other) addOption(descriptor, true);
    }

    const body = el('div', {}, [
      list,
      el('label', { style: 'display:block; margin-top: 16px;' }, [
        el('div', { class: 'param__hint', text: 'File name' }),
        filenameInput,
      ]),
    ]);

    const dialog = shell('Export model', body, [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
      button({
        label: 'Export',
        variant: 'primary',
        onClick: () => {
          resolved = { format: selected, filename: filenameInput.value.trim() || `${baseName}.stl` };
          dialog.close();
        },
      }),
    ]);

    let resolved: ExportChoice | undefined;
    dialog.addEventListener('close', () => resolve(resolved));
    dialog.showModal();
  });
}

// ---------------------------------------------------------------------------

export interface FontDialogCallbacks {
  loadCatalogFont(entry: CatalogEntry): Promise<void>;
  loadFromDisk(): Promise<void>;
  loadSystemFonts(): Promise<string[]>;
  clearCache(): Promise<void>;
}

/** Font manager (spec feature 23). */
export function showFontDialog(
  loadedFamilies: string[],
  catalog: CatalogEntry[],
  callbacks: FontDialogCallbacks,
): HTMLDialogElement {
  const loaded = new Set(loadedFamilies);
  const list = el('div', { class: 'fontlist' });
  const search = el('input', {
    type: 'text',
    placeholder: 'Search families…',
    'aria-label': 'Search font families',
    style: 'width: 100%; padding: 6px 8px; margin-bottom: 12px;',
  });

  const paint = (): void => {
    clear(list);
    const query = search.value.trim().toLowerCase();
    const matches = catalog.filter((entry) => entry.family.toLowerCase().includes(query));

    if (matches.length === 0) {
      list.appendChild(el('p', { class: 'panel__empty', text: 'No matching families.' }));
      return;
    }

    for (const entry of matches.slice(0, 200)) {
      const isLoaded = loaded.has(entry.family);
      const item = el(
        'button',
        {
          class: 'fontlist__item',
          type: 'button',
          disabled: isLoaded,
          onclick: async () => {
            item.disabled = true;
            const state = item.querySelector('.fontlist__state');
            if (state) state.textContent = 'Loading…';
            try {
              await callbacks.loadCatalogFont(entry);
              loaded.add(entry.family);
              if (state) state.textContent = 'Loaded';
            } catch (err) {
              if (state) state.textContent = err instanceof Error ? err.message : 'Failed';
              item.disabled = false;
            }
          },
        },
        [
          el('span', {}, [
            el('div', { text: entry.family }),
            el('div', { class: 'fontlist__meta', text: `${entry.license}${entry.variable ? ' · variable' : ''}` }),
          ]),
          el('span', { class: 'fontlist__state', text: isLoaded ? 'Loaded' : 'Download' }),
        ],
      );
      list.appendChild(item);
    }
  };

  search.addEventListener('input', paint);
  paint();

  const systemStatus = el('p', { class: 'param__hint', text: '' });

  const body = el('div', {}, [
    el('p', {
      class: 'param__hint',
      text:
        'Fonts are used by text(). A few families ship with the app for offline use; ' +
        'anything you download here is cached in your browser and stays available offline.',
    }),
    el('div', { class: 'toolbar__group', style: 'margin: 12px 0;' }, [
      button({
        label: 'Load font file…',
        iconName: 'open',
        onClick: () => void callbacks.loadFromDisk().then(paint),
      }),
      button({
        label: 'Use system fonts',
        title: 'Requires permission; supported in Chrome and Edge',
        onClick: async () => {
          systemStatus.textContent = 'Requesting access…';
          const families = await callbacks.loadSystemFonts();
          systemStatus.textContent =
            families.length > 0
              ? `Loaded ${families.length} system famil${families.length === 1 ? 'y' : 'ies'}.`
              : 'This browser does not expose system fonts. Load a font file instead.';
          for (const family of families) loaded.add(family);
          paint();
        },
      }),
    ]),
    systemStatus,
    search,
    list,
  ]);

  const dialog = shell('Fonts', body, [
    button({
      label: 'Clear cache',
      onClick: () => void callbacks.clearCache(),
    }),
    button({ label: 'Done', variant: 'primary', onClick: () => dialog.close() }),
  ]);

  dialog.showModal();
  return dialog;
}

// ---------------------------------------------------------------------------

export function showConfirm(
  title: string,
  message: string,
  confirmLabel = 'Confirm',
): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const dialog = shell(title, el('p', { text: message, style: 'margin:0' }), [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
      button({
        label: confirmLabel,
        variant: 'primary',
        onClick: () => {
          result = true;
          dialog.close();
        },
      }),
    ]);
    dialog.addEventListener('close', () => resolve(result));
    dialog.showModal();
  });
}

/** Reports what a legacy `.scad` export rewrote (spec feature 21). */
export function showLegacyExportDialog(
  rewrites: string[],
  onConfirm: () => void,
): void {
  const body = el('div', {}, [
    el('p', {
      style: 'margin-top:0',
      text:
        rewrites.length > 0
          ? 'This file uses BetterSCAD extensions. They will be rewritten so the exported file opens in stock OpenSCAD:'
          : 'This file uses only stock OpenSCAD constructs, so the export is a straight copy.',
    }),
    rewrites.length > 0
      ? el(
          'ul',
          { style: 'margin: 8px 0 0; padding-left: 20px;' },
          rewrites.map((r) => el('li', { text: r })),
        )
      : null,
  ]);

  const dialog = shell('Export as legacy .scad', body, [
    button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
    button({
      label: 'Export',
      variant: 'primary',
      onClick: () => {
        dialog.close();
        onConfirm();
      },
    }),
  ]);
  dialog.showModal();
}

export function showAboutDialog(engineVersion: string): void {
  const body = el('div', {}, [
    el('img', {
      src: './betterscad-logo-dark.svg',
      alt: 'BetterSCAD',
      width: '300',
      style: 'display:block; margin-bottom: 16px;',
    }),
    el('p', {
      style: 'margin-top:0',
      text:
        'A local-first, browser-based CAD editor with full OpenSCAD language compatibility. ' +
        'Everything — parsing, geometry and file access — runs on your machine. Nothing is uploaded.',
    }),
    el('dl', { style: 'display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:16px 0 0;' }, [
      el('dt', { text: 'Engine' }),
      el('dd', { style: 'margin:0', text: engineVersion }),
      el('dt', { text: 'CSG kernel' }),
      el('dd', { style: 'margin:0', text: 'Manifold (Apache-2.0)' }),
      el('dt', { text: 'Licence' }),
      el('dd', { style: 'margin:0', text: 'MIT' }),
    ]),
  ]);

  const dialog = shell('About BetterSCAD', body, [
    button({ label: 'Close', variant: 'primary', onClick: () => dialog.close() }),
  ]);
  dialog.showModal();
}
