<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/betterscad-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/betterscad-logo-light.svg">
  <img src="brand/betterscad-logo-light.svg" alt="BetterSCAD" width="420">
</picture>

**A modern, local-first CAD editor for the browser — fully compatible with OpenSCAD.**

Write parametric models in the OpenSCAD language, see them render instantly, and export
to STL, 3MF, OFF, AMF, SVG or DXF. Everything runs on your machine. There is no server,
no account, and nothing is uploaded.

[Quick start](#quick-start) · [Why](#why-another-openscad) · [Architecture](#architecture) · [CLI](#command-line) · [Contributing](#contributing)

</div>

---

## What it is

BetterSCAD is a from-scratch reimplementation of the OpenSCAD language and geometry
pipeline, built to run as a static site. Open an existing `.scad` file and it renders
unmodified — the language surface is implemented in full, including `$fn`/`$fa`/`$fs`,
the `% # ! *` modifiers, `hull()`, `minkowski()`, extrusions, `projection()`, `text()`,
list comprehensions, `each`, recursion, function literals, `assert`, and DXF/SVG import.

It is also a place to make the language *better*, under one hard rule: **every extension
ships with a defined way back to plain `.scad`**. Nothing gets added without an answer to
"how does this degrade to vanilla OpenSCAD?"

## Features

| | |
| --- | --- |
| **Local-first** | Fully static. No backend, no database, no telemetry. Deploys to GitHub Pages. |
| **Complete OpenSCAD language** | Existing `.scad` files open and render with zero modification. |
| **Real file access** | Opens and saves files directly on disk via the File System Access API, with a download/upload fallback for Firefox and Safari. |
| **Live customizer** | Auto-generates sliders, dropdowns and checkboxes from `//` parameter annotations, using OpenSCAD's own conventions. |
| **Modern editor** | CodeMirror 6 with OpenSCAD syntax highlighting, autocomplete with real signatures, multi-file tabs, and inline error squiggles. |
| **Fast + precise renders** | `F5` preview and `F6` full render, mirroring OpenSCAD, exposed to scripts as `$preview`. |
| **Exports** | STL (binary + ASCII), 3MF, OFF, AMF for 3D; SVG and DXF for 2D. |
| **Imports** | STL, OBJ, OFF meshes; DXF and SVG outlines; `.dat` and image heightmaps via `surface()`. |
| **Fonts for `text()`** | A curated set bundled for offline use, plus ~50 Google Fonts families fetched on demand and cached in IndexedDB. |
| **Measurement** | Click vertices in the viewport to read coordinates, deltas and distances. |
| **Animation** | `$t` playback in-app, and frame-sequence export from the CLI. |
| **Offline / PWA** | Installable, and fully functional with no network. |
| **Headless CLI** | `bscad model.scad -o model.stl` for CI and batch generation. |

## Quick start

```sh
git clone https://github.com/<you>/betterscad.git
cd betterscad
npm install
npm run dev          # http://localhost:5173
```

Build the static site:

```sh
npm run build        # output in packages/app/dist — serve it anywhere
```

Run the tests:

```sh
npm test             # 59 engine tests: language semantics, geometry, exports
```

## Why another OpenSCAD?

OpenSCAD is excellent and this is not a criticism of it. BetterSCAD exists because a
few things are only possible with a clean-room implementation:

- **It runs anywhere a browser does**, including machines where you cannot install
  software, with the same files and the same language.
- **The engine is a library.** Parsing and geometry are decoupled from the UI and
  compiled to WebAssembly, so other tools can embed them.
- **The licensing is unencumbered.** No code is reused from the OpenSCAD project, and
  the CSG kernel is [Manifold](https://github.com/elalish/manifold) (Apache-2.0) rather
  than CGAL (GPL). That is what makes the MIT licence here possible, and what leaves room
  to extend the language.

## Architecture

```
packages/
├── engine/   The language and geometry engine. UI-agnostic, embeddable.
│             Hand-written lexer → parser → evaluator → scene graph → Manifold.
├── app/      The web app. CodeMirror 6 editor, Three.js viewport, panels.
│             The engine runs in a Web Worker, so geometry never blocks typing.
├── cli/      `bscad`, the headless renderer.
└── desktop/  Tauri shell around the same bundle. Scaffolded, not yet built.
```

Two design decisions are worth calling out.

**The parser is entirely hand-written.** Recursive descent for statements, precedence
climbing for expressions, with error recovery so the editor can show every problem in a
file at once instead of stopping at the first. No grammar, tables or code are derived
from upstream OpenSCAD.

**Modifiers are roles, not special cases.** OpenSCAD hardcodes `%`, `#`, `!` and `*`
throughout its CSG evaluator. BetterSCAD gives every scene node a list of *role* names,
and the evaluator dispatches on what a role declares:

```ts
defineRole({
  name: 'negative',
  contribution: 'subtractive',   // subtracted from every sibling in scope
  display: 'transparent',
  legacy: { transpile: 'Rewrite the enclosing scope as difference() { … }' },
});
```

Registering a role *requires* a legacy downgrade path — it is enforced at registration,
not documented and hoped for. The `negative()` extension below was added as a registry
entry and a transpiler rule; the CSG evaluator itself was not touched.

See [`docs/architecture.md`](docs/architecture.md) for the full pipeline.

## The `negative()` extension

A `negative()` subtree becomes negative space, subtracted from everything else in its
scope. It lets cutting features live next to the things they cut, instead of being
hoisted into a `difference()` at the top of the file:

```scad
union() {
  plate();
  boss();

  negative() {              // subtracted from BOTH plate() and boss()
    translate([0, 0, -1]) cylinder(h = 20, r = 5);
    for (i = [0:4]) rotate([0, 0, i * 72]) translate([18, 0, -1]) cylinder(h = 20, r = 2.5);
  }
}
```

Exporting to legacy `.scad` rewrites it as a `difference()` that produces **byte-identical
geometry** — the round trip is covered by a test.

## Command line

```sh
bscad model.scad -o model.stl               # render to STL
bscad model.scad -D size=30 -D label='"v2"' # override parameters
bscad *.scad -f 3mf -o build/               # batch render
bscad anim.scad --frames 60 -o frames/      # animation frames
bscad model.bscad --legacy-scad -o out.scad # transpile to plain OpenSCAD
bscad model.scad --strict                   # treat warnings as errors, for CI
```

## File formats

`.bscad` is the native format and a **strict superset of `.scad`**: it is an OpenSCAD file
with a metadata header in a leading block comment, holding panel layout, customizer presets
and camera state. Stock OpenSCAD reads it unchanged, because a comment is just a comment.
`.scad` remains fully supported for both import and export.

## Browser support

| | Rendering | Direct file save | System fonts |
| --- | --- | --- | --- |
| Chrome / Edge | ✅ | ✅ | ✅ |
| Firefox | ✅ | Download / upload | Load font files |
| Safari | ✅ | Download / upload | Load font files |

Requires WebAssembly and WebGL2 — that is, anything from roughly 2021 onwards.

## Status

Early but real: the language is implemented in full, the app is usable, and the engine is
covered by tests. Not yet done:

- **Third-party libraries** (BOSL2, MCAD) are deferred past v1 — untested, not supported.
- **Desktop packaging** is scaffolded in `packages/desktop` (Tauri, hosting the same
  bundle) but has not been built or run — there is no Rust toolchain in the environment it
  was written in. See [`docs/desktop.md`](docs/desktop.md).
- **Project/library management** (feature 16) is partial: multi-file tabs, cross-tab
  `include`/`use` resolution and drag-and-drop assets work; a persistent user library with
  versioning and snippet sharing does not exist yet.
- **`surface()` with image heightmaps** works in the browser, which has an image decoder;
  the CLI reports a clear error rather than bundling an image codec.
- **Brand assets are provisional** — see [Brand](#brand) below.

## Contributing

Issues and pull requests are welcome. The one non-negotiable rule: **any new language
syntax must ship with its legacy `.scad` downgrade path**, implemented in
[`packages/engine/src/transpile.ts`](packages/engine/src/transpile.ts) and covered by a
test that proves the rewrite is equivalent.

```sh
npm run typecheck    # type-check every package
npm test             # engine test suite
npm run build        # engine + static site
```

## Licence

[MIT](LICENSE).

The engine is written from scratch; no code is derived from the OpenSCAD project.
Third-party components: [Manifold](https://github.com/elalish/manifold) (Apache-2.0),
[Three.js](https://threejs.org) (MIT), [CodeMirror](https://codemirror.net) (MIT),
[opentype.js](https://opentype.js.org) (MIT). Bundled fonts are OFL-1.1.

Brand assets live in [`brand/`](brand/) — see [`brand/README.md`](brand/README.md).

## Brand

The mark is the canonical CSG operation drawn literally: an isometric cube with a
spherical cavity cut out of it. Amber is *solid*, cyan is *cut*, and that pairing runs
from the logo through to the viewport's default material and the `#` highlight colour.

These assets were authored from scratch as a **provisional** identity. Everything
downstream reads from [`brand/tokens.css`](brand/tokens.css), so replacing them is a
one-file change. See [`brand/README.md`](brand/README.md) for the full system and usage
rules.
