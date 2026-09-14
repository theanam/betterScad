/**
 * Modal dialogs: export, fonts, legacy export, and confirmations.
 */

import { EXPORT_FORMATS, type ExportFormat, type ExtensionUse } from '@betterscad/engine';
import { button, clear, el } from './dom.js';
import { extensionList } from './extension-list.js';
import type { CatalogEntry } from '../files/font-library.js';

function shell(
  title: string,
  body: HTMLElement,
  footer: HTMLElement[],
  bodyClass?: string,
): HTMLDialogElement {
  const dialog = el('dialog', {}, [
    el('div', { class: 'dialog__header', text: title }),
    el('div', { class: `dialog__body${bodyClass ? ` ${bodyClass}` : ''}` }, [body]),
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

    const extensionFor = (format: ExportFormat): string =>
      EXPORT_FORMATS.find((f) => f.format === format)?.extension ?? 'stl';

    const filenameInput = el('input', {
      type: 'text',
      value: `${baseName}.${extensionFor(selected)}`,
      'aria-label': 'File name',
      style: 'width: 100%; padding: 6px 8px;',
    });

    const setFormat = (format: ExportFormat): void => {
      selected = format;
      filenameInput.value = `${filenameInput.value.replace(/\.[^.]*$/, '')}.${extensionFor(format)}`;
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

    // The formats scroll; the file name stays put. Nesting the scroller rather
    // than letting the dialog body scroll is what keeps the one editable field
    // on screen however many formats are listed.
    const body = el('div', { class: 'export__body' }, [
      el('div', { class: 'export__scroll' }, [list]),
      el('label', { class: 'export__filename' }, [
        el('div', { class: 'param__hint', text: 'File name' }),
        filenameInput,
      ]),
    ]);

    const dialog = shell(
      'Export model',
      body,
      [
        button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
        button({
          label: 'Export',
          variant: 'primary',
          onClick: () => {
            resolved = { format: selected, filename: filenameInput.value.trim() || `${baseName}.stl` };
            dialog.close();
          },
        }),
      ],
      'dialog__body--flush',
    );

    let resolved: ExportChoice | undefined;
    dialog.addEventListener('close', () => resolve(resolved));
    dialog.showModal();
  });
}

// ---------------------------------------------------------------------------

export interface FontDialogCallbacks {
  /** Downloads, caches and registers a catalogue font. Resolves to its bytes. */
  loadCatalogFont(entry: CatalogEntry): Promise<Uint8Array>;
  loadFromDisk(): Promise<void>;
  loadSystemFonts(): Promise<string[]>;
  clearCache(): Promise<void>;
  /** Bytes already on hand for a family, from the app or the IndexedDB cache. */
  bytesFor(family: string): Promise<Uint8Array | undefined>;
  /** Inserts text at the editor cursor. */
  insert(text: string): void;
}

const DEFAULT_SAMPLE = 'Handgloves 123';

/**
 * Registers a font for *preview only*, under a namespaced CSS family.
 *
 * The prefix keeps these from colliding with a real installed font of the same
 * name, so a preview always shows the face BetterSCAD will actually use for
 * geometry rather than whatever the OS happens to have.
 */
const previewFamilies = new Map<string, string>();

async function registerPreviewFont(family: string, data: Uint8Array): Promise<string | undefined> {
  const cached = previewFamilies.get(family);
  if (cached) return cached;

  const cssFamily = `bsprev-${family.replace(/[^\w-]/g, '-')}`;
  try {
    // `slice()` detaches a copy: the caller may transfer the original buffer to
    // the worker, which would leave FontFace reading a neutered ArrayBuffer.
    const face = new FontFace(cssFamily, data.slice().buffer as ArrayBuffer);
    await face.load();
    document.fonts.add(face);
    previewFamilies.set(family, cssFamily);
    return cssFamily;
  } catch {
    // A face the browser cannot render still works for geometry, so failing to
    // preview is not an error worth surfacing.
    return undefined;
  }
}

/** Font manager (spec feature 23). */
export function showFontDialog(
  loadedFaces: { family: string; style: string }[],
  catalog: CatalogEntry[],
  callbacks: FontDialogCallbacks,
): HTMLDialogElement {
  const loaded = new Map<string, string[]>();
  for (const face of loadedFaces) {
    const styles = loaded.get(face.family) ?? [];
    if (!styles.includes(face.style)) styles.push(face.style);
    loaded.set(face.family, styles);
  }

  const list = el('div', { class: 'fontlist' });

  const search = el('input', {
    type: 'text',
    class: 'font__field',
    placeholder: 'Search families…',
    'aria-label': 'Search font families',
  });

  const sample = el('input', {
    type: 'text',
    class: 'font__field',
    value: DEFAULT_SAMPLE,
    'aria-label': 'Preview text',
    placeholder: 'Preview text…',
  });

  const sampleText = (): string => sample.value || DEFAULT_SAMPLE;

  // Retitle every rendered preview in place, rather than rebuilding the list.
  sample.addEventListener('input', () => {
    for (const node of list.querySelectorAll('.font__preview')) {
      node.textContent = sampleText();
    }
  });

  const status = el('p', { class: 'param__hint', text: '' });

  function specFor(family: string, style?: string): string {
    if (!style || style.toLowerCase() === 'regular') return family;
    return `${family}:style=${style}`;
  }

  /** The `font = "…"` snippet, with Copy and Insert beside it. */
  function specRow(family: string, style?: string): HTMLElement {
    const spec = specFor(family, style);
    const snippet = `font = ${JSON.stringify(spec)}`;

    const copy = button({
      label: 'Copy',
      title: `Copy ${snippet}`,
      onClick: () => {
        void navigator.clipboard
          .writeText(snippet)
          .then(() => {
            copy.replaceChildren(document.createTextNode('Copied'));
            setTimeout(() => copy.replaceChildren(document.createTextNode('Copy')), 1400);
          })
          .catch(() => {
            // Clipboard access can be denied; the text is selectable regardless.
            status.textContent = 'Could not reach the clipboard — select the snippet and copy it.';
          });
      },
    });

    const insert = button({
      label: 'Insert',
      variant: 'primary',
      title: `Insert ${snippet} at the cursor`,
      onClick: () => {
        callbacks.insert(snippet);
        status.textContent = `Inserted ${snippet}`;
      },
    });

    return el('div', { class: 'font__spec' }, [
      el('code', { class: 'font__snippet', title: 'The argument text() expects', text: snippet }),
      el('div', { class: 'font__specactions' }, [copy, insert]),
    ]);
  }

  function row(entry: CatalogEntry | { family: string; license?: string }): HTMLElement {
    const family = entry.family;
    const styles = loaded.get(family);
    const isLoaded = !!styles;

    const preview = el('div', {
      class: 'font__preview',
      text: sampleText(),
      // Falls back to the UI font until the real face is registered.
      style: 'font-family: var(--bs-font-ui)',
    });

    const meta = el('span', {
      class: 'fontlist__meta',
      text: [
        'license' in entry && entry.license ? entry.license : null,
        'variable' in entry && (entry as CatalogEntry).variable ? 'variable' : null,
        isLoaded && styles.length > 1 ? `${styles.length} styles` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });

    const actions = el('div', { class: 'font__actions' });
    const body = el('div', { class: 'font__body' }, [
      el('div', { class: 'font__head' }, [
        el('span', { class: 'font__family', text: family }),
        meta,
        el('span', { class: 'toolbar__spacer' }),
        actions,
      ]),
      preview,
    ]);

    const item = el('div', { class: 'font__item' }, [body]);

    /** Swaps the preview onto the real face and reveals the spec snippet. */
    const applyPreview = async (data: Uint8Array): Promise<void> => {
      const cssFamily = await registerPreviewFont(family, data);
      if (cssFamily) preview.style.fontFamily = `'${cssFamily}', var(--bs-font-ui)`;
    };

    const showSpecs = (): void => {
      const available = loaded.get(family) ?? ['Regular'];
      for (const style of available) body.appendChild(specRow(family, style));
    };

    if (isLoaded) {
      actions.appendChild(el('span', { class: 'fontlist__state', text: 'Loaded' }));
      showSpecs();
      // Bytes may be in the IndexedDB cache or bundled; either way, preview it.
      void callbacks.bytesFor(family).then((data) => {
        if (data) void applyPreview(data);
      });
    } else {
      const load = button({
        label: 'Load',
        iconName: 'download',
        title: `Download ${family} and make it available to text()`,
        onClick: async () => {
          load.disabled = true;
          load.replaceChildren(document.createTextNode('Loading…'));
          try {
            const data = await callbacks.loadCatalogFont(entry as CatalogEntry);
            loaded.set(family, ['Regular']);
            actions.replaceChildren(el('span', { class: 'fontlist__state', text: 'Loaded' }));
            await applyPreview(data);
            showSpecs();
          } catch (err) {
            load.disabled = false;
            load.replaceChildren(document.createTextNode('Retry'));
            status.textContent = err instanceof Error ? err.message : String(err);
          }
        },
      });
      actions.appendChild(load);

      // If it is already cached from a previous session, preview it for free.
      void callbacks.bytesFor(family).then((data) => {
        if (data) void applyPreview(data);
      });
    }

    return item;
  }

  const paint = (): void => {
    clear(list);
    const query = search.value.trim().toLowerCase();

    // Loaded families first — they are the ones usable right now — then the
    // rest of the catalogue.
    const catalogued = new Set(catalog.map((e) => e.family));
    const extras = [...loaded.keys()]
      .filter((family) => !catalogued.has(family))
      .map((family) => ({ family }));

    const entries = [...extras, ...catalog].filter((e) => e.family.toLowerCase().includes(query));
    entries.sort((a, b) => {
      const rank = (f: string): number => (loaded.has(f) ? 0 : 1);
      return rank(a.family) - rank(b.family) || a.family.localeCompare(b.family);
    });

    if (entries.length === 0) {
      list.appendChild(el('p', { class: 'panel__empty', text: 'No matching families.' }));
      return;
    }
    for (const entry of entries.slice(0, 200)) list.appendChild(row(entry));
  };

  search.addEventListener('input', paint);
  paint();

  const body = el('div', {}, [
    el('p', {
      class: 'param__hint',
      style: 'margin-top: 0',
      text:
        'Fonts are used by text(). A few ship with the app for offline use; anything you ' +
        'load here is cached in your browser and stays available offline.',
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
          status.textContent = 'Requesting access…';
          const families = await callbacks.loadSystemFonts();
          status.textContent =
            families.length > 0
              ? `Loaded ${families.length} system famil${families.length === 1 ? 'y' : 'ies'}.`
              : 'This browser does not expose system fonts. Load a font file instead.';
          for (const family of families) {
            if (!loaded.has(family)) loaded.set(family, ['Regular']);
          }
          paint();
        },
      }),
    ]),
    status,
    el('div', { class: 'font__filters' }, [
      el('label', { class: 'font__filter' }, [
        el('span', { class: 'param__hint', text: 'Search' }),
        search,
      ]),
      el('label', { class: 'font__filter' }, [
        el('span', { class: 'param__hint', text: 'Preview text' }),
        sample,
      ]),
    ]),
    list,
  ]);

  const dialog = shell('Fonts', body, [
    button({ label: 'Clear cache', onClick: () => void callbacks.clearCache() }),
    button({ label: 'Done', variant: 'primary', onClick: () => dialog.close() }),
  ]);

  dialog.showModal();
  return dialog;
}

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

