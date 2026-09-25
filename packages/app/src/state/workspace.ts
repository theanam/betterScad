/**
 * Workspace state: documents, tabs, parameters and persisted layout
 * (spec features 12, 16 and the panel-persistence open question).
 *
 * Everything lives in localStorage. There is no backend (spec feature 7), so
 * "the session survives a reload" has to be entirely client-side.
 */

import { EditorState } from '@codemirror/state';

import type { CameraState } from '../viewport/controls.js';
import { parseBscad, serializeBscad, type BscadMetadata, type Value } from '@betterscad/engine';

/** What a document writes to disk: `.bscad` carries metadata, `.scad` does not. */
export type DocumentFormat = 'bscad' | 'scad';

/** The format implied by a file name. Anything that is not `.bscad` is `.scad`. */
export function formatForName(name: string): DocumentFormat {
  return /\.bscad$/i.test(name) ? 'bscad' : 'scad';
}

/** Swaps a file name's extension, for suggesting a Save As name. */
export function withFormatExtension(name: string, format: DocumentFormat): string {
  return `${name.replace(/\.[^./]*$/, '')}.${format}`;
}

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
  /** True when the file as opened already carried a `.bscad` metadata header. */
  hadMetadata: boolean;
  /** Customizer values, overriding the script's own assignments. */
  parameters: Record<string, Value>;
  /**
   * The project file this tab was opened from, if any.
   *
   * Recorded rather than matched on the name: a new tab called `gears.scad`
   * beside a stored `gears.scad` is a coincidence, and Save treating it as the
   * same file would overwrite a library with an unrelated document.
   */
  projectPath?: string;
  /**
   * The viewport pose this tab was last left at.
   *
   * Absent until the document has been shown once, which is what tells the app
   * to give it the isometric, fitted view rather than inheriting whatever the
   * previously active model happened to need.
   */
  camera?: CameraState;
}

export interface LayoutState {
  /** Editor column width as a fraction of the workspace. */
  editorFraction: number;
  /** Console height as a fraction of the right column. */
  consoleFraction: number;
  customizerVisible: boolean;
  consoleVisible: boolean;
  /** The Files panel, which holds the project directory. */
  filesVisible: boolean;
  theme: 'light' | 'dark';
  autoRender: boolean;
  showGrid: boolean;
  showAxes: boolean;
  /** Paint each item its own colour in the viewport, to tell touching ones apart. */
  varyColors: boolean;
  /**
   * Which measurement of a circle the editor offers first.
   *
   * Radius and diameter are both right, and people are firmly one or the
   * other: a caliper reads diameter and a hardware table quotes it, while
   * OpenSCAD's own signatures lead with radius. So it is asked rather than
   * assumed. It changes what autocomplete suggests and nothing else — no file
   * written here depends on it.
   */
  roundMeasure: 'radius' | 'diameter';
  /** Convert `5in` to millimetres as it is typed. */
  inchEntry: boolean;
  /** Spaces per indent in the editor. */
  indentWidth: 2 | 4;
  /** Tab takes the open suggestion, rather than always indenting. */
  tabCompletion: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  editorFraction: 0.44,
  consoleFraction: 0.26,
  customizerVisible: false,
  consoleVisible: true,
  filesVisible: false,
  theme: 'dark',
  autoRender: true,
  showGrid: true,
  showAxes: true,
  varyColors: false,
  roundMeasure: 'diameter',
  inchEntry: true,
  indentWidth: 2,
  tabCompletion: true,
};

const STORAGE_KEY = 'betterscad.workspace.v1';

/** What "start blank" and File ▸ New produce. */
export const BLANK_DOCUMENT = `// New model

cube(10, center = true);
`;

export const STARTER_DOCUMENT = `// Welcome to BetterSCAD.
// Everything runs in your browser — nothing is uploaded.
//
// F5 preview · F6 render · Ctrl/Cmd+K to search or run a command

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

// The rounding belongs to the cube, not to a module you have to write first.
cube(size, center = true, r = fillet);

// negative() makes a shape into a hole in everything beside it, so the bite is
// written where the bite is rather than hoisted into a difference() up top.
negative() sphere(d = bite);

// '%' draws a reference without contributing geometry, and translatez() moves
// along one axis without counting commas in a vector.
%translatez(-size / 2 - 2) cube([size * 1.4, size * 1.4, 1], center = true);

echo("volume target", size, bite);
`;

