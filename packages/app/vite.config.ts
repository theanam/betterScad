import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * BetterSCAD is a fully static site (spec features 1 and 7), so `base` is
 * relative: the same build works from a domain root, from a GitHub Pages
 * project path, and from `file://` in the desktop shell.
 */
export default defineConfig({
  base: './',
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
