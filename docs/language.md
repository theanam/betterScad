# Language reference

BetterSCAD implements the OpenSCAD language in full. This page covers what is
supported, the handful of places where behaviour is worth pinning down, and the
extensions BetterSCAD adds on top.

Looking for what a particular call does, with a picture of what it makes?
That is [`reference.md`](reference.md), which is generated from the same
catalogue as the app's **Help & Reference** view. This page is the
implementation-facing companion to it.

## Compatibility

Everything below is implemented and covered by tests:

**Primitives** — `cube`, `sphere`, `cylinder`, `polyhedron`, `square`, `circle`,
`polygon`, `text`, `import`, `surface`

**Transforms** — `translate`, `rotate`, `scale`, `resize`, `mirror`,
`multmatrix`, `color`, `offset`

**Booleans and combinators** — `union`, `difference`, `intersection`, `hull`,
`minkowski`, `render`

**2D ↔ 3D** — `linear_extrude` (with `twist`, `slices`, `scale`, `v`),
`rotate_extrude` (with `angle`, `start`), `projection` (with `cut`)

**Control flow** — `if`/`else`, `for`, `intersection_for`, `let`, C-style `for`,
list comprehensions with `for`, `if`/`else`, `let` and `each`

**Definitions** — `module`, `function`, function literals (`function (x) …`),
recursion, `children()` with index/range/vector selectors, `$children`

**Special variables** — `$fn`, `$fa`, `$fs`, `$t`, `$preview`, `$children`,
`$vpr`, `$vpt`, `$vpd`, `$vpf`

`$preview` is `true` for `F5` and for the app's auto-render, `false` for `F6`
and for every export. Unlike stock OpenSCAD, where F5 and F6 use different
geometry kernels, BetterSCAD produces an exact mesh either way — so the two
differ *only* for scripts that read `$preview` and simplify themselves:

```scad
$fn = $preview ? 12 : 96;   // 140 triangles while editing, 9212 on export
sphere(10);
```

**Constants** — `PI`, plus the `true` / `false` / `undef` literals

**Modifiers** — `%` background, `#` highlight, `!` root, `*` disable

**Functions** — the full standard library: trigonometry, `pow`, `sqrt`, `ln`,
`log`, `exp`, `min`, `max`, `norm`, `cross`, `len`, `concat`, `str`, `chr`,
`ord`, `lookup`, `search`, `rands`, the `is_*` predicates, `version`,
`version_num`

**Other** — `include`, `use`, `assert`, `echo`, legacy `assign()`

## Behaviour worth pinning down

These are the places where an implementation can differ subtly. BetterSCAD
matches OpenSCAD on all of them, and each has a test.

### Assignments are scope-wide

Every assignment in a scope is evaluated before any geometry statement runs, in
source order. The last assignment to a name wins for the whole scope:

```scad
a = 1;
echo(a);    // 2
a = 2;
```

But assignments still evaluate in order, so an earlier read sees the earlier
value:

```scad
a = 1;
b = a;      // b is 1
a = 2;
echo(b, a); // 1, 2
```

### `$`-variables are dynamically scoped

```scad
$depth = 1;
plain   = 1;
module inner() { echo($depth, plain); }
module outer() { $depth = 2; plain = 2; inner(); }
outer();    // 2, 1
```

`$depth` follows the call chain. `plain` resolves where `inner` was *defined*.

### `^` binds tighter than unary minus

`-2 ^ 2` is `-4`. Exponentiation is right-associative: `2 ^ 3 ^ 2` is `512`.

### `PI` is the only built-in constant

`PI` resolves below every user scope, so a script may shadow it:

```scad
echo(PI);   // 3.14159
PI = 3;
echo(PI);   // 3
```

There is no `E`, and **no `inf` or `nan` identifiers**. Those values exist, but
you produce them arithmetically:

```scad
echo(1/0, -1/0, 0/0);   // inf, -inf, nan
```

Defining `inf`/`nan`/`E` as identifiers would be a language extension, and would
need a legacy downgrade path under the rule below — so BetterSCAD does not.

### `text()` aligns against font metrics, not ink

`valign` is measured against the font's ascender/descender band, not the ink of
the particular string. So `text("Ag")` and `text("xx")` receive the same
vertical offset, and a line of text does not jump when you type a descender.

| `valign` | Places at y = 0 |
| --- | --- |
| `"baseline"` (default) | the baseline |
| `"top"` | the ascender line |
| `"center"` | the midpoint of the descender..ascender band |
| `"bottom"` | the descender line |

Because the band includes the full descent, centred text with no descender —
`text("ABC", valign = "center")` — sits very slightly above the visual middle of
its own ink. That is correct, and it is what keeps a run of text steady as its
characters change.

