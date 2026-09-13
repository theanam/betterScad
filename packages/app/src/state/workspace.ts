/**
 * Workspace state: documents, tabs, parameters and persisted layout
 * (spec features 12, 16 and the panel-persistence open question).
 *
 * Everything lives in localStorage. There is no backend (spec feature 7), so
 * "the session survives a reload" has to be entirely client-side.
 */

import { EditorState } from '@codemirror/state';
import { parseBscad, serializeBscad, type BscadMetadata, type Value } from '@betterscad/engine';

export interface Document {
  id: string;
  name: string;
  /** Authoritative text. The editor state mirrors it while the tab is open. */
  text: string;
  /** Saved CodeMirror state, so each tab keeps its own undo history. */
  editorState?: EditorState;
  handle?: FileSystemFileHandle;
  /** Text as last saved, used to decide whether the tab is dirty. */
  savedText: string;
  metadata: BscadMetadata;
  /** Customizer values, overriding the script's own assignments. */
  parameters: Record<string, Value>;
}

export interface LayoutState {
  /** Editor column width as a fraction of the workspace. */
  editorFraction: number;
  /** Console height as a fraction of the right column. */
  consoleFraction: number;
  customizerVisible: boolean;
  consoleVisible: boolean;
  theme: 'light' | 'dark';
  autoRender: boolean;
  showGrid: boolean;
  showAxes: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  editorFraction: 0.44,
  consoleFraction: 0.26,
  customizerVisible: false,
  consoleVisible: true,
  theme: 'dark',
  autoRender: true,
  showGrid: true,
  showAxes: true,
};

const STORAGE_KEY = 'betterscad.workspace.v1';

export const STARTER_DOCUMENT = `// Welcome to BetterSCAD.
// Everything runs in your browser — nothing is uploaded.
//
// F5 preview · F6 render · Ctrl/Cmd+Shift+P for the command palette

/* [Shape] */
// Outer size of the block
size = 40;      // [10:80]
// Diameter of the sphere carved out of it
bite = 46;      // [5:0.5:70]
// Corner rounding
fillet = 3;     // [0:0.5:10]

/* [Quality] */
resolution = 48; // [12:8:120]

$fn = resolution;

module rounded_box(s, r) {
  // A hull of eight corner spheres is the classic way to round a box.
  hull() {
    for (x = [-1, 1], y = [-1, 1], z = [-1, 1]) {
      translate([x, y, z] * (s / 2 - r)) sphere(r);
    }
  }
}

difference() {
  rounded_box(size, fillet);
  sphere(d = bite);
}

// '%' draws a reference without contributing geometry.
%translate([0, 0, -size / 2 - 2]) cube([size * 1.4, size * 1.4, 1], center = true);

echo("volume target", size, bite);
`;

export class Workspace {
  documents: Document[] = [];
  activeId = '';
  layout: LayoutState = { ...DEFAULT_LAYOUT };
  /** Binary assets for `import()` / `surface()`, by filename. */
  assets = new Map<string, Uint8Array>();

  private nextId = 1;

  get active(): Document | undefined {
    return this.documents.find((d) => d.id === this.activeId);
  }

  createDocument(name: string, text: string, handle?: FileSystemFileHandle): Document {
    const parsed = parseBscad(text);
    const doc: Document = {
      id: `doc-${this.nextId++}`,
      name: this.uniqueName(name),
      text: parsed.source,
      savedText: parsed.source,
      handle,
      metadata: parsed.metadata,
      parameters: {},
    };
    // Presets saved in the .bscad header restore the last active parameter set.
    const preset = parsed.metadata.activePreset;
    if (preset && parsed.metadata.presets?.[preset]) {
      doc.parameters = { ...parsed.metadata.presets[preset] } as Record<string, Value>;
    }
    this.documents.push(doc);
    this.activeId = doc.id;
    return doc;
  }

  /** Avoids two tabs with the same label, which makes includes ambiguous. */
  private uniqueName(name: string): string {
    if (!this.documents.some((d) => d.name === name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}${extension}`;
      if (!this.documents.some((d) => d.name === candidate)) return candidate;
    }
  }

  closeDocument(id: string): void {
    const index = this.documents.findIndex((d) => d.id === id);
    if (index < 0) return;
    this.documents.splice(index, 1);
    if (this.activeId === id) {
      this.activeId = this.documents[Math.min(index, this.documents.length - 1)]?.id ?? '';
    }
  }

  isDirty(doc: Document): boolean {
    return doc.text !== doc.savedText;
  }

  get hasUnsavedChanges(): boolean {
    return this.documents.some((d) => this.isDirty(d));
  }

  /** Every document's text, so the worker can resolve `include <...>`. */
  fileMap(exclude?: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const doc of this.documents) {
      if (doc.id === exclude) continue;
      files[doc.name] = doc.text;
    }
    return files;
  }

  assetMap(): Record<string, Uint8Array> {
    return Object.fromEntries(this.assets);
  }

  /** Serialises a document to `.bscad`, metadata header included. */
  serialize(doc: Document, camera?: BscadMetadata['camera']): string {
    return serializeBscad(doc.text, {
      ...doc.metadata,
      version: 1,
      camera: camera ?? doc.metadata.camera,
      presets: {
        ...doc.metadata.presets,
        ...(Object.keys(doc.parameters).length > 0 ? { current: doc.parameters } : {}),
      },
      activePreset: Object.keys(doc.parameters).length > 0 ? 'current' : doc.metadata.activePreset,
      layout: { editorFraction: this.layout.editorFraction, consoleFraction: this.layout.consoleFraction },
    });
  }

  // -- persistence ----------------------------------------------------------

  /**
   * Saves the session.
   *
   * File handles are not persisted: they cannot be stored in localStorage, and
   * IndexedDB-persisted handles need a fresh permission prompt anyway. Text is
   * kept so no work is lost on reload; the handle is re-established on the next
   * explicit Save As.
   */
  persist(): void {
    try {
      const payload = {
        version: 1,
        activeId: this.activeId,
        layout: this.layout,
        documents: this.documents.map((d) => ({
          id: d.id,
          name: d.name,
          text: d.text,
          savedText: d.savedText,
          metadata: d.metadata,
          parameters: d.parameters,
          hadHandle: !!d.handle,
        })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota exceeded or storage disabled: the session just will not restore.
    }
  }

  restore(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const payload = JSON.parse(raw) as {
        version?: number;
        activeId?: string;
        layout?: Partial<LayoutState>;
        documents?: Omit<Document, 'editorState' | 'handle'>[];
      };
      if (payload.version !== 1 || !payload.documents?.length) return false;

      this.layout = { ...DEFAULT_LAYOUT, ...payload.layout };
      this.documents = payload.documents.map((d) => ({
        ...d,
        metadata: d.metadata ?? { version: 1 },
        parameters: d.parameters ?? {},
      }));
      this.nextId = this.documents.length + 1;
      this.activeId =
        payload.activeId && this.documents.some((d) => d.id === payload.activeId)
          ? payload.activeId
          : this.documents[0].id;
      return true;
    } catch {
      return false;
    }
  }

  static clearPersisted(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to do; storage is unavailable.
    }
  }
}
