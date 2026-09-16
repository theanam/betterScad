/**
 * The Files panel: the project directory, on screen.
 *
 * A panel rather than a dialog, because what the feature is *for* is that the
 * files are there. A model that says `import("bracket.stl")` and renders
 * nothing has exactly one interesting question behind it — is the file there,
 * and under that name — and a list you have to go and open cannot answer it.
 *
 * Files the last render actually resolved are marked. That mark is not
 * decoration: it is the same list Save as zip packages, so the panel shows what
 * the zip would contain before anyone asks for one.
 */

import {
  KIND_LABELS,
  formatSize,
  type ProjectFile,
} from '../files/project-files.js';
import { button, clear, el, icon, openMenu } from './dom.js';
import { setHint } from './tooltip.js';

/** One glyph per kind, so the list is scannable without reading extensions. */
const KIND_ICONS: Record<ProjectFile['kind'], string> = {
  library: 'file',
  geometry: 'cube',
  surface: 'grid',
  font: 'font',
  other: 'file',
};

export interface FilesPanelCallbacks {
  onAdd(): void;
  /** Writes the call that uses this file into the open document. */
  onInsert(file: ProjectFile): void;
  /** Opens a library in a tab, so it can be edited rather than only referenced. */
  onOpen(file: ProjectFile): void;
  onRename(file: ProjectFile): void;
  onRemove(file: ProjectFile): void;
  onClose(): void;
}

export class FilesPanel {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private files: readonly ProjectFile[] = [];
  /** Paths the last render resolved; see the class comment. */
  private used = new Set<string>();

  constructor(private readonly callbacks: FilesPanelCallbacks) {
    this.body = el('div', { class: 'panel__body files' });

    this.element = el('div', { class: 'panel' }, [
      el('div', { class: 'panel__header' }, [
        el('span', { text: 'Files' }),
        el('span', { class: 'toolbar__spacer' }),
        button({
          label: 'Add files',
          iconName: 'plus',
          title: 'Add images, drawings, meshes, fonts or libraries to the project',
          onClick: () => this.callbacks.onAdd(),
        }),
        closeButton(() => this.callbacks.onClose()),
      ]),
      this.body,
    ]);

    // Dropping onto the panel is the obvious gesture once the panel exists.
    // The window-wide handler would catch these anyway; this one only exists to
    // light the target up, so the panel looks like somewhere you can drop.
    this.element.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.element.classList.add('panel--dropping');
    });
    for (const name of ['dragleave', 'drop'] as const) {
      this.element.addEventListener(name, () => this.element.classList.remove('panel--dropping'));
    }
  }

  update(files: readonly ProjectFile[], used: Set<string>): void {
    this.files = files;
    this.used = used;
    this.render();
  }

  private render(): void {
    clear(this.body);

    if (this.files.length === 0) {
      this.body.appendChild(
        el('div', { class: 'panel__empty' }, [
          el('p', { text: 'No files in this project yet.' }),
          el('p', {
            class: 'param__hint',
            text:
              'Add an image, an SVG, a mesh, a font or a library and every tab can use it by name, ' +
              'as though it sat in the same folder as your model. Drop files here, or use Add files.',
          }),
          button({ label: 'Add files…', onClick: () => this.callbacks.onAdd() }),
        ]),
      );
      return;
    }

    // Grouped by folder, because a folder is the only structure a path has and
    // `MCAD/` holding thirty files should not bury the two at the top level.
    const groups = new Map<string, ProjectFile[]>();
    for (const file of this.files) {
      const slash = file.path.lastIndexOf('/');
      const folder = slash < 0 ? '' : file.path.slice(0, slash);
      const bucket = groups.get(folder);
      if (bucket) bucket.push(file);
      else groups.set(folder, [file]);
    }

    for (const [folder, entries] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (folder) this.body.appendChild(el('div', { class: 'files__folder', text: `${folder}/` }));
      for (const file of entries) this.body.appendChild(this.row(file, !!folder));
    }
  }

  private row(file: ProjectFile, nested: boolean): HTMLElement {
    const name = file.path.split('/').pop() ?? file.path;
    const inUse = this.used.has(file.path);

    const label = el('span', { class: 'files__name', text: name });
    if (file.kind === 'other') {
      setHint(label, 'No BetterSCAD element reads this kind of file. It is kept, and it travels in a zip only if something uses it.');
    }

    const menuButton = el('button', {
      class: 'btn btn--ghost files__more',
      type: 'button',
      'aria-label': `Actions for ${name}`,
    }, [el('span', { text: '···' })]);
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.addEventListener('click', () => this.openRowMenu(menuButton, file));

    const dot = el('span', {
      class: inUse ? 'files__use files__use--on' : 'files__use',
      'aria-hidden': 'true',
    });
    setHint(
      dot,
      inUse
        ? 'The model on screen uses this file, so it goes into Save as zip.'
        : 'Nothing in the model on screen refers to this file.',
    );

    return el('div', { class: nested ? 'files__row files__row--nested' : 'files__row' }, [
      dot,
      icon(KIND_ICONS[file.kind], 13),
      label,
      el('span', { class: 'files__meta', text: `${KIND_LABELS[file.kind]} · ${formatSize(file.data.length)}` }),
      menuButton,
    ]);
  }

  private openRowMenu(anchor: HTMLElement, file: ProjectFile): void {
    const items = [
      {
        label: 'Insert reference',
        description: 'Writes the call that uses this file at the cursor',
        onSelect: () => this.callbacks.onInsert(file),
      },
    ];
    if (file.kind === 'library') {
      items.push({
        label: 'Open in a tab',
        description: 'Edit it here; the tab is what your model renders against',
        onSelect: () => this.callbacks.onOpen(file),
      });
    }
    items.push(
      {
        label: 'Rename…',
        description: 'Scripts refer to files by name, so this changes what refers to it',
        onSelect: () => this.callbacks.onRename(file),
      },
      {
        label: 'Remove',
        description: 'Takes it out of the project directory',
        onSelect: () => this.callbacks.onRemove(file),
      },
    );
    openMenu(anchor, items);
  }
}

/** The panel close button, matching the Customizer's. */
function closeButton(onClose: () => void): HTMLButtonElement {
  const node = el('button', {
    class: 'panel__close',
    type: 'button',
    onclick: () => onClose(),
  }) as HTMLButtonElement;
  node.appendChild(icon('close', 18));
  setHint(node, 'Hide the Files panel');
  return node;
}
