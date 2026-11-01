# @betterscad/engine

The BetterSCAD language and geometry engine as a library. Give it OpenSCAD
source, get back diagnostics, a Customizer model, meshes, and files to save.
No DOM, no bundler assumptions, no UI: the same code runs in Node, in a Web
Worker and in the browser's main thread.

It understands the whole OpenSCAD language plus BetterSCAD's extensions
(`negative()`, `cube(r)`, `polygon(r)`, `thread()`, `gear()`, `center()` and
the rest, all listed in the [language guide](https://github.com/theanam/betterScad/blob/main/docs/language.md)),
and it can write any BetterSCAD file back out as plain OpenSCAD.

It is the engine behind [betterscad.org](https://betterscad.org), the editor,
and the `bscad` command line.

```sh
npm install @betterscad/engine
```

## Quick start

```ts
import { Engine } from '@betterscad/engine';
import { writeFile } from 'node:fs/promises';

const engine = await Engine.create();
const result = await engine.render(`
  // Mounting plate
  width = 60;   // [20:120]
  holes = 4;    // [2:8]
  difference() {
    cube([width, 30, 4], r = 3);
    for (i = [0 : holes - 1])
      translate([8 + i * (width - 16) / (holes - 1), 15, -1]) cylinder(d = 3.4, h = 6);
  }
`, { parameters: { width: 80 } });

for (const d of result.diagnostics) console.log(d.severity, d.message);

const stl = engine.export(result, 'stl');
await writeFile(`plate.${stl.extension}`, stl.data);
```

In Node that is the whole setup. The geometry kernel is Manifold compiled to
WebAssembly, and it finds its own `.wasm` file.

### In the browser

A bundler moves the wasm file, so tell the engine where it went. With Vite:

```ts
import { Engine } from '@betterscad/engine';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

const engine = await Engine.create({ wasmUrl });
```

Rendering is synchronous CPU work once it starts. Put the engine in a Web
Worker and post source in and results out, so the page stays responsive; the
meshes are typed arrays and transfer without copying. The BetterSCAD app does
exactly this.

## What a render gives you

`engine.render(source, options)` returns one object with everything about the
model:

| Field | What it holds |
| --- | --- |
| `diagnostics` | Errors, warnings, `echo()` output. Each has a `severity`, a `message`, a stable `code`, and a `span` with file, line, column and offset. |
| `geometry.parts` | The solid, as one triangle mesh per colour: `positions` (interleaved xyz, `Float32Array`) and `triangles` (`Uint32Array`, counter-clockwise from outside), with an `[r, g, b, a]` colour. |
| `geometry.contours2d` | For a 2D model: closed outlines as point lists, per colour. |
| `geometry.annotations` | `%` background geometry, for drawing but never for export. |
| `geometry.dimension` | `3`, `2`, or `0` when there is nothing. |
| `geometry.stats` | Triangles, vertices, volume, area, node count. |
| `customizer` | The parameters the Customizer would show. See below. |
| `variables` | Every top-level variable's final value. |
| `measurements` | What each `get_size()` and `get_position()` measured. |
| `timings` | Parse, evaluate and geometry time in milliseconds. |

### Render options

```ts
await engine.render(source, {
  parameters: { width: 80, lid: true },   // override top-level assignments
  preview: true,      // $preview = true; overlapping solids are left separate (fast)
  merge: false,       // union into one solid per colour; defaults to !preview
  partial: true,      // keep drawing what still parses while a line is broken
  time: 0.25,         // $t, for animation
  varyColors: true,   // give every item its own colour, to tell parts apart
  file: 'plate.scad', // name used in diagnostics
  resolveInclude: async (path, fromFile) => await readLibrary(path),
  assets: { read: async (path) => await readBytes(path) },
});
```

`preview: true` is OpenSCAD's F5 and `preview: false` its F6. A preview can
leave overlapping pieces as they are because nothing downstream cares; a final
render unions them, which is what an exported file needs, since overlapping
shells read as cavities to a slicer.

## Checking source without rendering

`engine.compile(source, options)` does everything but mesh: parsing,
evaluation, diagnostics, the Customizer model, variables and measurements. It
is what an editor wants on every keystroke, and what a validator wants in CI.
The parser recovers from errors, so one broken line still yields diagnostics
for the whole file, and `omittedLines` says which lines were left out.

A plain `compile()` function is exported too, for when no kernel is loaded at
all; then `get_size()` reports `undef` and everything else works.

## Drawing it

The engine does not draw. It hands you meshes, and any renderer takes them.
With three.js:

```ts
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from 'three';

for (const part of result.geometry.parts) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(part.mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(part.mesh.triangles, 1));
  geometry.computeVertexNormals();
  const [r, g, b, opacity] = part.color;
  const material = new MeshStandardMaterial({ color: new Color(r, g, b), opacity, transparent: opacity < 1 });
  scene.add(new Mesh(geometry, material));
}
```

Index the mesh for a faceted look, or expand triangles to unshared vertices
first so that flat normals stay flat. The `display` field on each part says
whether it was marked `#` (highlight) or `%` (transparent).

## Exporting

```ts
const file = engine.export(result, '3mf', { unit: 'millimeter' });
// file.data: Uint8Array, file.mimeType, file.extension
```

Formats: `stl` (binary), `stl-ascii`, `3mf`, `off`, `amf` for solids; `svg` and
`dxf` for 2D models. 3MF and AMF keep colours, one volume per colour. Export
reads the geometry of a final render; export a preview and overlapping parts
come out overlapping.

## Building a Customizer

Every top-level assignment with a literal value is a parameter, and the
comments around it describe the control, exactly as in OpenSCAD's Customizer:

```scad
/* [Size] */
width = 60;          // [20:120]
style = "round";     // [round, square, hex]
engraved = true;
label = "A";         // 8
```

`result.customizer` (or `compile().customizer`) lists them:

```ts
for (const p of result.customizer.parameters) {
  // p.name, p.kind ('number' | 'slider' | 'checkbox' | 'text' | 'dropdown' | 'vector'),
  // p.defaultValue, p.group, p.min, p.max, p.step, p.options, p.description, p.line
}
```

Render with chosen values through the `parameters` option; nothing in the
source changes. To write the values back into the file, so that a saved copy
carries them, use `applyParametersToSource(source, result.parsed.file, values)`.

## Files, libraries and fonts

**Includes.** `include <lib.scad>` and `use <lib.scad>` call your
`resolveInclude(path, fromFile)` for the text. It is called for nested
includes too, so a resolver handles one hop. A path it cannot find comes back
as a diagnostic with `missingFile` set, so a front end can offer to add it.

**Imported files.** `import("part.stl")`, `import("outline.svg")` and
`surface("height.dat")` read bytes through the `assets` provider. STL, OBJ,
OFF, DXF and SVG are decoded by the engine. An image heightmap needs a
`decodeImage` on the provider that turns the bytes into 8-bit grayscale, so
that the engine carries no image codec; without one, `surface()` on an image
reports a diagnostic.

**Fonts.** `text()` needs a font, and none is bundled. Register TrueType or
OpenType files and pass the registry when creating the engine:

```ts
import { Engine, FontRegistry } from '@betterscad/engine';
import { readFile } from 'node:fs/promises';

const fonts = new FontRegistry();
fonts.register(await readFile('fonts/Inter-Regular.ttf'));   // first one becomes the default
const engine = await Engine.create({ fonts });
```

`text(font = "Inter:style=Bold")` resolves against the registered families
and falls back to the default family when the one asked for is missing.

## Plain OpenSCAD out

A file that uses BetterSCAD extensions can be written as stock OpenSCAD, with
each extension replaced by a generated module or a rewrite:

```ts
import { parse, transpileToLegacyScad, describeExtensions } from '@betterscad/engine';

const { file } = parse(source);
describeExtensions(file);               // which extensions the file uses, and where
const legacy = transpileToLegacyScad(file, { fonts, measurements: result.measurements });
legacy.source;                          // OpenSCAD 2021.01 reads this
```

Two rewrites need more than the text. `text(radius = …)` spaces glyphs by their
real widths, so it needs the fonts; `get_size()` needs the measurements from a
compile of the same source, and is written out as the value it measured. The
result says when either was missing rather than emitting a wrong file.

`parseBscad` and `serializeBscad` read and write the `.bscad` format, which is
the same source with a metadata header.

## Lower levels

Everything the top-level API is made of is exported, for tools that want a
piece of it:

- `lex`, `parse`: tokens and an error-recovering AST with spans.
- `evaluate`: AST to scene graph, with no geometry.
- `GeometrySession`, `buildGeometry`: scene graph to meshes on a kernel you manage, with shared parts built once.
- `BUILTIN_MODULES`, `BUILTIN_FUNCTIONS`, `BUILTIN_CONSTANTS`: every builtin with its parameters and defaults, for completion and signature help.
- `importSTL`, `importOBJ`, `importOFF`, `importDXF`, `importSVG`, `parseSurfaceDat`: the decoders on their own.
- `exportBinarySTL`, `exportOFF`, `exportAMF` and the others, taking meshes directly.
- `clipPolygons`: 2D boolean operations on polygon lists.
- `createZip`, `readZip`: a dependency-free zip reader and writer.

## Limits

- Fonts are not bundled; `text()` without a registered font is an error.
- Decoding images for `surface()` is left to the host.
- The engine does not draw. Pictures are the job of whatever renders the meshes.
- Third-party OpenSCAD libraries such as BOSL2 and MCAD are untested.
- A render runs to completion; there is no cancellation. Run it in a worker you can terminate.

## Versioning

The package version is the BetterSCAD version: the engine, the app and the CLI
are released together and tested together. The `.scad` the engine writes
targets OpenSCAD 2021.01.

## Feedback

Found a bug, or a model that renders differently from OpenSCAD?
[Open an issue](https://github.com/theanam/betterScad/issues).

## License

[MIT](https://github.com/theanam/betterScad/blob/main/LICENSE)
