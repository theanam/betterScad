import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

/**
 * Emits `sw-manifest.json`: the list of files the service worker precaches.
 *
 * Without it, offline support silently does not work. Asset filenames are
 * content-hashed, so the worker cannot know them; and on a first visit the
 * worker is not yet controlling the page, so its lazy cache-first path never
 * sees the app's own requests. Precaching at install is the only thing that
 * makes the very first visit survive going offline.
 */
function serviceWorkerManifest(): Plugin {
  // Files copied verbatim from `public/`, which never reach the bundle graph.
  const PUBLIC_ASSETS = [
    './',
    'manifest.webmanifest',
    'favicon.svg',
    // Brand art the UI references directly: the toolbar mark, the About
    // dialog's lockup, and the icons the install prompt reads.
    'betterscad-mark.svg',
    'betterscad-logo-dark.svg',
    'betterscad-logo-light.svg',
    'betterscad-icon-192.png',
    'betterscad-icon-512.png',
    'betterscad-icon-maskable-512.png',
    'apple-touch-icon.png',
    // The bundled fonts, so `text()` keeps working with no network.
    'fonts/NotoSans.ttf',
    'fonts/NotoSerif.ttf',
    'fonts/Inter.ttf',
    'fonts/JetBrainsMono.ttf',
    'fonts/google-fonts-index.json',
  ];

  return {
    name: 'betterscad:sw-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter(
        // The worker must not precache itself, and source maps are dead weight.
        (name) => name !== 'sw.js' && !name.endsWith('.map'),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'sw-manifest.json',
        source: JSON.stringify([...PUBLIC_ASSETS, ...emitted], null, 2),
      });
    },
  };
}

/**
 * BetterSCAD is a fully static site (spec features 1 and 7), so `base` is
 * relative: the same build works from a domain root, from a GitHub Pages
 * project path, and from `file://` in the desktop shell.
 */
export default defineConfig({
  base: './',
  plugins: [serviceWorkerManifest()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        // The service worker is a second entry point rather than a chunk: it
        // must be a standalone file, and it must sit at the deploy root so its
        // scope covers the whole app (spec feature 17).
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        manualChunks: {
          // Three and CodeMirror are large and change rarely; splitting them
          // keeps the app chunk small enough to re-download on every deploy.
          three: ['three'],
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/language',
            '@codemirror/autocomplete',
            '@codemirror/search',
            '@codemirror/lint',
          ],
        },
      },
    },
  },
  worker: { format: 'es' },
  server: { port: 5173 },
  // The engine is consumed as source in dev so edits hot-reload.
  optimizeDeps: { exclude: ['manifold-3d'] },
});
