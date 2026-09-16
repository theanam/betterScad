/**
 * The project directory.
 *
 * Every open tab behaves as though it sits in one shared folder, and this is
 * that folder. A file added here is addressable by name from any tab —
 * `import("logo.svg")`, `surface("terrain.png")`, `use <MCAD/gears.scad>`,
 * `text(font = "Orbitron")` — which is the whole point: the app has no working
 * directory of its own, so it has to supply one.
 *
 * IndexedDB rather than localStorage, for the obvious reason and a less obvious
 * one: binaries cannot go in localStorage at all, and its ~5 MB budget is
 * already spoken for by the session. A single STL would evict the user's tabs.
 *
 * The in-memory list is the one every reader uses. Renders need the bytes
 * synchronously and IndexedDB cannot offer that, so the database is a
 * write-behind of this list rather than the other way round.
 */

const DB_NAME = 'betterscad-files';
const DB_VERSION = 1;
const STORE = 'files';

/**
 * What a file can be used for, derived from its extension.
 *
 * Derived, not declared, and it decides only what the app *offers* — the
 * resolver never consults it. A `.dat` renamed to `.txt` still resolves; it
 * just stops being suggested, which is the right way round for a guess made
 * from a file name.
 */
export type FileKind = 'library' | 'geometry' | 'surface' | 'font' | 'other';

const KINDS: { kind: FileKind; pattern: RegExp }[] = [
  { kind: 'library', pattern: /\.(scad|bscad)$/i },
  { kind: 'geometry', pattern: /\.(stl|obj|off|3mf|dxf|svg)$/i },
  { kind: 'surface', pattern: /\.(png|jpe?g|dat)$/i },
  { kind: 'font', pattern: /\.(ttf|otf|ttc)$/i },
];

export function kindOf(path: string): FileKind {
  return KINDS.find((entry) => entry.pattern.test(path))?.kind ?? 'other';
}

export const KIND_LABELS: Record<FileKind, string> = {
  library: 'Library',
  geometry: 'Geometry',
  surface: 'Surface',
  font: 'Font',
  other: 'Other',
};

export interface ProjectFile {
  /** Path as written in a script, with folders: `MCAD/gears.scad`. */
  path: string;
  data: Uint8Array;
  kind: FileKind;
  addedAt: number;
  /**
   * The family the worker registered this font under.
   *
   * Fonts are the one kind a script never names by path — `text(font = "…")`
   * asks for a family — so without this there is no way back from a font a
   * model used to the file that supplied it, and the zip could not carry it.
   */
  family?: string;
}

/** The code that puts a file to use, for the panel's insert action. */
export function referenceFor(file: ProjectFile): string {
  switch (file.kind) {
    case 'library':
      return `use <${file.path}>\n`;
    case 'surface':
      return `surface("${file.path}");\n`;
    case 'font':
      return `text("Hello", font = "${file.family ?? file.path.replace(/\.[^.]+$/, '')}");\n`;
    case 'geometry':
    default:
      return `import("${file.path}");\n`;
  }
}

/** Human file size, for the panel's second column. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(undefined);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'path' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // A private window or a storage-blocked context gets a session-only
    // directory rather than no directory: everything below still works, it
    // just does not survive a reload.
    request.onerror = () => resolve(undefined);
  });
}

interface StoredFile {
  path: string;
  data: ArrayBuffer;
  addedAt: number;
  family?: string;
}

export class ProjectFiles {
  private files: ProjectFile[] = [];
  /**
   * Bumped on every change.
   *
   * The worker keeps its own copy of the directory so that auto-render does not
   * structured-clone every byte on every keystroke; this is how it knows the
   * copy is stale.
   */
  private rev = 0;
  private listeners: (() => void)[] = [];

  get revision(): number {
    return this.rev;
  }

  get list(): readonly ProjectFile[] {
    return this.files;
  }

  get isEmpty(): boolean {
    return this.files.length === 0;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    this.rev++;
    for (const listener of this.listeners) listener();
  }

  get(path: string): ProjectFile | undefined {
    return this.files.find((f) => f.path === path);
  }

  /** The directory as the worker wants it: bytes by path. */
  payload(): Record<string, Uint8Array> {
    return Object.fromEntries(this.files.map((f) => [f.path, f.data]));
  }

  async load(): Promise<void> {
    const db = await openDb();
    if (!db) return;
    const stored = await new Promise<StoredFile[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as StoredFile[]) ?? []);
      request.onerror = () => resolve([]);
    });
    this.files = stored
      .map((entry) => ({
        path: entry.path,
        data: new Uint8Array(entry.data),
        kind: kindOf(entry.path),
        addedAt: entry.addedAt,
        family: entry.family,
      }))
      .sort(byPath);
    if (this.files.length > 0) this.changed();
  }

  /**
   * Adds a file, replacing any file already at that path.
   *
   * Replacing rather than uniquifying: dropping a corrected `logo.svg` on top
   * of the old one is the common case, and a `logo 2.svg` the script does not
   * mention would look like the update simply had no effect.
   */
  async add(path: string, data: Uint8Array, family?: string): Promise<ProjectFile> {
    const clean = normalizePath(path);
    const file: ProjectFile = {
      path: clean,
      data,
      kind: kindOf(clean),
      addedAt: Date.now(),
      family,
    };
    const existing = this.files.findIndex((f) => f.path === clean);
    if (existing >= 0) this.files[existing] = file;
    else this.files.push(file);
    this.files.sort(byPath);
    await this.write(file);
    this.changed();
    return file;
  }

  /** Records the family a font registered under; see `ProjectFile.family`. */
  async setFamily(path: string, family: string): Promise<void> {
    const file = this.get(path);
    if (!file || file.family === family) return;
    file.family = family;
    await this.write(file);
    this.changed();
  }

  async remove(path: string): Promise<void> {
    const index = this.files.findIndex((f) => f.path === path);
    if (index < 0) return;
    this.files.splice(index, 1);
    const db = await openDb();
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(path);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }
    this.changed();
  }

  /**
   * Renames a file.
   *
   * Scripts refer to files by name, so this breaks every reference to the old
   * one — which is exactly why it is worth having: it is the only way to make a
   * file match a name a script already uses, which is what someone who opened
   * an existing `.scad` needs on their first minute here.
   */
  async rename(from: string, to: string): Promise<boolean> {
    const file = this.get(from);
    const clean = normalizePath(to);
    if (!file || !clean || clean === from) return false;
    if (this.get(clean)) return false;
    await this.remove(from);
    await this.add(clean, file.data, file.family);
    return true;
  }

  async clear(): Promise<void> {
    this.files = [];
    const db = await openDb();
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }
    this.changed();
  }

  private async write(file: ProjectFile): Promise<void> {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const record: StoredFile = {
        path: file.path,
        // A copy: the in-memory array outlives the transaction and callers may
        // hand the original on to the worker.
        data: file.data.slice().buffer,
        addedAt: file.addedAt,
        family: file.family,
      };
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      // Quota exceeded, most likely. The file stays usable this session; it
      // just will not be there after a reload.
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }
}

/**
 * Alphabetical by full path, which groups each folder's contents together
 * because the folder name is the prefix. The panel does the rest of the
 * grouping; this only has to be stable and unsurprising.
 */
function byPath(a: ProjectFile, b: ProjectFile): number {
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}
