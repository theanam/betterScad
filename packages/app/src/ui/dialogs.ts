/**
 * Modal dialogs: export, fonts, legacy export, and confirmations.
 */

import { EXPORT_FORMATS, formatFontSpec, type ExportFormat, type ExtensionUse } from '@betterscad/engine';
import { button, clear, el } from './dom.js';
import { extensionList } from './extension-list.js';
import type { CatalogEntry, SpecimenSheet } from '../files/font-library.js';

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
  /** Loads a font file the user picked. */
  loadFromDisk(): Promise<void>;
  /**
   * Asks the browser for the installed families, by name only.
   *
   * Names, not bytes: a system font is already on the machine, so the browser
   * can preview it with nothing more than a CSS `font-family`. Reading sixty
   * font files to show sixty rows was the expensive part, and it bought
   * nothing that this does not.
   */
  listSystemFonts(): Promise<string[]>;
  clearCache(): Promise<void>;
  /** Bytes already on hand for a family, from the app or the IndexedDB cache. */
  bytesFor(family: string): Promise<Uint8Array | undefined>;
  /** Inserts text at the editor cursor. */
  insert(text: string): void;
}
const DEFAULT_SAMPLE = 'AaBbGg 0123';

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
/**
 * The font picker.
 *
 * Three tabs, and no Load button anywhere. Picking a font means writing its
 * name into your model, and the app fetches whatever the model turns out to
 * need — so the only question this dialog has to answer is "what does it look
 * like", which is the question it was worst at before.
 *
 * Each tab previews differently, because each has different bytes to hand:
 * Google families use the outlines shipped with the app, system families are
 * already installed so CSS can draw them, and anything loaded already has a
 * real face registered.
 */
