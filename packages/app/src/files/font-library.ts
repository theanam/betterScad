/**
 * Font library for `text()` (spec feature 23).
 *
 * Hybrid, as the spec requires: a small curated set ships with the app for
 * offline use, and anything else is fetched on demand and cached in IndexedDB
 * so it works offline afterwards too.
 *
 * Google Fonts are pulled from the `google/fonts` repository over its CDN,
 * which serves TTF with permissive CORS. The web-font CSS API is deliberately
 * not used: it returns WOFF2, which cannot be turned into glyph outlines
 * without a decompressor.
 */

const DB_NAME = 'betterscad-fonts';
const DB_VERSION = 1;
const STORE = 'fonts';
const CDN = 'https://raw.githubusercontent.com/google/fonts/main/';

/** Bundled for offline use; served from the app's own origin. */
export const BUNDLED_FONTS = [
  { family: 'Noto Sans', file: 'fonts/NotoSans.ttf', license: 'OFL-1.1' },
  { family: 'Noto Serif', file: 'fonts/NotoSerif.ttf', license: 'OFL-1.1' },
  { family: 'Inter', file: 'fonts/Inter.ttf', license: 'OFL-1.1' },
  { family: 'JetBrains Mono', file: 'fonts/JetBrainsMono.ttf', license: 'OFL-1.1' },
];

/** The family stock OpenSCAD scripts get when `text()` names no font. */
export const DEFAULT_FAMILY = 'Noto Sans';

export interface CatalogEntry {
  family: string;
  license: string;
  path: string;
  variable: boolean;
}

let catalogPromise: Promise<CatalogEntry[]> | undefined;

/** The browsable catalogue of downloadable families. */
export function loadCatalog(baseUrl: string): Promise<CatalogEntry[]> {
  if (!catalogPromise) {
    catalogPromise = fetch(new URL('fonts/google-fonts-index.json', baseUrl))
      .then((res) => (res.ok ? (res.json() as Promise<CatalogEntry[]>) : []))
      .catch(() => []);
  }
  return catalogPromise;
}

// ---------------------------------------------------------------------------
// IndexedDB cache
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
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    // A private window or a storage-blocked context simply gets no cache.
    request.onerror = () => resolve(undefined);
  });
}

async function readCached(key: string): Promise<Uint8Array | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => {
      const value = request.result as ArrayBuffer | undefined;
      resolve(value ? new Uint8Array(value) : undefined);
    };
    request.onerror = () => resolve(undefined);
  });
}

async function writeCached(key: string, data: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    // A copy, because the caller may transfer the original to the worker.
    tx.objectStore(STORE).put(data.slice().buffer, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Bytes for a previously downloaded family, or undefined if never fetched. */
export function cachedFontBytes(family: string): Promise<Uint8Array | undefined> {
  return readCached(family);
}

export async function cachedFamilies(): Promise<string[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve((request.result as string[]) ?? []);
    request.onerror = () => resolve([]);
  });
}

export async function clearFontCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchBundledFont(baseUrl: string, file: string): Promise<Uint8Array> {
  const response = await fetch(new URL(file, baseUrl));
  if (!response.ok) throw new Error(`Could not load bundled font "${file}".`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetches a catalogue font, using the IndexedDB copy when there is one.
 *
 * Returns the bytes plus whether they came from cache, so the UI can say
 * "already available offline" rather than implying a download happened.
 */
export async function fetchCatalogFont(
  entry: CatalogEntry,
): Promise<{ data: Uint8Array; fromCache: boolean }> {
  const cached = await readCached(entry.family);
  if (cached) return { data: cached, fromCache: true };

  const response = await fetch(CDN + encodeURI(entry.path));
  if (!response.ok) {
    throw new Error(`Could not download ${entry.family} (HTTP ${response.status}).`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  await writeCached(entry.family, data);
  return { data, fromCache: false };
}

/**
 * Lists font families installed on the machine, where the browser allows it.
 *
 * Chrome's Local Font Access API needs a user gesture and a permission grant;
 * everywhere else this returns an empty list and the user loads files by hand.
 */
export async function querySystemFonts(): Promise<{ family: string; blob: () => Promise<Blob> }[]> {
  const api = (window as unknown as { queryLocalFonts?: () => Promise<FontDataLike[]> }).queryLocalFonts;
  if (!api) return [];
  try {
    const fonts = await api.call(window);
    const byFamily = new Map<string, FontDataLike>();
    for (const font of fonts) {
      // One face per family is enough for the picker; styles resolve later.
      if (!byFamily.has(font.family)) byFamily.set(font.family, font);
    }
    return [...byFamily.values()].map((font) => ({
      family: font.family,
      blob: () => font.blob(),
    }));
  } catch {
    return [];
  }
}

interface FontDataLike {
  family: string;
  fullName: string;
  style: string;
  blob(): Promise<Blob>;
}
