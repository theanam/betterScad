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
  text: string;
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

const ASSET_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Models and drawings',
    accept: {
      'application/octet-stream': ['.stl', '.obj', '.off', '.3mf'],
      'image/svg+xml': ['.svg'],
      'image/vnd.dxf': ['.dxf'],
      'text/plain': ['.dat'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
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

export async function openScadFiles(): Promise<OpenedFile[]> {
  if (supportsFileSystemAccess) {
    try {
      const handles = await window.showOpenFilePicker!({
        multiple: true,
        types: SCAD_TYPES,
        // Let the user pick anything: plenty of `.scad` files carry no type.
        excludeAcceptAllOption: false,
      });
      return Promise.all(
        handles.map(async (handle: FileSystemFileHandle) => {
          const file = await handle.getFile();
          return { name: file.name, text: await file.text(), handle };
        }),
      );
    } catch (err) {
      if (isAbort(err)) return [];
      throw err;
    }
  }
  return pickWithInput('.bscad,.scad,text/plain', true).then((files) =>
    Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() }))),
  );
}

export async function openBinaryFiles(): Promise<OpenedBinary[]> {
  if (supportsFileSystemAccess) {
    try {
      const handles = await window.showOpenFilePicker!({ multiple: true, types: ASSET_TYPES });
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
  const files = await pickWithInput('.stl,.obj,.off,.dxf,.svg,.dat,.png,.jpg,.jpeg', true);
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

export async function saveTextAs(
  suggestedName: string,
  text: string,
): Promise<FileSystemFileHandle | undefined> {
  if (supportsFileSystemWrite) {
    try {
      const handle = await window.showSaveFilePicker!({ suggestedName, types: SCAD_TYPES });
      await writeToHandle(handle, text);
      return handle;
    } catch (err) {
      if (isAbort(err)) return undefined;
      throw err;
    }
  }
  downloadBlob(new Blob([text], { type: 'text/plain' }), suggestedName);
  return undefined;
}

export async function saveBinaryAs(
  suggestedName: string,
  data: Uint8Array,
  mimeType: string,
): Promise<boolean> {
  const blob = new Blob([data as BlobPart], { type: mimeType });
  if (supportsFileSystemWrite) {
    try {
      const extension = suggestedName.split('.').pop() ?? '';
      const handle = await window.showSaveFilePicker!({
        suggestedName,
        types: [{ description: extension.toUpperCase(), accept: { [mimeType]: [`.${extension}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (isAbort(err)) return false;
      // A rejected picker (unsupported type, sandboxed context) should still
      // produce a file rather than an error.
    }
  }
  downloadBlob(blob, suggestedName);
  return true;
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