/** The number in a `doc-N` id, or 0 for anything that is not one. */
function idNumber(doc: { id: string }): number {
  const match = /^doc-(\d+)$/.exec(doc.id ?? '');
  return match ? Number(match[1]) : 0;
}

export class Workspace {
  documents: Document[] = [];
  activeId = '';
  layout: LayoutState = { ...DEFAULT_LAYOUT };

  private nextId = 1;

  get active(): Document | undefined {
    return this.documents.find((d) => d.id === this.activeId);
  }

  /**
   * A document id nothing else is using.
   *
   * The counter alone is not enough. It is rebuilt on every restore, and a
   * session whose ids have gaps in it — close any tab, then reload — used to
   * leave it pointing below the highest id still in use. Checking is cheap and
   * a duplicate id is not a cosmetic fault: two documents that share one are
   * one document as far as every lookup here is concerned.
   */
  private mintId(): string {
    let id = `doc-${this.nextId++}`;
    while (this.documents.some((d) => d.id === id)) id = `doc-${this.nextId++}`;
    return id;
  }

  createDocument(name: string, text: string, handle?: FileSystemFileHandle): Document {
    const parsed = parseBscad(text);
    const doc: Document = {
      id: this.mintId(),
      name: this.uniqueName(name),
      text: parsed.source,
      savedText: parsed.source,
      handle,
      metadata: parsed.metadata,
      hadMetadata: parsed.hadMetadata,
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

  /**
   * The format a document saves back as.
   *
   * Normally the extension decides, so saving a `.scad` leaves a plain `.scad`
   * rather than quietly stamping a BetterSCAD header into someone else's file.
   * The exception is a file that arrived carrying a header: that metadata is
   * the user's, and dropping it on save would lose their presets and camera.
   */
  formatOf(doc: Document): DocumentFormat {
    return formatForName(doc.name) === 'bscad' || doc.hadMetadata ? 'bscad' : 'scad';
  }

  /**
   * Serialises a document for writing to disk.
   *
   * `.scad` gets the bare source; `.bscad` gets the metadata header too. Note
   * the metadata itself is never discarded — it stays on the in-memory document
   * and in the persisted session, so switching back to `.bscad` restores it.
   */
  serialize(
    doc: Document,
    camera?: BscadMetadata['camera'],
    format: DocumentFormat = this.formatOf(doc),
  ): string {
    if (format === 'scad') return doc.text;
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
          hadMetadata: d.hadMetadata,
          parameters: d.parameters,
          projectPath: d.projectPath,
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
      // An empty document list is a real state, not a failed restore: it is
      // what closing the last tab leaves behind, and reopening the sample on
      // the next visit would undo that deliberately.
      if (payload.version !== 1 || !Array.isArray(payload.documents)) return false;

      this.layout = { ...DEFAULT_LAYOUT, ...payload.layout };
      this.documents = payload.documents.map((d) => ({
        ...d,
        metadata: d.metadata ?? { version: 1 },
        hadMetadata: d.hadMetadata ?? false,
        parameters: d.parameters ?? {},
      }));
      // From the highest id present, not the number of documents. Those agree
      // only while the ids run 1..N with no gaps, and closing a tab before
      // reloading puts a gap in them — after which the next new document was
      // minted with an id another tab was still using. The two then shared an
      // identity: `active` resolved both to the first, clicking the second did
      // nothing at all because its id already matched `activeId`, and closing
      // it closed the other one.
      this.nextId = Math.max(0, ...this.documents.map(idNumber)) + 1;

      // Repair a session the old rule already broke. Without this the fix only
      // helps after the damaged session has been thrown away, which is not
      // something anyone would think to do.
      const seen = new Set<string>();
      for (const doc of this.documents) {
        if (!doc.id || seen.has(doc.id)) doc.id = this.mintId();
        seen.add(doc.id);
      }

      this.activeId =
        payload.activeId && this.documents.some((d) => d.id === payload.activeId)
          ? payload.activeId
          : (this.documents[0]?.id ?? '');
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