`halign` shifts by the advance width, which includes the trailing sidebearing,
for the same reason.

The `font` argument is `"Family"`, or `"Family:style=Style"` for anything other
than Regular. The app's **Fonts** dialog previews each face in its own typeface
and shows the exact snippet, with Copy and Insert buttons, so the spelling never
has to be guessed.

### `round()` rounds half away from zero

`round(2.5)` is `3`, `round(-2.5)` is `-3`. (JavaScript's `Math.round` would
give `-2`.)

### Trig snaps to exact zero

`sin(180)` is exactly `0`, not `1.2e-16`. Without this, float noise propagates
into every downstream polygon and shows up as non-planar faces and failed
booleans.

### `search()` with the default `num_returns_per_match`

A miss contributes nothing to the result. That is what makes `search` usable for
filtering, but it means you cannot compare result length to needle length to
detect misses.

### `rands()` seeding

Seeded sequences use mt19937, the same core generator OpenSCAD seeds, so results
are reproducible and principled. Exact parity with OpenSCAD's distribution
mapping is not claimed.

## Extensions

Every extension has a defined downgrade path to plain `.scad`, enforced at role
registration and implemented in `transpile.ts`. `is_range()` is the one
exception, and is called out as such below.

Two rules govern what the export looks like. A one-liner is rewritten in place.
Anything larger becomes a **generated module**, named `__<shape>` and defined
once however many times it is used, so the exported file keeps the shape of the
file that produced it. A generated name that the source already declares gets a
numbered suffix rather than shadowing it.