/**
 * Explains what saving as stock `.scad` will do to this particular file
 * (spec feature 21).
 *
 * Asked every time rather than only when a rewrite is needed, because the
 * reassuring answer is worth as much as the warning: the common case is a file
 * that is already stock, and being told it will be saved *unchanged* is what
 * makes the rewrite, when it does happen, believable.
 */
export function showSaveAsScadDialog(
  extensions: ExtensionUse[],
  onConfirm: () => void,
): void {
  const rewriting = extensions.length > 0;

  const body = el('div', {}, [
    el('p', {
      style: 'margin-top:0',
      text: rewriting
        ? 'This file uses BetterSCAD syntax that stock OpenSCAD does not accept. Saving as .scad rewrites it so the saved file opens anywhere:'
        : 'This file already uses only stock OpenSCAD, so it is saved exactly as you wrote it — nothing is transpiled, reformatted, or moved.',
    }),
    rewriting ? extensionList(extensions) : null,
    rewriting
      ? el('p', {
          class: 'param__hint',
          text:
            'A rewrite reflows the code and drops comments, so the saved .scad is a ' +
            'derivative rather than the same file under another name. This tab keeps your ' +
            'original, and Save goes on writing to it.',
        })
      : null,
  ]);

  const dialog = shell('Save as OpenSCAD .scad', body, [
    button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
    button({
      label: rewriting ? 'Rewrite and save' : 'Save',
      variant: 'primary',
      onClick: () => {
        dialog.close();
        onConfirm();
      },
    }),
  ]);
  dialog.showModal();
}

