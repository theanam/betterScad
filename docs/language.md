# Language reference

BetterSCAD implements the OpenSCAD language in full. This page covers what is
supported, the handful of places where behaviour is worth pinning down, and the
extensions BetterSCAD adds on top.

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
registration and implemented in `transpile.ts`.

### `negative()`

Turns a subtree into negative space, subtracted from every sibling in the
enclosing scope:

```scad
union() {
  plate();
  boss();
  negative() cylinder(h = 20, r = 5);   // cuts BOTH plate() and boss()
}
```

**Downgrade:** the enclosing scope is rewritten as
`difference() { union() { …siblings… } …negatives… }`. Geometry is identical.

### C-style statement `for`

Stock OpenSCAD allows `for (i = 0; i < n; i = i + 1)` only inside list
comprehensions. BetterSCAD also accepts it as a statement.

**Downgrade:** rewritten as a bounded range `for` with the condition as a guard,
and the original is preserved in a comment. This is exact only for the common
`i = start; i < limit; i = i + step` shape, so the export reports it.

### `is_range()`

A type predicate for range values, matching the other `is_*` functions.

**Downgrade:** no equivalent exists; calls are left as-is and will evaluate to
`undef` in stock OpenSCAD. Avoid it in files you intend to export.

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
