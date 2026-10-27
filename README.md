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

[Quick start](#quick-start) · [Reference](docs/reference.md) · [What's new in the language](#language-extensions) · [CLI](#command-line) · [Contributing](#contributing)

<br>

<img src="docs/images/screenshot.png" alt="The BetterSCAD editor: OpenSCAD source on the left with the Customizer and its generated sliders beneath it, a shaded 3D preview of a parametric project box and its lid on the right with an orientation cube in the corner, and a console showing echo output and render statistics." width="900">

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
| **A tour on first visit** | Ten slides of pictures showing what the app and the language additions can do, skippable at any step and shown once; *Take the tour* in the command palette brings it back. |
| **Full OpenSCAD language** | Existing `.scad` files open and render unchanged. |
| **Real files** | Opens and saves straight to disk, with a download/upload fallback on Firefox and Safari. |
| **Live customizer** | Sliders and dropdowns generated from your `//` parameter comments. |
| **Modern editor** | Syntax highlighting, autocomplete with every call form, suggested values for arguments that take a fixed set, the signature kept on screen while you fill a call in, tabs, inline errors. |
| **Type in inches** | `5in` becomes `127` as you type. The file stays in millimetres — see below. |
| **Built-in reference** | Every element of the language explained plainly, with a rendered example of each. `F1`, or the Help button. |
| **Preview and render** | `F5` previews, `F6` renders what Export writes. Auto-render keeps up as you type. |
| **Exports** | STL, 3MF, OFF, AMF for 3D; SVG and DXF for 2D; plain `.scad`; and PNG pictures — the current view or any named view at up to 4K, or a sheet of front, right, top and isometric views at one scale, on a transparent, white or themed background. |
| **Imports** | STL, OBJ, OFF, DXF, SVG, and heightmaps via `surface()`. |
| **Draw it** | A drawing board for outlines: lines, pen curves, boxes and circles, with measurements you type into. Trace over a picture scaled to a known distance, or let the picture trace itself. The drawing lands in the project as an SVG that `import()` extrudes. |
| **Project files** | Add images, drawings, meshes, fonts and libraries once; every tab reaches them by name, as though they sat in the same folder. |
| **Fonts for `text()`** | Name a font and it loads itself — ~50 Google Fonts, the ones installed on your machine, or a file of your own. Every one previewed in its own typeface. |
| **CAD navigation** | Turntable orbit with a corner view cube — click a face to snap to it, or drag it to orbit. |
| **Orthographic view** | One click flattens the view: no perspective, parallel edges stay parallel and sizes read true at any depth — what front and top views are for. Remembered across reloads. |
| **Arrange the panels** | Drag any panel — code, viewport, console, Customizer, Files — to either column, resize them, hide the code, or maximize one panel to fill the window. The Settings menu's Layout section has presets (model focus, code focus, tune parameters, mirrored) and a reset to default. Remembered across reloads. |
| **Measurement** | Click two points in the viewport for the distance between them. Points snap to corners, edges and faces, the line follows the pointer until the second click, Shift holds it to an axis, and every line carries its length. Esc leaves. |
| **Vary colours** | One click paints every item its own colour, so touching parts are easy to tell apart. Everything in one `union()` stays one colour; colours set with `color()` are kept. |
| **Animation** | `$t` playback in the app, frame export from the CLI. |
| **Works offline** | Installable, and fully functional with no network. |
| **Headless CLI** | `bscad model.scad -o model.stl`, for batch jobs and CI. |

## Reference

Every element of the language — the whole of OpenSCAD, plus everything BetterSCAD
adds — written for someone who has never used CAD, with a rendered example of
each. **[Read it here](docs/reference.md)**, or press `F1` in the app.

<img src="docs/images/reference-view.png" alt="The Help and Reference view: a searchable list of every language element on the left, and on the right the entry for cube() with its signature, a plain-language description, and two code examples each beside a rendered picture of the shape it makes." width="900">

The document and the app's Help view are generated from one catalogue, along with
every screenshot in them, so they cannot disagree with each other or with the
engine.

## Quick start

Nothing to install — [open it in your browser](https://betterscad.org). First run
offers a sample model, a blank file, or a file from your disk.

To run it locally:

```sh
git clone https://github.com/theanam/betterScad.git
cd betterScad
npm install
npm run dev          # http://localhost:5174
npm run build        # static site in packages/app/dist — serve it anywhere
```

## Language extensions

Everything OpenSCAD has, plus the following. Save as OpenSCAD `.scad` and these
are rewritten automatically. The console's **Info** tab lists what a file uses
and the lines it appears on, and previews the `.scad` it will become.

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
negative never reaches further than the braces it was written in. That limits
what it cuts, not what names it sees: a bare `{ … }` still lets its variables
out, exactly as in OpenSCAD.

### Everything else

| Syntax | What it does | Becomes, in plain `.scad` |
| --- | --- | --- |
| `negative() { … }` | Turns anything inside it into negative space | `difference()` around the scope |
| `cube(size, center, r)`<br>`square(size, center, r)` | The same box and rectangle, with a radius on the edges. `r = 0` is the stock shape | A hull of corner spheres or circles |
| `cube(size, center, r, centerxy, chamfer)`<br>`square(size, center, r, chamfer)` | `chamfer` cuts every edge flat at 45° instead of rounding it — the same word as on `cylinder()`. `chamfer = 0` is the stock shape | A hull of three boxes or two rectangles |
| `cube(…, centerxy = true)` | Centres a box on X and Y but keeps it standing on Z = 0, instead of half below the grid as `center = true` does | The box moved by half its width and depth |
| `cylinder(…, chamfer)`<br>`chamfer1`, `chamfer2`, `edge_style` | Takes the rim off either end — cut flat by default, or `edge_style = "round"`. `1` is the bottom and `2` the top, as with `r1`/`r2` | A revolve of the same profile |
| `linear_extrude(…, scale, ease)` | Curves a tapered extrusion into its ends instead of running dead straight. `ease = 0` is the stock shape; `[bottom, top]` eases each end on its own | A generated module stacking the same short extrusions |
| `text(…, radius)`<br>`start`, `facing` | Runs the writing around a circle instead of a straight line, spaced by real letter widths | Per-glyph `text()` calls, with the widths measured into the file |
| `regular_polygon(sides, length)` | An equilateral polygon — say the side length, not the radius | `circle()` at the matching radius, with `$fn = sides` |
| `thread(d, pitch, h)` | A screw thread. Add `internal = true` for the hole the same bolt screws into; `profile = "trapezoid"` or `"square"` and `crest = "round"` change the tooth | A generated module sweeping the profile up a twisted extrusion |
| `gear(m, teeth, h)` | An involute gear. Any two sharing a module mesh. Add `internal = true` for a ring gear, `helix` for a helical one | A generated module building the same involute profile |
| `translate(x, y, z)`<br>`rotate(x, y, z)`<br>`mirror(x, y, z)` | Loose numbers, for when the brackets are just noise | `translate([x, y, z])`, and so on |
| `translatex(d)`<br>`translatey(d)`<br>`translatez(d)` | Move along one axis | `translate([d, 0, 0])`, and so on |
| `rotatex(a)`<br>`rotatey(a)`<br>`rotatez(a)` | Turn about one axis | `rotate([a, 0, 0])`, and so on |
| `mirrorx()`<br>`mirrory()`<br>`mirrorz()` | Flip across one plane | `mirror([1, 0, 0])`, and so on |
| `get_size(object)`<br>`get_position(object)` | How big a part is, and where its lowest corner is, as `[x, y, z]` — `get_size(base()).z` to stack on it | ⚠️ The value it measured, fixed at the parameters the file was saved with |
| `center() { … }`<br>`centerx()`, `centery()`, `centerz()`, `centerxy()` | Centres everything inside on the first thing inside, on the named axes. It moves and does not group, so `difference() center() { … }` still subtracts and `hull() center() { … }` still hulls | ⚠️ `translate()` by the moves it measured, fixed at the parameters the file was saved with |
| `for (i = 0; i < n; i = i + 1)` | A C-style loop as a statement | A range `for` with the condition as a guard |
| `is_range(x)` | Tests for a range, like the other `is_*` functions | ⚠️ Nothing — it becomes `undef` in stock OpenSCAD |

Stock syntax is untouched: `rotate(a, v)` is still the axis rotation it always
was. The shapes get a generated module in the exported file — defined once and
called, so the export reads like what you wrote.

Every one of these, and every element of OpenSCAD itself, is written up with a
rendered example in [`docs/reference.md`](docs/reference.md) — the same content
the app shows under **Help** (`F1`). The implementation details are in
[`docs/language.md`](docs/language.md).

## Draw an outline and extrude it

Not every shape starts as code. **Draw** in the Files panel (or *New
drawing…* in the command palette) opens a drawing board: lines, a pen for
curves, boxes and circles, on a millimetre grid. Every segment carries its
length, every box its width, height and corner radius, every circle its
diameter — click a number and type a new one. An outline inside another is a
hole; overlapping outlines merge. Points snap to the grid and to the corners,
centres and edges of what is already drawn, with a guide line showing what
they lined up with; hold Alt to draw free.

Select several outlines (Shift+click, or drag a box around them) and **group**
them: a group moves and deletes as one, and inside-means-hole is judged within
it. The **eraser** takes a region out: click where two grouped circles overlap
and that lens is gone from the extrusion, while both circles stay circles you
can still move and resize. Click an erased region to put it back.

<img src="docs/images/drawing-board.png" alt="The drawing board: a box with a round hole and typed measurements, a triangle, and a curved outline drawn with the pen, over a faded reference picture." width="900">

**Done** writes the drawing into the project as an ordinary SVG and puts
`linear_extrude(5) import("drawing.svg");` at the cursor. The file is plain
SVG in millimetres — OpenSCAD reads it just the same — and it also carries
the editable drawing, so *Edit drawing* in the Files panel brings back the
boxes and curves, not the points they became.

**Trace a picture.** Load a photo or a scan behind the board and fade it.
To set its size, pick two points in it and type how far apart they really
are. Then draw over it, or have it traced for you: *Trace dark lines* outlines
the marks on a scan or a logo, and *Trace the subject* finds the main object
in a photograph — a small on-device model (U²-Net, Apache-2.0, 2.4 MB,
downloaded once on first use), with nothing sent anywhere. *Invert* traces
the other side: light marks on a dark ground, or the stencil around the
subject. Either way the result is lines and pen curves with the same anchors
and handles a pen drawing has — drag a handle to reshape a curve, Alt to break
a smooth point into a corner — not a cloud of points.

| Key | Does |
| --- | --- |
| `V` `L` `P` `R` `C` `E` | Pick, Lines, Pen, Box, Circle, Eraser |
| `Shift`+click · drag on empty board | Add to the selection · select what the box encloses |
| `⌘G` `⌘⇧G` `⌘A` | Group, ungroup, select all |
| `Enter` | Finish the line run or close the pen path |
| `Escape` | Drop the shape in progress, then the tool, then the selection |
| `Alt` (held) | Draw off the grid |
| Grid button | Snap to the grid, snap to other outlines, and the grid step from 0.1 to 10 mm; remembered |
| `Delete` | Remove the selected outline |
| Wheel · right-drag | Zoom · pan |

## Type in inches, keep a millimetre file

OpenSCAD has no units. Every number is a millimetre by convention, and the whole
ecosystem — printers, slicers, hardware tables — agrees. That leaves anyone
working from an imperial drawing doing arithmetic in their head, or scattering
`* 25.4` through the file, which is a thing to get wrong once and then never
notice again.

So the editor does the arithmetic. Type a measurement with a unit on it and it
converts the moment you finish the number:

```scad
plate = 6in;          ->  plate = 152.4;
bore  = 0.25inch;     ->  bore  = 6.35;
rod   = 1.5 inches;   ->  rod   = 38.1;
```

`in`, `inch` and `inches` all work, with or without a space. Nothing converts
until the measurement is finished — `5in` is also the first three characters of
`5inch` — so it waits for whatever you type next to end it: a comma, a bracket,
a semicolon, a newline.

**What lands in the file is a plain number.** This is an editor convenience and
nothing more: no unit is stored, nothing in the saved model depends on it, and a
file written this way opens in OpenSCAD with no idea it was ever typed in
inches. The converted number flashes briefly so you can see it happen, and a
single undo puts your `5in` back if you wanted the letters.

Off by default for nobody — it is on, and there is a switch in **Settings** if
you would rather it were not.

## Settings

The gear in the toolbar holds the handful of things the app asks rather than
assumes. None of them changes what a saved file means.

| | |
| --- | --- |
| **Theme** | Light or dark. |
| **Round dimensions** | Whether autocomplete offers `cylinder(h, d)` or `cylinder(h, r)` first. Both are right; people are firmly one or the other. |
| **Inch entry** | The conversion above. |
| **Tab completion** | Tab takes the open suggestion. With none open it indents, as it always did. |
| **Auto-render** | Re-render as you type, or only on `F5`. |
| **Indent** | Two spaces or four. |

## Project files

A model that says `import("bracket.stl")` needs a folder to find it in, and a
browser has none. The **Files** panel is that folder: add a file once and every
open tab can name it, exactly as it would on disk.

<img src="docs/images/files-panel.png" alt="The Files panel in the left column under the editor, listing plate.svg, terrain.png and — under an MCAD/ heading — knurl.scad, each with its kind and size. A filled dot marks plate.svg and knurl.scad as used by the model on screen and a hollow one marks terrain.png as unused. The editor shows a model that extrudes plate.svg and calls a module from the library, and the viewport shows the resulting plate with its bolt holes and a knurled post." width="900">

Drop files anywhere in the window, or use **Add files**. What goes in there:

| | Used by |
| --- | --- |
| `.png` `.jpg` `.dat` | `surface("terrain.png")` |
| `.svg` `.dxf` `.stl` `.obj` `.off` `.3mf` | `import("logo.svg")` |
| `.scad` `.bscad` | `use <MCAD/gears.scad>`, `include <…>` |
| `.ttf` `.otf` `.ttc` | `text("Hi", font = "Orbitron")` |

Folders work, and so does a bare name: `use <MCAD/gears.scad>` finds a file you
added as `gears.scad`. A library can be opened in a tab to edit — the tab is
then what your model renders against, and Save puts it back.

The files are kept in your browser, so they are still there after a reload.
Nothing is uploaded, here as everywhere else.

### Save as `.zip`

Once a model uses a project file, the Save menu offers **Save as `.zip`**: the
model plus every file it actually used, laid out so the paths in the script
resolve as they stand. Unzip it and it opens in OpenSCAD.

What goes in is what the render resolved, not what the text mentions — a library
three levels down an `include` chain is in, an `import` inside an `if` that never
ran is not.

Opening a `.zip` does the reverse: models at the top level become tabs and
everything else joins the Files panel.

Fonts are the one thing a zip cannot fully deliver. `text(font = "Orbitron")`
names a family, and OpenSCAD looks for families in its own font path rather than
beside the file. The font travels in `fonts/` with a note saying so.

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

The build has no fixed base URL — one `dist/` works from a domain root, from a
Pages project path and from `file://` in the desktop shell. The few tags that
*must* be absolute (`<link rel="canonical">`, the Open Graph image, the sitemap)
are therefore generated from `packages/app/public/CNAME`, which is the address
the site is actually served under. Point that file at your own domain and they
follow it; delete it and they are simply omitted, rather than pointing search
engines at ours and declaring your deployment a duplicate. `BETTERSCAD_SITE_URL`
overrides it if you serve from a path rather than a domain root.

## Contributing

Issues and pull requests welcome. Four non-negotiable rules:

1. **Any new language syntax ships with its plain-`.scad` downgrade**,
   implemented in [`transpile.ts`](packages/engine/src/transpile.ts) and covered
   by a test proving the rewrite is equivalent.
2. **The export has to read like the file that produced it.** A one-liner is
   rewritten in place; anything bigger becomes a generated module, defined once
   and called wherever the shape was used. Generated code is code someone will
   open.
3. **Any new element is documented before it ships.** Add it to the catalogue in
   [`packages/app/src/reference/`](packages/app/src/reference/) with a worked
   example, then run `npm run reference`. That renders its screenshot and
   regenerates [`docs/reference.md`](docs/reference.md), and the app's Help view
   picks it up from the same file. An element that is not in the reference is
   not finished, and CI fails if the reference is out of date.
4. **Every change moves the version**, by semver:
   - **minor** — anything a user can see in the editor, the language, or an
     extension: a new element, a new panel, a changed behaviour.
   - **patch** — a release that adds no capability: fixes, docs, chores.
   - **major** — a break in the language or in the file format, once there is a
     1.0 to break from. Below 1.0 semver puts those in **minor**, and so does
     this project: `cube(r)` replacing `rounded_cube()` is a 0.2 → 0.3.

   Run `npm run bump -- minor` (or `patch`, `major`). The number lives in eleven
   places — five manifests, a literal in the engine's API, and the lock file —
   so it is never edited by hand, and `npm run version:check` fails CI when any
   of them drifts.

```sh
npm run typecheck
npm test
npm run build
npm run reference          # after adding or changing any element
npm run bump -- minor      # or patch; never edit a version by hand
npm run screenshot         # retakes the README's app screenshots, needs `npm run dev`
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
