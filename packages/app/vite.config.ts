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
    // `fonts/specimens.json` is deliberately absent: a quarter of a megabyte of
    // preview outlines is not worth a first visit from someone who may never
    // open the Fonts dialog. The worker's lazy path caches it once it is.
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
 * Everything that needs to know the site's own address.
 *
 * `base` is relative on purpose (see below), so the HTML has no idea what host
 * it will be served from — and a social card cannot be relative: Open Graph and
 * Twitter both require absolute image URLs, and a canonical link that is not
 * absolute says nothing. Only one build knows the answer, and it already writes
 * it down: `public/CNAME` is what GitHub Pages serves the site under, and the
 * deploy workflow calls it "the authoritative site URL" for its own summary.
 *
 * So the address is read from there rather than hardcoded. A fork with its own
 * CNAME gets its own card for free; a fork with none gets no absolute tags at
 * all, which is the honest outcome — a canonical pointing at betterscad.org
 * from someone else's deployment would be actively harmful, telling search
 * engines their copy is a duplicate of ours.
 *
 * The same reasoning as `analyticsTag()` below, for the same reason: this
 * repository is MIT and expects to be built by people who are not us.
 */
function siteMetadata(): Plugin {
  const site = resolveSiteUrl();

  return {
    name: 'betterscad:site-metadata',
    apply: 'build',

    transformIndexHtml(html) {
      // Read back out of the document rather than repeating them here. Social
      // copy that is written twice is social copy that disagrees with the page
      // as soon as either is edited, and the disagreement is invisible until
      // somebody shares a link.
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
      const description = /<meta\s+name="description"\s+content="([^"]*)"/s.exec(html)?.[1]?.trim();
      if (!title || !description) {
        throw new Error(
          'index.html is missing its <title> or meta description; the social tags are generated from them.',
        );
      }

      const meta = (attrs: Record<string, string>) => ({
        tag: 'meta',
        attrs,
        injectTo: 'head' as const,
      });

      const tags = [
        meta({ property: 'og:title', content: title }),
        meta({ property: 'og:description', content: description }),
        meta({ name: 'twitter:title', content: title }),
        meta({ name: 'twitter:description', content: description }),
      ];

      if (!site) return { tags };

      const socialImage = `${site}betterscad-social.png`;
      const imageAlt =
        'The BetterSCAD mark beside the words BetterSCAD and the tagline CODE IT. SEE IT. PRINT IT.';

      tags.push(
        { tag: 'link', attrs: { rel: 'canonical', href: site }, injectTo: 'head' as const },
        meta({ property: 'og:url', content: site }),
        meta({ property: 'og:image', content: socialImage }),
        meta({ property: 'og:image:width', content: '1280' }),
        meta({ property: 'og:image:height', content: '640' }),
        meta({ property: 'og:image:alt', content: imageAlt }),
        meta({ name: 'twitter:image', content: socialImage }),
        meta({ name: 'twitter:image:alt', content: imageAlt }),
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          children: JSON.stringify(structuredData(site, title, description)),
          injectTo: 'head' as const,
        },
      );
      return { tags };
    },

    generateBundle() {
      // No address, no sitemap: a `Sitemap:` line has to be absolute, and a
      // sitemap listing the wrong origin is worse than none.
      if (!site) {
        this.emitFile({
          type: 'asset',
          fileName: 'robots.txt',
          source: 'User-agent: *\nAllow: /\n',
        });
        return;
      }

      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`,
      });

      // One page, because the app is one page. The reference and the language
      // guide are Markdown on GitHub rather than routes here, so listing them
      // would be listing URLs this site does not serve.
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `  <url>\n    <loc>${site}</loc>\n` +
          `    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>\n` +
          '    <changefreq>weekly</changefreq>\n  </url>\n' +
          '</urlset>\n',
      });
    },
  };
}

/** `https://host/`, from an explicit override or the published CNAME. */
function resolveSiteUrl(): string | undefined {
  const override = process.env.BETTERSCAD_SITE_URL?.trim();
  if (override) return override.endsWith('/') ? override : `${override}/`;

  const cname = fileURLToPath(new URL('./public/CNAME', import.meta.url));
  if (!existsSync(cname)) return undefined;
  const host = readFileSync(cname, 'utf8').trim();
  // A CNAME is a bare hostname. Anything else is a file we do not understand,
  // and guessing at it would put a malformed canonical on every page.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}/` : undefined;
}

/**
 * Schema.org data for the search result.
 *
 * Deliberately only what is checkable: what it is, that it is free, what it
 * runs on, what licence it carries. No `aggregateRating` — there are no ratings
 * to report, and inventing them is both a lie and a manual action waiting to
 * happen.
 */
function structuredData(site: string, name: string, description: string): unknown {
  const { version } = JSON.parse(
    readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
  ) as { version: string };

  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'BetterSCAD',
    alternateName: name,
    url: site,
    image: `${site}betterscad-social.png`,
    description,
    applicationCategory: 'DesignApplication',
    applicationSubCategory: 'Computer-aided design',
    operatingSystem: 'Any modern web browser',
    browserRequirements: 'Requires JavaScript, WebAssembly and WebGL2',
    softwareVersion: version,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://opensource.org/licenses/MIT',
    codeRepository: 'https://github.com/theanam/betterScad',
    featureList: [
      'Full OpenSCAD language compatibility',
      'Runs entirely in the browser — no server and no account',
      'Live customizer generated from parameter comments',
      'Export to STL, 3MF, OFF, AMF, SVG and DXF',
      'Import STL, OBJ, OFF, DXF, SVG and heightmaps',
      'Project files shared across tabs, and saved as a zip',
      'Works offline',
    ],
  };
}

/**
 * BetterSCAD is a fully static site (spec features 1 and 7), so `base` is
 * relative: the same build works from a domain root, from a GitHub Pages
 * project path, and from `file://` in the desktop shell.
 */
export default defineConfig({
  base: './',
  // `siteMetadata` goes last on purpose: it emits `robots.txt` and
  // `sitemap.xml` during `generateBundle`, and `serviceWorkerManifest` builds
  // its precache list from whatever is in the bundle when *it* runs. Neither
  // file is any use offline, and the precache is a first-visit download.
  plugins: [serviceWorkerManifest(), referenceImages(), analyticsTag(), siteMetadata()],
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
  // Pinned, and pinned strictly: a sibling BetterSCAD checkout runs on Vite's
  // default 5173, and `strictPort` makes a clash fail loudly instead of
  // silently drifting to the next free port — which would leave the Tauri
  // dev shell and `npm run screenshot` pointing at the wrong server.
  server: { port: 5174, strictPort: true },
  // The engine is consumed as source in dev so edits hot-reload.
  optimizeDeps: { exclude: ['manifold-3d'] },
});
