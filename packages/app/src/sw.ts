/// <reference lib="webworker" />
/**
 * Service worker for offline/PWA support (spec feature 17).
 *
 * The app is fully static and does all its work client-side, so once the shell,
 * the WASM kernel and the bundled fonts are cached it is genuinely functional
 * with no network at all.
 *
 * Strategy:
 *  - Navigations: network-first, falling back to the cached shell, so a deploy
 *    is picked up immediately but a flight is survivable.
 *  - Everything else: cache-first, because Vite fingerprints its assets and a
 *    given URL's contents never change.
 */

declare const self: ServiceWorkerGlobalScope;

const VERSION = 'betterscad-v1';
const SHELL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);

      // `sw-manifest.json` is generated at build time and lists every emitted
      // asset. Precaching here rather than relying on the lazy fetch path is
      // what makes the *first* visit survive going offline: on that visit the
      // worker is not yet controlling the page, so it never sees the app's own
      // requests for its JS and WASM.
      let files: string[] = [SHELL, './manifest.webmanifest', './favicon.svg'];
      try {
        const response = await fetch('./sw-manifest.json', { cache: 'no-cache' });
        if (response.ok) {
          const listed = (await response.json()) as string[];
          if (Array.isArray(listed) && listed.length > 0) files = listed;
        }
      } catch {
        // Fall back to the shell alone; the app still works online.
      }

      // One failed asset must not abort the whole install, so each is cached
      // independently rather than through `addAll`.
      await Promise.all(
        files.map(async (file) => {
          try {
            const response = await fetch(file, { cache: 'reload' });
            if (response.ok) await cache.put(file, response);
          } catch {
            // Skip it; the lazy fetch handler will pick it up later.
          }
        }),
      );

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Fonts fetched on demand are cached in IndexedDB by the app itself; caching
  // them here as well would double the storage for no benefit.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(VERSION);
          cache.put(SHELL, response.clone());
          return response;
        } catch {
          const cached = await caches.match(SHELL);
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(VERSION);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        return cached ?? Response.error();
      }
    })(),
  );
});

export {};
