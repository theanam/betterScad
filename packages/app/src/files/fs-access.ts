/**
 * Local file access (spec feature 6).
 *
 * Uses the File System Access API where it exists (Chrome, Edge), so Save
 * writes straight back to the file on disk. Firefox and Safari get the
 * download/upload fallback the spec requires — same API surface, so nothing
 * upstream needs to branch.
 */

export interface OpenedFile {
  name: string;
  /** Decoded source. Empty for an archive, whose bytes are in `data` instead. */
  text: string;
  /** Raw bytes, present only for a `.zip`. */
  data?: Uint8Array;
  /** Present only when the browser supports writing back in place. */
  handle?: FileSystemFileHandle;
}

export interface OpenedBinary {
  name: string;
  data: Uint8Array;
}

const SCAD_TYPES: FilePickerAcceptType[] = [
  {
    description: 'BetterSCAD and OpenSCAD files',
    accept: { 'text/plain': ['.bscad', '.scad'] },
  },
];

/** What Open accepts: a model, or a whole project zipped up. */
const OPEN_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Models and projects',
    accept: { 'text/plain': ['.bscad', '.scad'], 'application/zip': ['.zip'] },
  },
];

/**
 * What the Files panel accepts.
 *
 * Deliberately wide. The panel is a directory, and a directory that refuses a
 * file because the app cannot think of a use for it is a directory you cannot
 * put your `LICENSE` in. The accept-all option stays on for the same reason.
 */
const ASSET_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Meshes, drawings, images, fonts and libraries',
    accept: {
      'application/octet-stream': ['.stl', '.obj', '.off', '.3mf'],
      'image/svg+xml': ['.svg'],
      'image/vnd.dxf': ['.dxf'],
      'text/plain': ['.dat', '.scad', '.bscad'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'font/ttf': ['.ttf', '.otf', '.ttc'],
    },
  },
];

const FONT_TYPES: FilePickerAcceptType[] = [
  { description: 'Fonts', accept: { 'font/ttf': ['.ttf', '.otf', '.ttc'] } },
];

export const supportsFileSystemAccess: boolean =
  typeof window !== 'undefined' && 'showOpenFilePicker' in window;

export const supportsFileSystemWrite: boolean =
  supportsFileSystemAccess && 'showSaveFilePicker' in window;

/**
 * Whether this browser can open a file at all.
 *
 * Deliberately *not* `supportsFileSystemAccess`. Firefox and Safari have no
 * `showOpenFilePicker` and open files perfectly well through the
 * `<input type="file">` fallback below, so gating a control on the File System
 * Access API would hide a working feature from most of the non-Chromium web.
 *
 * This is false only where neither route exists: a sandboxed frame that refuses
 * file pickers, or a host with no DOM. A blocked input keeps its default `text`
 * type instead of accepting `file`, which is what the probe looks for.
 */
export const supportsFileOpen: boolean = ((): boolean => {
  if (supportsFileSystemAccess) return true;
  if (typeof document === 'undefined') return false;
  try {
    const input = document.createElement('input');
    input.type = 'file';
    return input.type === 'file';
  } catch {
    return false;
  }
})();

/** A one-line description of the active file strategy, for the status bar. */
export function fileAccessMode(): string {
  return supportsFileSystemWrite ? 'Direct file access' : 'Download / upload';
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** True for a file Open should unpack rather than read as source. */
export function isArchive(name: string): boolean {
  return /\.zip$/i.test(name);
}

async function readOpened(file: File, handle?: FileSystemFileHandle): Promise<OpenedFile> {
  // An archive is never decoded: a zip read as UTF-8 is megabytes of mojibake,
  // and nothing downstream would look at it.
  if (isArchive(file.name)) {
    return { name: file.name, text: '', data: new Uint8Array(await file.arrayBuffer()), handle };
  }
  return { name: file.name, text: await file.text(), handle };
}

export async function openScadFiles(): Promise<OpenedFile[]> {
  if (supportsFileSystemAccess) {
    try {
      const handles = await window.showOpenFilePicker!({
        multiple: true,
        types: OPEN_TYPES,
        // Let the user pick anything: plenty of `.scad` files carry no type.
        excludeAcceptAllOption: false,
      });
      return Promise.all(
        handles.map(async (handle: FileSystemFileHandle) => readOpened(await handle.getFile(), handle)),
      );
    } catch (err) {
      if (isAbort(err)) return [];
      throw err;
    }
  }
  return pickWithInput('.bscad,.scad,.zip,text/plain', true).then((files) =>
    Promise.all(files.map((file) => readOpened(file))),
  );
}

export async function openBinaryFiles(): Promise<OpenedBinary[]> {
  if (supportsFileSystemAccess) {
    try {
      const handles = await window.showOpenFilePicker!({
        multiple: true,
        types: ASSET_TYPES,
        excludeAcceptAllOption: false,
      });
      return Promise.all(
        handles.map(async (handle: FileSystemFileHandle) => {
          const file = await handle.getFile();
          return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
        }),
      );
    } catch (err) {
      if (isAbort(err)) return [];
      throw err;
    }
  }
  const files = await pickWithInput('', true);
  return Promise.all(
    files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })),
  );
}

