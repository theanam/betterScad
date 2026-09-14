import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

/**
 * Where the reference screenshots are served from, matching `IMAGE_DIR` in
 * `src/reference/index.ts`.
 */
const REFERENCE_DIR = 'reference';

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
        // Nor the reference screenshots: see `referenceImages` for why.
        (name) =>
          name !== 'sw.js' && !name.endsWith('.map') && !name.startsWith(`${REFERENCE_DIR}/`),
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
 * Serves and publishes the reference screenshots.
 *
 * They live in `docs/images/reference/` rather than in `public/`, so that
 * `docs/reference.md` can reference them by an ordinary relative path and the
 * app and the document share one set of files. That is outside the app's root,
 * so dev needs a middleware and the build needs an emit; both are a few lines,
 * and the alternative is the same images committed twice.
 *
 * They are deliberately *not* added to the service worker's precache: seventy
 * screenshots is a lot to download on a first visit to pay for a dialog that
 * may never be opened. The worker's lazy cache-first path picks up the ones
 * actually looked at, which is what makes the reference work offline after it
 * has been read once.
 */
function referenceImages(): Plugin {
  const dir = fileURLToPath(new URL('../../docs/images/reference', import.meta.url));
  const prefix = `/${REFERENCE_DIR}/`;

  return {
    name: 'betterscad:reference-images',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        // Only ever a bare `name.png` under the prefix, so a crafted `..` in
        // the URL cannot walk out of the directory.
        const name = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
        if (!name || !/^[\w-]+\.png$/.test(name)) return next();

        const file = join(dir, name);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/png');
        res.end(readFileSync(file));
      });
    },

    generateBundle() {
      if (!existsSync(dir)) {
        this.warn('docs/images/reference is missing — run `npm run reference`.');
        return;
      }
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.png')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `${REFERENCE_DIR}/${name}`,
          source: readFileSync(join(dir, name)),
        });
      }
    },
  };
}

/**
 * Injects Google Analytics — and only into the deployed betterscad.org build.
 *
 * Gated on an environment variable that *only* `.github/workflows/deploy.yml`
 * sets, deliberately not on `import.meta.env.PROD`. A local `npm run build`
 * produces the same `dist/` the deploy publishes, so a production check would
 * put a tracking tag into every self-hosted and forked build of an MIT,
 * local-first tool. Anyone who builds this themselves gets no analytics, and
 * gets that without having to know to turn anything off.
 *
 * `apply: 'build'` keeps it out of the dev server even if the variable is
 * exported in the shell.
 */
function analyticsTag(): Plugin {
  const id = process.env.BETTERSCAD_GA_ID?.trim();
  // The id is interpolated into an inline script, so it is matched against the
  // exact shape of a GA4 measurement id rather than trusted.
  const valid = !!id && /^G-[A-Z0-9]{4,20}$/.test(id);

  return {
    name: 'betterscad:analytics',
    apply: 'build',
    transformIndexHtml() {
      if (!id) return;
      if (!valid) {
        throw new Error(
          `BETTERSCAD_GA_ID is set to "${id}", which is not a GA4 measurement id (G-XXXXXXXXXX). ` +
            'Refusing to inject it.',
        );
      }
      return {
        tags: [
          {
            tag: 'script',
            attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${id}` },
            injectTo: 'head' as const,
          },
          {
            tag: 'script',
            children:
              'window.dataLayer = window.dataLayer || [];\n' +
              'function gtag(){dataLayer.push(arguments);}\n' +
              "gtag('js', new Date());\n" +
              `gtag('config', '${id}');`,
            injectTo: 'head' as const,
          },
        ],
      };
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
  plugins: [serviceWorkerManifest(), referenceImages(), analyticsTag()],
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
