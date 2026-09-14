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

### [→ Try it in your browser](https://betterscad.org)

No install, no sign-up. It loads a starter model you can edit straight away.

[Quick start](#quick-start) · [What's new in the language](#language-extensions) · [CLI](#command-line) · [Contributing](#contributing)

<br>

<img src="docs/images/screenshot.png" alt="The BetterSCAD editor: OpenSCAD source on the left with the Customizer beneath it, a shaded 3D preview of a parametric project box and its lid on the right, and a console showing echo output and render statistics." width="900">

</div>

---

## What it is

A CAD editor for the browser that speaks OpenSCAD. Open an existing `.scad` file
and it renders unmodified — the whole language is there, not a subset.

It also adds a few things OpenSCAD doesn't have, under one rule: **every addition
has a defined way back to plain `.scad`**, so nothing you write here can strand
you.

## Features

| | |
| --- | --- |
| **Runs on your machine** | No server, no account. Your models never leave the browser. |
| **Full OpenSCAD language** | Existing `.scad` files open and render unchanged. |
| **Real files** | Opens and saves straight to disk, with a download/upload fallback on Firefox and Safari. |
| **Live customizer** | Sliders and dropdowns generated from your `//` parameter comments. |
| **Modern editor** | Syntax highlighting, autocomplete with real signatures, tabs, inline errors. |
| **Preview and render** | `F5` previews, `F6` renders what Export writes. Auto-render keeps up as you type. |
| **Exports** | STL, 3MF, OFF, AMF for 3D; SVG and DXF for 2D; and plain `.scad`. |
| **Imports** | STL, OBJ, OFF, DXF, SVG, and heightmaps via `surface()`. |
| **Fonts for `text()`** | Some bundled for offline use, plus ~50 Google Fonts on demand. |
| **CAD navigation** | Turntable orbit with a corner view cube — click a face to snap to it, or drag it to orbit. |
| **Measurement** | Click points in the viewport for coordinates and distances. |
| **Animation** | `$t` playback in the app, frame export from the CLI. |
| **Works offline** | Installable, and fully functional with no network. |
| **Headless CLI** | `bscad model.scad -o model.stl`, for batch jobs and CI. |

## Quick start

Nothing to install — [open it in your browser](https://betterscad.org). First run
offers a sample model, a blank file, or a file from your disk.

To run it locally:

```sh
git clone https://github.com/theanam/betterScad.git
cd betterScad
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in packages/app/dist — serve it anywhere
```

## Language extensions

Everything OpenSCAD has, plus the following. Save as OpenSCAD `.scad` and these
are rewritten automatically; the editor shows you which lines will change first.

### `negative()` — turn anything into negative space

Wrap a shape in `negative()` and it stops being material and starts being a hole.
It gets carved out of everything else in the same scope, so holes can sit next to
the thing they go through instead of being hoisted into a `difference()` at the
top of the file.

![The same plate and cylinders, first as solids and then wrapped in negative(), where they become holes](docs/images/negative-extension.png)

```scad
union() {
  plate();
  boss();

  negative() {              // carved out of BOTH plate() and boss()
    translatez(-1) cylinder(h = 20, r = 5);
    for (i = [0:4]) rotatez(i * 72) translate(18, 0, -1) cylinder(h = 20, r = 2.5);
  }
}
```

"The same scope" means the enclosing `{ … }`, module body, or top level — a
negative never reaches further than the braces it was written in.

### Everything else

| Syntax | What it does | Becomes, in plain `.scad` |
| --- | --- | --- |
| `negative() { … }` | Turns anything inside it into negative space | `difference()` around the scope |
| `translate(x, y, z)`<br>`rotate(x, y, z)`<br>`mirror(x, y, z)` | Loose numbers, for when the brackets are just noise | `translate([x, y, z])`, and so on |
| `translatex(d)`<br>`translatey(d)`<br>`translatez(d)` | Move along one axis | `translate([d, 0, 0])`, and so on |
| `rotatex(a)`<br>`rotatey(a)`<br>`rotatez(a)` | Turn about one axis | `rotate([a, 0, 0])`, and so on |
| `mirrorx()`<br>`mirrory()`<br>`mirrorz()` | Flip across one plane | `mirror([1, 0, 0])`, and so on |
| `for (i = 0; i < n; i = i + 1)` | A C-style loop as a statement | A range `for` with the condition as a guard |
| `is_range(x)` | Tests for a range, like the other `is_*` functions | ⚠️ Nothing — it becomes `undef` in stock OpenSCAD |

Stock syntax is untouched: `rotate(a, v)` is still the axis rotation it always
was. Full details in [`docs/language.md`](docs/language.md).

## File formats

`.bscad` is the native format, and it *is* a `.scad` file — the extras (panel
layout, customizer presets, camera) live in a leading comment, so OpenSCAD opens
it unchanged.

Saving follows the extension: a `.bscad` keeps its extras, a `.scad` is saved as
plain source. **Save ▸ Save as OpenSCAD `.scad`** is the guaranteed-portable
version; it tells you what it will change, and a file that needs no changes is
saved byte for byte.

Opening a `.scad` that uses the extensions above warns you, naming the lines.

## Command line

```sh
bscad model.scad -o model.stl               # render to STL
bscad model.scad -D size=30 -D label='"v2"' # override parameters
bscad *.scad -f 3mf -o build/               # batch render
bscad anim.scad --frames 60 -o frames/      # animation frames
bscad model.bscad --legacy-scad -o out.scad # convert to plain OpenSCAD
bscad model.scad --strict                   # treat warnings as errors, for CI
```

## Browser support

| | Rendering | Direct file save | System fonts |
| --- | --- | --- | --- |
| Chrome / Edge | ✅ | ✅ | ✅ |
| Firefox | ✅ | Download / upload | Load font files |
| Safari | ✅ | Download / upload | Load font files |

Needs WebAssembly and WebGL2 — anything from roughly 2021 onwards.

## Status

Early but real: the language is complete, the app is usable, and the engine is
covered by tests. Not there yet:

- **Third-party libraries** (BOSL2, MCAD) are untested and unsupported.
- **Desktop builds** are scaffolded but not yet built — see [`docs/desktop.md`](docs/desktop.md).
- **A persistent library** of your own parts and snippets. Multi-file tabs and
  `include`/`use` across them already work.
- **`surface()` with image heightmaps** works in the browser but not in the CLI.

## Analytics

[betterscad.org](https://betterscad.org) counts page views with Google Analytics.
Nothing about your models is sent — no source, no geometry, no file names. Builds
you make yourself carry no analytics at all; the tag is added only by the deploy
workflow.

## Deploying

The site is fully static: `npm run build`, then serve `packages/app/dist`
anywhere. For GitHub Pages, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
publishes on every push to `main` with no repo settings to change.

## Contributing

Issues and pull requests welcome. One non-negotiable rule: **any new language
syntax ships with its plain-`.scad` downgrade**, implemented in
[`transpile.ts`](packages/engine/src/transpile.ts) and covered by a test proving
the rewrite is equivalent.

```sh
npm run typecheck
npm test
npm run build
```

How it all fits together: [`docs/architecture.md`](docs/architecture.md).

## Licence

[MIT](LICENSE).

The engine is written from scratch; no code is derived from the OpenSCAD project.
That is what makes the MIT licence possible — the CSG kernel is
[Manifold](https://github.com/elalish/manifold) (Apache-2.0) rather than CGAL.
Also uses [Three.js](https://threejs.org), [CodeMirror](https://codemirror.net)
and [opentype.js](https://opentype.js.org) (all MIT); bundled fonts are OFL-1.1.

Brand assets and tokens live in [`brand/`](brand/).