export async function openFontFiles(): Promise<OpenedBinary[]> {
  if (supportsFileSystemAccess) {
    try {
      const handles = await window.showOpenFilePicker!({ multiple: true, types: FONT_TYPES });
      return Promise.all(
        handles.map(async (handle: FileSystemFileHandle) => {
          const file = await handle.getFile();
          return { name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
        }),
      );
    } catch (err) {
      if (isAbort(err)) return [];
      throw err;
    }
  }
  const files = await pickWithInput('.ttf,.otf,.ttc', true);
  return Promise.all(
    files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })),
  );
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Writes text back to an existing handle.
 *
 * Returns false when the handle is gone or permission was withdrawn, so the
 * caller can fall back to Save As rather than silently losing the edit.
 */
export async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<boolean> {
  try {
    const permission = await handle.queryPermission?.({ mode: 'readwrite' });
    if (permission !== 'granted') {
      const requested = await handle.requestPermission?.({ mode: 'readwrite' });
      if (requested !== 'granted') return false;
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * What a save attempt actually did.
 *
 * Four outcomes, not two. These used to collapse into "a handle, or nothing",
 * and nothing meant both "the user cancelled the picker" and "this browser has
 * no picker, so a file was downloaded instead" — opposite results. Every caller
 * read the second and so reported a save that had not happened; worse, Save As
 * also marked the document clean, which took away the dirty dot and the
 * unsaved-changes warning on a file that was never written.
 *
 * Making the two distinguishable in the type is what stops the next caller
 * getting it wrong the same way.
 */
export type SaveOutcome =
  /** Written to disk in place. `handle` is present for the text picker. */
  | { status: 'saved'; handle?: FileSystemFileHandle }
  /** No picker here, so a file was handed to the browser's downloads. */
  | { status: 'downloaded' }
  /** The user backed out. Nothing was written and nothing should be claimed. */
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string };

/** Whether bytes actually reached the user, by either route. */
export function wroteAFile(outcome: SaveOutcome): boolean {
  return outcome.status === 'saved' || outcome.status === 'downloaded';
}

export async function saveTextAs(suggestedName: string, text: string): Promise<SaveOutcome> {
  if (supportsFileSystemWrite) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker!({ suggestedName, types: SCAD_TYPES });
    } catch (err) {
      if (isAbort(err)) return { status: 'cancelled' };
      throw err;
    }
    // Choosing a file is not the same as writing to it: permission can be
    // withdrawn, or the disk can be full, between the two. That was swallowed
    // before, and reported as a successful save.
    if (!(await writeToHandle(handle, text))) {
      return { status: 'failed', reason: `Could not write to ${handle.name}.` };
    }
    return { status: 'saved', handle };
  }
  downloadBlob(new Blob([text], { type: 'text/plain' }), suggestedName);
  return { status: 'downloaded' };
}

export async function saveBinaryAs(
  suggestedName: string,
  data: Uint8Array,
  mimeType: string,
): Promise<SaveOutcome> {
  const blob = new Blob([data as BlobPart], { type: mimeType });

  if (supportsFileSystemWrite) {
    let handle: FileSystemFileHandle | undefined;
    try {
      const extension = suggestedName.split('.').pop() ?? '';
      handle = await window.showSaveFilePicker!({
        suggestedName,
        types: [{ description: extension.toUpperCase(), accept: { [mimeType]: [`.${extension}`] } }],
      });
    } catch (err) {
      if (isAbort(err)) return { status: 'cancelled' };
      // A rejected picker (unsupported type, sandboxed context) should still
      // produce a file rather than an error, so fall through to the download.
    }

    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { status: 'saved', handle };
      } catch (err) {
        return {
          status: 'failed',
          reason: `Could not write ${handle.name}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  downloadBlob(blob, suggestedName);
  return { status: 'downloaded' };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** The `<input type="file">` fallback path. */
function pickWithInput(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';

    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    // `cancel` is not universally supported; a focus fallback catches the rest.
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish([...(input.files ?? [])]), 400),
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}