/**
 * Shows the stock `.scad` this file downgrades to.
 *
 * Claims about a rewrite are cheap; the rewritten code is the only thing that
 * actually answers "what will OpenSCAD see?". Read-only and selectable rather
 * than editable — it is a derivative of the tab, not a second copy of it.
 */
export function showDowngradePreviewDialog(
  filename: string,
  extensions: ExtensionUse[],
  source: string,
  verbatim: boolean,
): void {
  const body = el('div', { class: 'downgrade' }, [
    el('p', {
      class: 'param__hint',
      style: 'margin-top: 0',
      text: verbatim
        ? 'This file is already stock OpenSCAD, so the downgrade is a straight copy — shown here unchanged.'
        : 'Saving as OpenSCAD .scad produces this:',
    }),
    verbatim || extensions.length === 0 ? null : extensionList(extensions),
    el('pre', { class: 'downgrade__code' }, [el('code', { text: source })]),
  ]);

  const dialog = shell(
    `Downgrade preview — ${filename}`,
    body,
    [button({ label: 'Close', variant: 'primary', onClick: () => dialog.close() })],
    'dialog__body--flush',
  );
  dialog.showModal();
}

export interface NonStandardFile {
  name: string;
  extensions: ExtensionUse[];
}

/**
 * Warns that a `.scad` just opened is not actually stock OpenSCAD.
 *
 * A file named `.scad` carries a promise — that any OpenSCAD will open it —
 * and BetterSCAD extensions quietly break that promise. Raised on open rather
 * than on save because that is when the user still remembers where the file
 * came from and whether anyone else is going to read it.
 *
 * `onConvert` renames the file to `.bscad`, which is offered only when a single
 * file is affected: it acts on the active document, and picking which of
 * several to convert belongs in the tab strip, not in a warning.
 */