export function showFontDialog(
  loadedFaces: { family: string; style: string }[],
  catalog: CatalogEntry[],
  callbacks: FontDialogCallbacks,
  specimens?: SpecimenSheet,
): HTMLDialogElement {
  const loaded = new Map<string, string[]>();
  for (const face of loadedFaces) {
    const styles = loaded.get(face.family) ?? [];
    if (!styles.includes(face.style)) styles.push(face.style);
    loaded.set(face.family, styles);
  }

  type Tab = 'google' | 'system' | 'files';
  let tab: Tab = 'google';
  let systemFamilies: string[] | undefined;
  let systemRefused = false;

  const list = el('div', { class: 'fontlist' });
  const status = el('p', { class: 'param__hint', text: '' });

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

  sample.addEventListener('input', () => {
    for (const node of list.querySelectorAll('.font__preview')) {
      // A specimen outline spells what it spells; only live text follows this.
      if (node.querySelector('.font__specimen')) continue;
      node.textContent = sampleText();
    }
  });

  /** `font = "Family"`, with the buttons that put it in the model. */
  function specRow(family: string, style: string): HTMLElement {
    const snippet = `font = "${formatFontSpec(family, style)}"`;
    const copy = button({
      label: 'Copy',
      variant: 'ghost',
      title: `Copy ${snippet}`,
      onClick: () => {
        void navigator.clipboard
          ?.writeText(snippet)
          .then(() => (status.textContent = `Copied ${snippet}`));
      },
    });
    const insert = button({
      label: 'Insert',
      variant: 'primary',
      title: `Insert ${snippet} at the cursor`,
      onClick: () => {
        callbacks.insert(snippet);
        status.textContent = `Inserted ${snippet} — the font loads on the next render.`;
      },
    });
    return el('div', { class: 'font__spec' }, [
      el('code', { class: 'font__snippet', title: 'The argument text() expects', text: snippet }),
      el('div', { class: 'font__specactions' }, [copy, insert]),
    ]);
  }

  /** One family: what it is, what it looks like, and how to use it. */
  function row(family: string, meta: string, kind: Tab): HTMLElement {
    const styles = loaded.get(family);
    const isLoaded = !!styles;

    const preview = el('div', {
      class: 'font__preview',
      text: sampleText(),
      style: 'font-family: var(--bs-font-ui)',
    });

    if (kind === 'system') {
      // Already installed, so the browser can simply draw it. No bytes, no
      // parsing, and nothing to wait for.
      preview.style.fontFamily = `'${family}', var(--bs-font-ui)`;
    }

    const outline = specimens?.fonts[family];
    if (kind === 'google' && outline && !isLoaded) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${outline.width} ${outline.height}`);
      svg.setAttribute('class', 'font__specimen');
      svg.setAttribute('height', '26');
      svg.setAttribute('width', String((26 * outline.width) / outline.height));
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${family}, showing ${specimens.text}`);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', outline.d);
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
      preview.replaceChildren(svg);
    }

    const head = el('div', { class: 'font__head' }, [
      el('span', { class: 'font__family', text: family }),
      el('span', { class: 'fontlist__meta', text: meta }),
      el('span', { class: 'toolbar__spacer' }),
      isLoaded ? el('span', { class: 'fontlist__state', text: 'Ready' }) : null,
    ]);

    const body = el('div', { class: 'font__body' }, [head, preview]);
    for (const style of styles ?? ['Regular']) body.appendChild(specRow(family, style));

    // A face already registered can render anything, so the fixed specimen
    // gives way to the sample text you can edit.
    if (kind !== 'system' && isLoaded) {
      void callbacks.bytesFor(family).then(async (data) => {
        if (!data) return;
        const cssFamily = await registerPreviewFont(family, data);
        if (!cssFamily) return;
        preview.replaceChildren(document.createTextNode(sampleText()));
        preview.style.fontFamily = `'${cssFamily}', var(--bs-font-ui)`;
      });
    }

    return el('div', { class: 'font__item' }, [body]);
  }

  const paint = (): void => {
    clear(list);
    const query = search.value.trim().toLowerCase();
    const matches = (family: string): boolean => family.toLowerCase().includes(query);

    if (tab === 'google') {
      const entries = catalog.filter((entry) => matches(entry.family));
      if (entries.length === 0) {
        list.appendChild(el('p', { class: 'panel__empty', text: 'No matching families.' }));
        return;
      }
      for (const entry of entries) {
        const meta = [entry.license, entry.variable ? 'variable' : null].filter(Boolean).join(' · ');
        list.appendChild(row(entry.family, meta, 'google'));
      }
      return;
    }

    if (tab === 'system') {
      if (systemFamilies === undefined) {
        list.appendChild(
          el('div', { class: 'font__permission' }, [
            el('p', {
              class: 'param__hint',
              text:
                'Fonts installed on this computer can be used too. The browser asks your ' +
                'permission before listing them, and nothing is uploaded.',
            }),
            button({
              label: 'Show my installed fonts',
              variant: 'primary',
              onClick: async () => {
                const families = await callbacks.listSystemFonts();
                systemFamilies = families;
                systemRefused = families.length === 0;
                paint();
              },
            }),
          ]),
        );
        return;
      }
      if (systemRefused) {
        list.appendChild(
          el('p', {
            class: 'panel__empty',
            text:
              'No installed fonts were available. Chrome and Edge can list them with your ' +
              'permission; other browsers cannot, so load a font file instead.',
          }),
        );
        return;
      }
      const families = systemFamilies.filter(matches);
      if (families.length === 0) {
        list.appendChild(el('p', { class: 'panel__empty', text: 'No matching families.' }));
        return;
      }
      for (const family of families.slice(0, 500)) {
        list.appendChild(row(family, 'installed', 'system'));
      }
      return;
    }

    // Anything registered that the catalogue does not list — font files the
    // user loaded from disk, and any system family already pulled in.
    const catalogued = new Set(catalog.map((entry) => entry.family));
    const own = [...loaded.keys()].filter((family) => !catalogued.has(family) && matches(family));
    if (own.length === 0) {
      list.appendChild(
        el('p', {
          class: 'panel__empty',
          text: 'No font files loaded. Use "Load font file…" for a font of your own.',
        }),
      );
      return;
    }
    for (const family of own.sort()) list.appendChild(row(family, 'loaded from a file', 'files'));
  };

  const tabs = el('div', { class: 'paneltabs font__tabs', role: 'tablist' });
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  const addTab = (id: Tab, label: string, count?: number): void => {
    const node = el('button', {
      class: 'paneltab',
      type: 'button',
      role: 'tab',
      'aria-selected': String(id === tab),
      onclick: () => {
        tab = id;
        for (const [key, other] of tabButtons) other.setAttribute('aria-selected', String(key === id));
        paint();
      },
    }) as HTMLButtonElement;
    node.append(el('span', { text: label }));
    if (count !== undefined) {
      node.append(el('span', { class: 'paneltab__count', text: String(count) }));
    }
    tabButtons.set(id, node);
    tabs.appendChild(node);
  };
  addTab('google', 'Google fonts', catalog.length);
  addTab('system', 'On this computer');
  addTab('files', 'Your files');

  search.addEventListener('input', paint);
  paint();

  const body = el('div', {}, [
    el('p', {
      class: 'param__hint',
      style: 'margin-top: 0',
      text:
        'Insert a font and it loads itself the next time the model renders — there is nothing ' +
        'to download by hand. Anything fetched is cached in your browser and stays available ' +
        'offline.',
    }),
    tabs,
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
    status,
    list,
  ]);

  const dialog = shell('Fonts', body, [
    button({
      label: 'Load font file…',
      iconName: 'open',
      onClick: () =>
        void callbacks.loadFromDisk().then(() => {
          tab = 'files';
          for (const [key, node] of tabButtons) node.setAttribute('aria-selected', String(key === 'files'));
          paint();
        }),
    }),
    button({ label: 'Clear cache', variant: 'ghost', onClick: () => void callbacks.clearCache() }),
    el('span', { class: 'toolbar__spacer' }) as HTMLElement,
    button({ label: 'Done', variant: 'primary', onClick: () => dialog.close() }),
  ]);

  dialog.showModal();
  return dialog;
}

/**
 * Asks for one line of text.
 *
 * `window.prompt` would do the job and is one line, but it is blocked outright
 * in some embedding contexts and looks like it belongs to the browser rather
 * than to this app. Renaming a project file is the first thing here that needs
 * one, and it needs to say what the rename will break.
 */
export function showPrompt(
  title: string,
  label: string,
  initial: string,
  options: { confirmLabel?: string; hint?: string } = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = el('input', {
      type: 'text',
      value: initial,
      'aria-label': label,
      style: 'width: 100%; padding: 6px 8px;',
    }) as HTMLInputElement;

    let result: string | undefined;
    const accept = (): void => {
      const value = input.value.trim();
      if (!value) return;
      result = value;
      dialog.close();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        accept();
      }
    });

    const body = el('div', {}, [
      el('div', { class: 'param__hint', text: label }),
      input,
      ...(options.hint ? [el('p', { class: 'param__hint', text: options.hint })] : []),
    ]);

    const dialog = shell(title, body, [
      button({ label: 'Cancel', variant: 'ghost', onClick: () => dialog.close() }),
      button({ label: options.confirmLabel ?? 'Rename', variant: 'primary', onClick: accept }),
    ]);
    dialog.addEventListener('close', () => resolve(result));
    dialog.showModal();
    // Selecting the stem leaves the extension in place, which is what a rename
    // almost always wants to keep.
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });
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