| Extension | Downgrade |
| --- | --- |
| [`negative()`](#negative) | `difference()` around the scope |
| [`cube(r)` / `square(r)`](#cuber-and-squarer) | module: a hull of corner spheres or circles |
| [`cylinder(fillet)`](#cylinderfillet) | module: a revolve of the same profile |
| [`text(radius)`](#textradius) | module: per-glyph `text()`, with the widths measured in |
| [`regular_polygon()`](#regular_polygon) | module: `circle()` with `$fn = sides` |
| [`thread()`](#thread) | module: the same profile swept up a twisted extrusion |
| [Loose-number transforms](#loose-number-transforms) | components collected into a vector |
| [Single-axis transforms](#single-axis-transforms) | the stock call with zeros in the other slots |
| [C-style statement `for`](#c-style-statement-for) | bounded range `for` with the condition as a guard |
| [`is_range()`](#is_range) | none — left as written |

### `negative()`

Turns anything inside it into negative space. It is carved out of everything
else in the same scope, so the holes can sit next to the thing they go through:

```scad
union() {
  plate();
  boss();
  negative() cylinder(h = 20, r = 5);   // cuts BOTH plate() and boss()
}
```

**Scope is the enclosing braces.** A negative reaches exactly as far as the
`{ … }` block, module body, or top level it is written in — never further. It is
global only when written at the top level.

Wrappers that are *not* scopes are transparent to it: `translate`, `rotate`,
`color`, `if`, `for` and `let` pass the negative through to the enclosing scope,
carrying their transforms with it. So these two cut identically:

```scad
union() {
  cube(10);
  translate([5, 0, 0]) negative() cube(10);   // bubbles out to the union
}

union() {
  cube(10);
  negative() translate([5, 0, 0]) cube(10);   // written at the scope directly
}
```

Adding braces makes the wrapper a scope, which contains the negative:

```scad
union() {
  cube(10);
  translate([5, 0, 0]) { negative() cube(10); }   // cuts nothing; warns
}
```

A module body is always a scope, braced or not, so a `negative()` inside a
module can never reach out and cut its caller. A negative that reaches its scope
with nothing to cut produces no geometry and reports a warning.

**Downgrade:** the enclosing scope is rewritten as
`difference() { union() { …siblings… } …negatives… }`, with each cutter keeping
the wrappers it was written under. Geometry is identical — the round trip is
covered by tests for every nesting case above.

### C-style statement `for`

Stock OpenSCAD allows `for (i = 0; i < n; i = i + 1)` only inside list
comprehensions. BetterSCAD also accepts it as a statement.

**Downgrade:** rewritten as a bounded range `for` with the condition as a guard,
and the original is preserved in a comment. This is exact only for the common
`i = start; i < limit; i = i + step` shape, so the export reports it.

### `cube(r)` and `square(r)`

The corner radius lives on the shapes themselves rather than in a second pair of
names. `cube(size, center, r)` and `square(size, center, r)` are the stock
primitives with one argument added:

```scad
square([30, 20], r = 5);              // 30 x 20, corners of radius 5
square(20, center = true, r = 4);     // a 20 x 20 square about the origin
cube([40, 30, 12], r = 3);
cube(10, true, 2);                    // positionally: size, center, r
```

**`r` is the third argument, after `center`.** `cube(10, true)` has meant one
thing since OpenSCAD was written and still does, so the radius takes the slot
after it rather than in front. Named arguments avoid the question.

`r` defaults to `0`, and at `0` these *are* the stock primitives: the call is
not reported as an extension and the file exports byte for byte. A file only
becomes a BetterSCAD file once it actually rounds something.

`r` is clamped to half the shortest side, with a warning — beyond that there is
no straight section left to round. At exactly half, the corners meet and the
shape is a stadium (2D) or a capsule (3D).

`cube(r = …)` rounds every edge. For a box with rounded sides and a flat top,
extrude a rounded square instead:

```scad
linear_extrude(height = 16) square([44, 30], r = 6);
```

Both are built as the hull of their corner primitives, which *is* the Minkowski
sum of the box and a disc or sphere, without the cost of computing one. The
resolution of the rounding follows `$fn`/`$fa`/`$fs` as usual.

**Downgrade:** a generated module using the same hull — and nothing at all when
`r` is absent, because there is nothing to rewrite.

**Replaces `rounded_square()` and `rounded_cube()`**, which are gone. Calling
either reports an error naming the argument to use instead.

### `cylinder(fillet)`

The rim at either end of a cylinder, eased:

```scad
cylinder(h = 24, r = 10, fillet = 3);                           // both ends
cylinder(h = 24, r = 10, fillet2 = 6);                          // top only
cylinder(h = 24, r = 10, fillet = 3, fillet_style = "chamfer"); // cut flat
cylinder(h = 24, r1 = 14, r2 = 6, fillet = 2.5);                // on a taper
```

`fillet` sets both ends; `fillet1` and `fillet2` override the bottom and the
top. **They are numbered the way `r1` and `r2` already are** — 1 is the bottom,
2 is the top — because this module has one convention for "both, or each" and a
second one would have to be remembered separately.

`fillet_style` is `"round"` (the default), a true arc tangent to both the wall
and the end face, or `"chamfer"`, the straight chord across that same arc. One
argument rather than two shapes, because it is one construction: the tangent
points are the same either way.

It is exact on a cone as well as a cylinder. On a taper the corner is not a
right angle, so the arc meeting both edges is not a quarter circle; the profile
is solved for the actual angle rather than assumed to be square.

A fillet larger than the end it eases is clamped to fit, with a warning. With no
fillet — or `fillet = 0` — this is the stock primitive, exported byte for byte;
zero takes the same branch in the engine and in the generated module, so it is
one shape rather than two that merely measure the same.

**Downgrade:** a generated module that revolves the profile, and nothing when no
fillet is given.

### `text(radius)`

Lays a line of writing on a circle rather than a straight baseline:

```scad
text("BETTERSCAD", size = 5, radius = 20, halign = "center");
text("BATTERY CAP", size = 5, radius = 22, halign = "center",
     start = 270, facing = "in");
```

`start` is the angle the run begins at, in degrees, and defaults to `90` — the
top. `facing` is `"out"` (default), letters standing away from the centre, or
`"in"`, letters facing it; the far side of a dial wants `"in"` so the words stay
the right way up.

`halign` keeps its meaning, measured around `start` instead of around x = 0, and
`valign` still shifts the baseline — which out here moves it towards or away
from the centre.

Letters are spaced by their real widths, so an `i` takes less arc than an `M`.
Each is placed at the middle of its own width and turned to the tangent. **The
letters themselves are not bent**, so a tight circle with large text shows gaps
at the cap line; more radius or less size is the fix. Bending the outlines would
look better and could only ever be exported as raw polygons, which is the trade
this declines.

A radius of zero is an error, and `radius` cannot be combined with a vertical
`direction`.

**Downgrade:** a generated module placing each glyph with its own `text()` call.
OpenSCAD has no way to measure a glyph — `textmetrics()` is not in the 2021.01
release — so the widths are measured when the file is written and carried into
it as a table. Size, spacing, radius, start and even the string stay live in the
exported file; only the measurements are fixed.

Because it needs measuring, **saving as `.scad` needs the font loaded**. Without
it the export refuses and says so, rather than writing the text in the wrong
places. The command line takes `--font` as it already does for rendering.

### `regular_polygon()`

`regular_polygon(sides, length)` — an equilateral polygon described the way you
would measure one, by the length of a side rather than by a radius:

```scad
regular_polygon(6, 10);   // a hexagon whose every side is 10
```

Fewer than three sides cannot close a shape, and a side length of zero or less
has no shape to describe; both are errors rather than an empty result.

**Downgrade:** a generated module wrapping `circle($fn = sides)` at the
circumradius `length / (2 * sin(180 / sides))`.

### `thread()`

`thread(d, pitch, h)` — a helical screw thread, described the way a fastener is:
the diameter across the crests and how far one turn advances. An M8 bolt is
`d = 8, pitch = 1.25`. There is no table of standard sizes to look a name up in.

```scad
thread(d = 8, pitch = 1.25, h = 20);   // an M8 threaded rod
```

The thread is right-handed, single start, and sits on a solid core, so this is
already a rod rather than something to wrap around a shaft.

`internal = true` builds **the solid to subtract**, not the nut — so the hole
goes where the hole is:

```scad
union() {
  cylinder(h = 8, r = 7);
  negative() thread(d = 8, pitch = 1.25, h = 8, internal = true);
}
```

The bolt above screws into that. The two are the same construction with one
number changed — `clearance` (default `0.2`) grows the internal thread and
nothing else, so a bolt always measures the `d` you asked for. The clearance is
uniform rather than merely radial: the female groove is wider across the flanks
as well as deeper, which is what actually lets the pair turn. Setting it to `0`
gives a geometrically exact pair, which will not assemble in any real material.

`chamfer` (default `true`) shapes the ends, in opposite directions for the two
kinds. An external thread tapers in, so its first turn runs out instead of
ending in a knife edge that will not print. An internal one flares into a
countersink, which is what lets a bolt start square rather than cross-threading.
Turn it off for a thread that continues into adjoining geometry.

`angle` (default `60`, the ISO metric profile; 29 is roughly an Acme leadscrew)
is the included angle of the tooth, and `center` behaves as it does for
`cylinder()`. `segments` is the number of facets per turn: it follows
`$fn`/`$fa`/`$fs` but never drops below 24, because a coarse circle is merely
faceted while a coarse helix stops being a thread at all. A thread dense enough
to be slow says so rather than just being slow.

A pitch too coarse for the diameter, or a clearance large enough to close the
groove up, are errors rather than a shape that is quietly not a thread.

**Downgrade:** a generated module sweeping the same profile up the same twisted
extrusion.

### Loose-number transforms

`translate`, `rotate` and `mirror` also take their components as separate
numbers, for when the brackets are just noise:

```scad
translate(10, 5, 2) cube(4);     // same as translate([10, 5, 2])
rotate(0, 0, 90) cube(4);        // same as rotate([0, 0, 90])
mirror(1, 0, 0) cube(4);         // same as mirror([1, 0, 0])
translate(10, 5) cube(4);        // z defaults to 0
```

Stock spellings are untouched. `rotate(a, v)` is still the axis rotation, and a
single argument still means what it always did — the loose form only applies from
the second argument onwards.

**Downgrade:** the numbers are collected back into a vector. Exact.

### Single-axis transforms

One call per axis, so the axis is named rather than counted out in commas:

| | | |
| --- | --- | --- |
| `translatex(d)` | `translatey(d)` | `translatez(d)` |
| `rotatex(a)` | `rotatey(a)` | `rotatez(a)` |
| `mirrorx()` | `mirrory()` | `mirrorz()` |

```scad
translatex(20) rotatez(45) cube(4);
mirrorx() part();                    // flipped across the YZ plane
```

The mirrors take no argument: they name a plane, not a distance.

**Downgrade:** `translatex(d)` becomes `translate([d, 0, 0])`, `mirrorz()`
becomes `mirror([0, 0, 1])`, and so on. Exact.

### `is_range()`

A type predicate for range values, matching the other `is_*` functions.

**Downgrade:** none — this is the one extension without a way back. Calls are
left as written and evaluate to `undef` in stock OpenSCAD, and you are *not*
warned about it on export, so avoid it in files you intend to share.

## Limits

Deliberate guards against a runaway script taking down the tab:

| Limit | Default |
| --- | --- |
| Module / function recursion depth | 200 |
| Scene nodes | 250,000 |
| `for` iterations from one range | 1,000,000 |
| C-style loop iterations | 1,000,000 |
| Diagnostics per compile | 500 |

Each reports a clear error rather than hanging.

## Not implemented

- **Third-party libraries** (BOSL2, MCAD) are deferred past v1. They lean on
  deep recursion and large list comprehensions; they may well work, but they are
  not tested and not supported yet.
- **`textmetrics()`** — a development-snapshot function, not in the 2021.01
  release.
- **`surface()` with image heightmaps in the CLI** — works in the browser, which
  has an image decoder; the CLI reports a clear error rather than pulling in an
  image codec.