export function showNonStandardSyntaxDialog(files: NonStandardFile[], onConvert?: () => void): void {
  const single = files.length === 1;

  const body = el('div', {}, [
    el('p', {
      style: 'margin-top:0',
      text: single
        ? `"${files[0].name}" uses BetterSCAD syntax that stock OpenSCAD does not accept:`
        : `${files.length} of the files you opened use BetterSCAD syntax that stock OpenSCAD does not accept:`,
    }),
    ...files.map((file) =>
      el('div', { style: 'margin-top: 12px;' }, [
        single ? null : el('div', { class: 'param__name', text: file.name }),
        extensionList(file.extensions),
      ]),
    ),
    el('p', {
      class: 'param__hint',
      text:
        'It opens and renders here either way. To hand it to stock OpenSCAD, use Save ▸ ' +
        'Save as OpenSCAD .scad, which applies the rewrites listed above. Saving as .bscad ' +
        'instead makes the extensions explicit in the file name.',
    }),
  ]);

  const footer = [
    onConvert && single
      ? button({
          label: 'Save as .bscad…',
          onClick: () => {
            dialog.close();
            onConvert();
          },
        })
      : null,
    button({ label: 'Got it', variant: 'primary', onClick: () => dialog.close() }),
  ].filter((node): node is HTMLButtonElement => node !== null);

  const dialog = shell('Not stock OpenSCAD', body, footer);
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
