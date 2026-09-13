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
      // Precache only the entry point; the rest is filled in as it is used,
      // which avoids guessing at hashed bundle names from here.
      await cache.addAll([SHELL, './manifest.webmanifest', './favicon.svg']).catch(() => undefined);
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
