/**
 * Autocomplete for OpenSCAD (spec feature 4).
 *
 * Three sources, merged:
 *  1. The built-in module and function library, with real signatures and docs.
 *  2. Symbols defined in the current document (modules, functions, variables).
 *  3. Special variables, offered as soon as `$` is typed.
 */

import {
  snippetCompletion,
  // Marked `type` so the module loads outside a bundler — Node's type stripping
  // erases annotations but leaves an unmarked import of a type-only export
  // behind, and it then fails to resolve at run time.
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';

/**
 * One way of writing a call.
 *
 * Most of this language's builtins have several: `cylinder` takes a radius or a
 * diameter, one of each for a cone, and a `center`. Offering only one of them
 * means everybody who wanted a different one deletes the suggestion before
 * typing what they meant, which is worse than no suggestion at all.
 */
interface CallForm {
  /** Snippet template; `${name}` marks a tab stop. */
  template: string;
  /** This form's own argument list. It is what tells the forms apart in the
   * list, since they all share a name. */
  detail: string;
  /**
   * Set on the forms that differ only in how they measure a round thing.
   *
   * Radius and diameter are both right and people are firmly one or the other,
   * so which comes first is a setting rather than a guess — see
   * `setRoundMeasure`. Forms without this keep their written order whichever
   * way the setting goes.
   */
  measure?: RoundMeasure;
}

/** Which of the two ways of measuring a circle a person works in. */
export type RoundMeasure = 'radius' | 'diameter';

interface BuiltinDoc extends CallForm {
  label: string;
  info: string;
  type: 'function' | 'keyword' | 'class';
  /**
   * Other ways to write the same call, offered under the one above in the
   * order they are written here. Commonest first: the top one is what pressing
   * Enter straight away gives you.
   */
  forms?: CallForm[];
}


/** Built-in modules, with the parameters that matter most placed first. */
const MODULES: BuiltinDoc[] = [
  {
    label: 'cube',
    template: 'cube(${1:10})',
    detail: 'cube(size)',
    info:
      'Axis-aligned box. `size` is a number or [x, y, z].\n\n' +
      'BetterSCAD adds `r`, a radius on every edge. It follows `center`, so ' +
      '`cube(10, true)` still means what it always has. At r = 0 this is the ' +
      'stock primitive and exports untouched.',
    type: 'class',
    forms: [
      { template: 'cube([${1:10}, ${2:10}, ${3:10}])', detail: 'cube([x, y, z])' },
      { template: 'cube(${1:10}, center = true)', detail: 'cube(size, center)' },
      { template: 'cube([${1:10}, ${2:10}, ${3:10}], center = true)', detail: 'cube([x, y, z], center)' },
      { template: 'cube(${1:10}, r = ${2:2})', detail: 'cube(size, r)  — BetterSCAD' },
      {
        template: 'cube([${1:10}, ${2:10}, ${3:10}], center = true, r = ${4:2})',
        detail: 'cube([x, y, z], center, r)  — BetterSCAD',
      },
    ],
  },
  {
    label: 'sphere',
    template: 'sphere(d = ${1:10})',
    detail: 'sphere(d)',
    measure: 'diameter',
    info: 'Sphere at the origin. Resolution follows $fn / $fa / $fs.',
    type: 'class',
    forms: [
      { template: 'sphere(r = ${1:5})', detail: 'sphere(r)', measure: 'radius' },
      { template: 'sphere(d = ${1:10}, $fn = ${2:64})', detail: 'sphere(d, $fn)', measure: 'diameter' },
    ],
  },
  {
    label: 'cylinder',
    template: 'cylinder(h = ${1:10}, d = ${2:5})',
    detail: 'cylinder(h, d)',
    measure: 'diameter',
    info:
      'Cylinder or cone. A zero radius at one end gives a cone.\n\n' +
      'Diameter and radius are interchangeable: d = 2r, d1/d2 = 2r1/2r2.\n\n' +
      'BetterSCAD adds `fillet`, easing both ends; `fillet1` and `fillet2` ' +
      'override the bottom and the top, the same way round as r1 and r2. ' +
      '`fillet_style` is "round" (default) or "chamfer".',
    type: 'class',
    forms: [
      { template: 'cylinder(h = ${1:10}, r = ${2:5})', detail: 'cylinder(h, r)', measure: 'radius' },
      {
        template: 'cylinder(h = ${1:10}, d = ${2:5}, center = true)',
        detail: 'cylinder(h, d, center)',
        measure: 'diameter',
      },
      {
        template: 'cylinder(h = ${1:10}, d1 = ${2:10}, d2 = ${3:5})',
        detail: 'cylinder(h, d1, d2)  — a cone',
        measure: 'diameter',
      },
      {
        template: 'cylinder(h = ${1:10}, d = ${2:5}, fillet = ${3:1})',
        detail: 'cylinder(h, d, fillet)  — BetterSCAD',
        measure: 'diameter',
      },
      {
        template: 'cylinder(h = ${1:10}, d = ${2:5}, fillet = ${3:1}, fillet_style = "chamfer")',
        detail: 'cylinder(h, d, fillet, fillet_style)  — BetterSCAD',
        measure: 'diameter',
      },
      {
        template: 'cylinder(h = ${1:10}, r1 = ${2:5}, r2 = ${3:0})',
        detail: 'cylinder(h, r1, r2)  — a cone',
        measure: 'radius',
      },
      {
        template: 'cylinder(h = ${1:10}, d = ${2:5}, $fn = ${3:64})',
        detail: 'cylinder(h, d, $fn)',
        measure: 'diameter',
      },
    ],
  },
  { label: 'polyhedron', template: 'polyhedron(points = [${}], faces = [[${}]])', detail: 'polyhedron(points, faces, convexity)', info: 'Arbitrary solid. Faces are wound clockwise seen from outside.', type: 'class' },
  {
    label: 'square',
    template: 'square(${1:10})',
    detail: 'square(size)',
    info:
      '2D rectangle.\n\n' +
      'BetterSCAD adds `r`, a corner radius, after `center`. At r = 0 this is ' +
      'the stock primitive and exports untouched.',
    type: 'class',
    forms: [
      { template: 'square([${1:10}, ${2:10}])', detail: 'square([x, y])' },
      { template: 'square([${1:10}, ${2:10}], center = true)', detail: 'square([x, y], center)' },
      { template: 'square(${1:10}, r = ${2:2})', detail: 'square(size, r)  — BetterSCAD' },
      {
        template: 'square([${1:10}, ${2:10}], center = true, r = ${3:2})',
        detail: 'square([x, y], center, r)  — BetterSCAD',
      },
    ],
  },
  {
    label: 'circle',
    template: 'circle(d = ${1:10})',
    detail: 'circle(d)',
    measure: 'diameter',
    info: '2D circle, tessellated per $fn / $fa / $fs.',
    type: 'class',
    forms: [
      { template: 'circle(r = ${1:5})', detail: 'circle(r)', measure: 'radius' },
      { template: 'circle(d = ${1:10}, $fn = ${2:64})', detail: 'circle(d, $fn)', measure: 'diameter' },
    ],
  },
  {
    label: 'polygon',
    template: 'polygon(points = [${}])',
    detail: 'polygon(points)',
    info: '2D polygon. With `paths`, extra contours become holes.',
    type: 'class',
    forms: [
      { template: 'polygon(points = [${}], paths = [[${}]])', detail: 'polygon(points, paths)' },
    ],
  },
  {
    label: 'text',
    template: 'text("${1:text}", size = ${2:10})',
    detail: 'text(t, size)',
    info:
      '2D text outlines. Fonts are managed in the Fonts dialog.\n\n' +
      'BetterSCAD adds `radius`, which lays the run on a circle instead of a ' +
      'straight baseline; `start` is the angle it begins at (default 90, the ' +
      'top) and `facing` is "out" or "in". Letters are spaced by their real ' +
      'widths.',
    type: 'class',
    forms: [
      {
        template: 'text("${1:LABEL}", size = ${2:5}, radius = ${3:20}, halign = "center")',
        detail: 'text(text, size, radius, halign)  — BetterSCAD, on a circle',
      },
      {
        template:
          'text("${1:LABEL}", size = ${2:5}, radius = ${3:20}, halign = "center", ' +
          'start = ${4:270}, facing = "in")',
        detail: 'text(…, start, facing)  — BetterSCAD, the far side of a dial',
      },
      {
        template: 'text("${1:text}", size = ${2:10}, halign = "center", valign = "center")',
        detail: 'text(t, size, halign, valign)',
      },
      { template: 'text("${1:text}", size = ${2:10}, font = "${3:Inter}")', detail: 'text(t, size, font)' },
      { template: 'text("${1:text}", size = ${2:10}, spacing = ${3:1})', detail: 'text(t, size, spacing)' },
    ],
  },
  {
    label: 'translate',
    template: 'translate([${1:0}, ${2:0}, ${3:0}])',
    detail: 'translate([x, y, z])',
    info: 'Moves children by a vector.\n\nBetterSCAD also accepts loose numbers: `translate(x, y, z)`.',
    type: 'class',
    forms: [
      { template: 'translate(${1:0}, ${2:0}, ${3:0})', detail: 'translate(x, y, z)  — BetterSCAD' },
      { template: 'translate([${1:0}, ${2:0}])', detail: 'translate([x, y])  — 2D' },
    ],
  },
  {
    label: 'rotate',
    template: 'rotate([${1:0}, ${2:0}, ${3:0}])',
    detail: 'rotate([x, y, z])',
    info:
      'Rotates children. `rotate(a)` rotates about Z; `rotate(a, v)` about an axis.\n\n' +
      'BetterSCAD also accepts loose numbers: `rotate(x, y, z)`.',
    type: 'class',
    forms: [
      { template: 'rotate(${1:0}, ${2:0}, ${3:0})', detail: 'rotate(x, y, z)  — BetterSCAD' },
      { template: 'rotate(${1:90})', detail: 'rotate(a)  — about Z' },
      { template: 'rotate(${1:90}, [${2:0}, ${3:0}, ${4:1}])', detail: 'rotate(a, v)  — about an axis' },
    ],
  },
  {
    label: 'scale',
    template: 'scale([${1:1}, ${2:1}, ${3:1}])',
    detail: 'scale([x, y, z])',
    info: 'Scales children per axis.',
    type: 'class',
    forms: [{ template: 'scale(${1:2})', detail: 'scale(factor)  — every axis alike' }],
  },
  {
    label: 'resize',
    template: 'resize([${1:x}, ${2:y}, ${3:z}])',
    detail: 'resize([x, y, z])',
    info: 'Scales children to an absolute bounding-box size.',
    type: 'class',
    forms: [
      {
        template: 'resize([${1:x}, ${2:y}, ${3:0}], auto = true)',
        detail: 'resize([x, y, z], auto)  — 0 means scale with the rest',
      },
    ],
  },
  {
    label: 'mirror',
    template: 'mirror([${1:1}, ${2:0}, ${3:0}])',
    detail: 'mirror([x, y, z])',
    info: 'Mirrors children across the plane with normal `v`.\n\nBetterSCAD also accepts loose numbers: `mirror(x, y, z)`.',
    type: 'class',
    forms: [{ template: 'mirror(${1:1}, ${2:0}, ${3:0})', detail: 'mirror(x, y, z)  — BetterSCAD' }],
  },

  // Shapes OpenSCAD does not have (BetterSCAD extension).
  {
    label: 'thread',
    template: 'thread(d = ${1:8}, pitch = ${2:1.25}, h = ${3:10})',
    detail: 'thread(d, pitch, h)  — BetterSCAD',
    info: 'A helical screw thread. `d` is the outside diameter and `pitch` the rise per turn (M8 is d = 8, pitch = 1.25).\n\n`internal = true` makes the mating hole: put it under negative(), and the bolt from the same d and pitch screws into it. `clearance` (default 0.2) is the fit.\n\nExports to `.scad` as a generated module building the same swept helix.',
    type: 'class',
    forms: [
      {
        template: 'thread(d = ${1:8}, pitch = ${2:1.25}, h = ${3:10}, internal = true)',
        detail: 'thread(d, pitch, h, internal)  — the mating hole',
      },
      {
        template: 'thread(d = ${1:8}, pitch = ${2:1.25}, h = ${3:10}, internal = true, clearance = ${4:0.3})',
        detail: 'thread(d, pitch, h, internal, clearance)',
      },
      {
        template: 'thread(d = ${1:8}, pitch = ${2:1.25}, h = ${3:10}, center = true)',
        detail: 'thread(d, pitch, h, center)',
      },
      {
        template: 'thread(d = ${1:8}, pitch = ${2:1.25}, h = ${3:10}, chamfer = false)',
        detail: 'thread(d, pitch, h, chamfer)  — square ends',
      },
    ],
  },
  { label: 'regular_polygon', template: 'regular_polygon(${1:6}, ${2:10})', detail: 'regular_polygon(sides, length)  — BetterSCAD', info: 'An equilateral polygon with `sides` sides, each `length` long. Fewer than 3 sides cannot close, and is an error.\n\nExports to `.scad` as a generated module wrapping circle($fn = sides).', type: 'class' },

  // Single-axis transforms (BetterSCAD extension). Grouped so the axis reads as
  // the point of the call rather than as a position in a vector.
  { label: 'translatex', template: 'translatex(${1:0})', detail: 'translatex(d)  — BetterSCAD', info: 'Moves children `d` along X.\n\nExports to `.scad` as `translate([d, 0, 0])`.', type: 'class' },
  { label: 'translatey', template: 'translatey(${1:0})', detail: 'translatey(d)  — BetterSCAD', info: 'Moves children `d` along Y.\n\nExports to `.scad` as `translate([0, d, 0])`.', type: 'class' },
  { label: 'translatez', template: 'translatez(${1:0})', detail: 'translatez(d)  — BetterSCAD', info: 'Moves children `d` along Z.\n\nExports to `.scad` as `translate([0, 0, d])`.', type: 'class' },
  { label: 'rotatex', template: 'rotatex(${1:0})', detail: 'rotatex(a)  — BetterSCAD', info: 'Rotates children `a` degrees about X.\n\nExports to `.scad` as `rotate([a, 0, 0])`.', type: 'class' },
  { label: 'rotatey', template: 'rotatey(${1:0})', detail: 'rotatey(a)  — BetterSCAD', info: 'Rotates children `a` degrees about Y.\n\nExports to `.scad` as `rotate([0, a, 0])`.', type: 'class' },
  { label: 'rotatez', template: 'rotatez(${1:0})', detail: 'rotatez(a)  — BetterSCAD', info: 'Rotates children `a` degrees about Z.\n\nExports to `.scad` as `rotate([0, 0, a])`.', type: 'class' },
  { label: 'mirrorx', template: 'mirrorx()', detail: 'mirrorx()  — BetterSCAD', info: 'Mirrors children across the YZ plane.\n\nExports to `.scad` as `mirror([1, 0, 0])`.', type: 'class' },
  { label: 'mirrory', template: 'mirrory()', detail: 'mirrory()  — BetterSCAD', info: 'Mirrors children across the XZ plane.\n\nExports to `.scad` as `mirror([0, 1, 0])`.', type: 'class' },
  { label: 'mirrorz', template: 'mirrorz()', detail: 'mirrorz()  — BetterSCAD', info: 'Mirrors children across the XY plane.\n\nExports to `.scad` as `mirror([0, 0, 1])`.', type: 'class' },
  { label: 'multmatrix', template: 'multmatrix(${1:m})', detail: 'multmatrix(m)', info: 'Applies a 4x4 (or 3x4) affine matrix.', type: 'class' },
  {
    label: 'color',
    template: 'color("${1:red}")',
    detail: 'color(name)',
    info: 'Sets preview colour. Accepts a CSS name, #hex, or [r, g, b, a] in 0..1.',
    type: 'class',
    forms: [
      { template: 'color("${1:red}", ${2:0.5})', detail: 'color(name, alpha)' },
      { template: 'color("#${1:ff8800}")', detail: 'color("#rrggbb")' },
      { template: 'color([${1:1}, ${2:0.5}, ${3:0}])', detail: 'color([r, g, b])  — 0..1' },
      { template: 'color([${1:1}, ${2:0.5}, ${3:0}, ${4:0.5}])', detail: 'color([r, g, b, a])' },
    ],
  },
  {
    label: 'offset',
    template: 'offset(r = ${1:1})',
    detail: 'offset(r)  — rounded corners',
    info: '2D offset. `r` rounds corners; `delta` keeps them sharp.',
    type: 'class',
    forms: [
      { template: 'offset(delta = ${1:1})', detail: 'offset(delta)  — sharp corners' },
      { template: 'offset(delta = ${1:1}, chamfer = true)', detail: 'offset(delta, chamfer)' },
    ],
  },
  { label: 'union', template: 'union() {\n\t${}\n}', detail: 'union()', info: 'Combines children. Implicit for any group of siblings.', type: 'class' },
  { label: 'difference', template: 'difference() {\n\t${}\n}', detail: 'difference()', info: 'Subtracts every child after the first from the first.', type: 'class' },
  { label: 'intersection', template: 'intersection() {\n\t${}\n}', detail: 'intersection()', info: 'Keeps only the volume common to every child.', type: 'class' },
  { label: 'hull', template: 'hull() {\n\t${}\n}', detail: 'hull()', info: 'Convex hull of all children.', type: 'class' },
  { label: 'minkowski', template: 'minkowski() {\n\t${}\n}', detail: 'minkowski()', info: 'Minkowski sum of the children. Expensive; keep the second shape small.', type: 'class' },
  {
    label: 'linear_extrude',
    template: 'linear_extrude(height = ${1:10}) ${}',
    detail: 'linear_extrude(height)',
    info: 'Extrudes 2D geometry along Z.',
    type: 'class',
    forms: [
      { template: 'linear_extrude(height = ${1:10}, center = true) ${}', detail: 'linear_extrude(height, center)' },
      {
        template: 'linear_extrude(height = ${1:10}, twist = ${2:90}, slices = ${3:40}) ${}',
        detail: 'linear_extrude(height, twist, slices)',
      },
      { template: 'linear_extrude(height = ${1:10}, scale = ${2:0.5}) ${}', detail: 'linear_extrude(height, scale)' },
    ],
  },
  {
    label: 'rotate_extrude',
    template: 'rotate_extrude() ${}',
    detail: 'rotate_extrude()  — a full turn',
    info: 'Revolves 2D geometry about Z. The profile must sit at x >= 0.',
    type: 'class',
    forms: [
      { template: 'rotate_extrude(angle = ${1:180}) ${}', detail: 'rotate_extrude(angle)' },
      { template: 'rotate_extrude(angle = ${1:180}, start = ${2:0}) ${}', detail: 'rotate_extrude(angle, start)' },
    ],
  },
  {
    label: 'projection',
    template: 'projection() ${}',
    detail: 'projection()  — the whole outline',
    info: 'Flattens 3D to 2D. `cut = true` slices at z = 0.',
    type: 'class',
    forms: [{ template: 'projection(cut = true) ${}', detail: 'projection(cut)  — a slice at z = 0' }],
  },
  { label: 'render', template: 'render() ${}', detail: 'render(convexity)', info: 'Forces full evaluation of a subtree.', type: 'class' },
  {
    label: 'import',
    template: 'import("${1:file.stl}")',
    detail: 'import(file)',
    info: 'Imports STL, OBJ, OFF, DXF or SVG.',
    type: 'class',
    forms: [
      { template: 'import("${1:drawing.dxf}", layer = "${2:0}")', detail: 'import(file, layer)  — DXF' },
      { template: 'import("${1:drawing.svg}", dpi = ${2:96})', detail: 'import(file, dpi)  — SVG' },
      { template: 'import("${1:file.stl}", convexity = ${2:2})', detail: 'import(file, convexity)' },
    ],
  },
  {
    label: 'surface',
    template: 'surface("${1:heightmap.dat}")',
    detail: 'surface(file)',
    info: 'Builds a solid from a heightmap (.dat grid or an image).',
    type: 'class',
    forms: [
      {
        template: 'surface("${1:heightmap.png}", center = true, invert = true)',
        detail: 'surface(file, center, invert)',
      },
    ],
  },
  {
    label: 'children',
    template: 'children()',
    detail: 'children()  — all of them',
    info: 'Instantiates the children passed to this module.',
    type: 'class',
    forms: [
      { template: 'children(${1:0})', detail: 'children(index)  — one of them' },
      { template: 'children([${1:0} : $children - 1])', detail: 'children(range)  — a run of them' },
    ],
  },
  { label: 'negative', template: 'negative() {\n\t${}\n}', detail: 'negative()  — BetterSCAD extension', info: 'Turns a subtree into negative space, subtracted from every sibling in scope.\n\nExports to legacy .scad as a difference().', type: 'class' },
];

const FUNCTIONS: BuiltinDoc[] = [
  { label: 'sin', template: 'sin(${1:a})', detail: 'sin(degrees)', info: 'Sine. Angles are in degrees.', type: 'function' },
  { label: 'cos', template: 'cos(${1:a})', detail: 'cos(degrees)', info: 'Cosine. Angles are in degrees.', type: 'function' },
  { label: 'tan', template: 'tan(${1:a})', detail: 'tan(degrees)', info: 'Tangent. Angles are in degrees.', type: 'function' },
  { label: 'asin', template: 'asin(${1:x})', detail: 'asin(x)', info: 'Arc sine, in degrees.', type: 'function' },
  { label: 'acos', template: 'acos(${1:x})', detail: 'acos(x)', info: 'Arc cosine, in degrees.', type: 'function' },
  { label: 'atan', template: 'atan(${1:x})', detail: 'atan(x)', info: 'Arc tangent, in degrees.', type: 'function' },
  { label: 'atan2', template: 'atan2(${1:y}, ${2:x})', detail: 'atan2(y, x)', info: 'Full-circle arc tangent, in degrees.', type: 'function' },
  { label: 'abs', template: 'abs(${1:x})', detail: 'abs(x)', info: 'Absolute value.', type: 'function' },
  { label: 'sign', template: 'sign(${1:x})', detail: 'sign(x)', info: '-1, 0 or 1.', type: 'function' },
  { label: 'floor', template: 'floor(${1:x})', detail: 'floor(x)', info: 'Rounds down.', type: 'function' },
  { label: 'ceil', template: 'ceil(${1:x})', detail: 'ceil(x)', info: 'Rounds up.', type: 'function' },
  { label: 'round', template: 'round(${1:x})', detail: 'round(x)', info: 'Rounds half away from zero.', type: 'function' },
  { label: 'sqrt', template: 'sqrt(${1:x})', detail: 'sqrt(x)', info: 'Square root.', type: 'function' },
  { label: 'pow', template: 'pow(${1:base}, ${2:exp})', detail: 'pow(base, exponent)', info: 'Exponentiation. `base ^ exponent` is equivalent.', type: 'function' },
  { label: 'exp', template: 'exp(${1:x})', detail: 'exp(x)', info: 'e to the power x.', type: 'function' },
  { label: 'ln', template: 'ln(${1:x})', detail: 'ln(x)', info: 'Natural logarithm.', type: 'function' },
  { label: 'log', template: 'log(${1:x})', detail: 'log(x)', info: 'Base-10 logarithm.', type: 'function' },
  {
    label: 'min',
    template: 'min(${1:a}, ${2:b})',
    detail: 'min(a, b, …)',
    info: 'Smallest value.',
    type: 'function',
    forms: [{ template: 'min(${1:v})', detail: 'min(vector)' }],
  },
  {
    label: 'max',
    template: 'max(${1:a}, ${2:b})',
    detail: 'max(a, b, …)',
    info: 'Largest value.',
    type: 'function',
    forms: [{ template: 'max(${1:v})', detail: 'max(vector)' }],
  },
  { label: 'norm', template: 'norm(${1:v})', detail: 'norm(v)', info: 'Euclidean length of a vector.', type: 'function' },
  { label: 'cross', template: 'cross(${1:a}, ${2:b})', detail: 'cross(a, b)', info: 'Cross product (3D), or the scalar z-component (2D).', type: 'function' },
  { label: 'len', template: 'len(${1:v})', detail: 'len(list | string)', info: 'Element or character count.', type: 'function' },
  { label: 'concat', template: 'concat(${1:a}, ${2:b})', detail: 'concat(…)', info: 'Concatenates lists, flattening exactly one level.', type: 'function' },
  { label: 'str', template: 'str(${})', detail: 'str(…)', info: 'Converts and joins values into a string.', type: 'function' },
  {
    label: 'chr',
    template: 'chr(${1:code})',
    detail: 'chr(code)',
    info: 'Unicode code points to a string.',
    type: 'function',
    forms: [{ template: 'chr([${1:code}, ${1:code}])', detail: 'chr(list)' }],
  },
  { label: 'ord', template: 'ord(${1:s})', detail: 'ord(string)', info: 'Code point of the first character.', type: 'function' },
  { label: 'lookup', template: 'lookup(${1:key}, ${2:table})', detail: 'lookup(key, table)', info: 'Linear interpolation over a table of [key, value] pairs.', type: 'function' },
  {
    label: 'search',
    template: 'search(${1:needle}, ${2:haystack})',
    detail: 'search(match_value, string_or_vector)',
    info: 'Finds indices of matching entries.',
    type: 'function',
    forms: [
      { template: 'search(${1:needle}, ${2:haystack}, 0)', detail: 'search(value, haystack, 0)  — every match' },
      {
        template: 'search(${1:needle}, ${2:table}, ${3:1}, ${4:0})',
        detail: 'search(value, table, num_returns, index_col)',
      },
    ],
  },
  {
    label: 'rands',
    template: 'rands(${1:min}, ${2:max}, ${3:count})',
    detail: 'rands(min_value, max_value, value_count)',
    info: 'Random numbers. Pass `seed` for a reproducible sequence.',
    type: 'function',
    forms: [
      {
        template: 'rands(${1:min}, ${2:max}, ${3:count}, ${4:seed})',
        detail: 'rands(min_value, max_value, value_count, seed)',
      },
    ],
  },
  { label: 'is_undef', template: 'is_undef(${1:x})', detail: 'is_undef(x)', info: 'True when the value is undef.', type: 'function' },
  { label: 'is_bool', template: 'is_bool(${1:x})', detail: 'is_bool(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_num', template: 'is_num(${1:x})', detail: 'is_num(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_string', template: 'is_string(${1:x})', detail: 'is_string(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_list', template: 'is_list(${1:x})', detail: 'is_list(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_function', template: 'is_function(${1:x})', detail: 'is_function(x)', info: 'Type predicate.', type: 'function' },
  { label: 'version', template: 'version()', detail: 'version()', info: 'Language version as [year, month, day].', type: 'function' },
  { label: 'echo', template: 'echo(${})', detail: 'echo(…)', info: 'Prints to the console panel.', type: 'function' },
  {
    label: 'assert',
    template: 'assert(${1:condition}, "${2:message}")',
    detail: 'assert(condition, message)',
    info: 'Stops evaluation with an error when the condition is false.',
    type: 'function',
    forms: [{ template: 'assert(${1:condition})', detail: 'assert(condition)' }],
  },
];

const KEYWORD_SNIPPETS: BuiltinDoc[] = [
  { label: 'module', template: 'module ${1:name}(${2:params}) {\n\t${}\n}', detail: 'module name(params) { … }', info: 'Defines a module: a reusable piece of geometry.', type: 'keyword' },
  { label: 'function', template: 'function ${1:name}(${2:params}) = ${3:expr};', detail: 'function name(params) = expr;', info: 'Defines a function. The body is a single expression.', type: 'keyword' },
  {
    label: 'for',
    template: 'for (${1:i} = [${2:0}:${3:9}]) {\n\t${}\n}',
    detail: 'for (var = [from : to])',
    info: 'Repeats its children once per value.',
    type: 'keyword',
    forms: [
      { template: 'for (${1:i} = [${2:0}:${3:2}:${4:10}]) {\n\t${}\n}', detail: 'for (var = [from : step : to])' },
      { template: 'for (${1:v} = ${2:list}) {\n\t${}\n}', detail: 'for (var = list)' },
      {
        template: 'for (${1:i} = [${2:0}:${3:9}], ${4:j} = [${5:0}:${6:9}]) {\n\t${}\n}',
        detail: 'for (a = …, b = …)  — nested',
      },
      {
        template: 'for (${1:i} = ${2:0}; ${1:i} < ${3:10}; ${1:i} = ${1:i} + 1) {\n\t${}\n}',
        detail: 'for (init; condition; step)  — BetterSCAD',
      },
    ],
  },
  { label: 'intersection_for', template: 'intersection_for (${1:i} = [${2:0}:${3:9}]) {\n\t${}\n}', detail: 'intersection_for (var = range)', info: 'Intersects the results of every iteration.', type: 'keyword' },
  {
    label: 'if',
    template: 'if (${1:condition}) {\n\t${}\n}',
    detail: 'if (condition) { … }',
    info: 'Conditional instantiation.',
    type: 'keyword',
    forms: [
      {
        template: 'if (${1:condition}) {\n\t${}\n} else {\n\t\n}',
        detail: 'if (condition) { … } else { … }',
      },
    ],
  },
  { label: 'let', template: 'let (${1:name} = ${2:value}) ${}', detail: 'let (assignments) expr-or-statement', info: 'Binds values for a single expression or statement.', type: 'keyword' },
  { label: 'each', template: 'each ${1:list}', detail: 'each list', info: 'Splices a list into the surrounding list comprehension.', type: 'keyword' },
  { label: 'include', template: 'include <${1:file.scad}>', detail: 'include <path>', info: 'Splices another file in, variables and geometry included.', type: 'keyword' },
  { label: 'use', template: 'use <${1:file.scad}>', detail: 'use <path>', info: 'Imports only the modules and functions from another file.', type: 'keyword' },
];

/** Constants the language supplies. `PI` is the only one in stock OpenSCAD. */
const CONSTANTS: { label: string; detail: string; info: string }[] = [
  {
    label: 'PI',
    detail: '3.14159265358979',
    info: 'The ratio of a circle\u2019s circumference to its diameter.\n\nAssigning to `PI` shadows it, as with any other variable.',
  },
];

const SPECIAL_VARIABLES: { label: string; info: string }[] = [
  { label: '$fn', info: 'Fixed number of fragments per circle. Overrides $fa and $fs when > 0.' },
  { label: '$fa', info: 'Minimum angle per fragment, in degrees. Default 12.' },
  { label: '$fs', info: 'Minimum fragment length. Default 2.' },
  { label: '$t', info: 'Animation time, 0..1 (spec feature 20).' },
  { label: '$preview', info: 'True in fast preview (F5), false in the full render (F6).' },
  { label: '$children', info: 'Number of children passed to the current module.' },
  { label: '$vpr', info: 'Viewport rotation [x, y, z].' },
  { label: '$vpt', info: 'Viewport translation (camera target).' },
  { label: '$vpd', info: 'Viewport camera distance.' },
  { label: '$vpf', info: 'Viewport field of view.' },
];

/**
 * One completion per call form, in the order the entry lists them.
 *
 * Every form carries the same label, so one piece of typing matches them all
 * and they arrive together; `detail` is what distinguishes them on screen. The
 * boost steps down a tenth per form, which settles the order within a group
 * while staying well inside the gap of one that separates the categories.
 *
 * `prefer` lifts the forms that measure circles the way this person does above
 * the ones that do not, and changes nothing else: a stable partition, so within
 * each half the written order survives.
 */
function toCompletions(doc: BuiltinDoc, boost: number, prefer: RoundMeasure): Completion[] {
  const written: CallForm[] = [
    { template: doc.template, detail: doc.detail, measure: doc.measure },
    ...(doc.forms ?? []),
  ];
  const wanted = written.filter((f) => f.measure !== undefined && f.measure !== prefer);
  const forms = wanted.length
    ? [...written.filter((f) => !wanted.includes(f)), ...wanted]
    : written;

  return forms.map((form, index) =>
    snippetCompletion(form.template, {
      label: doc.label,
      detail: form.detail,
      info: doc.info,
      type: doc.type,
      boost: boost - index / 10,
    }),
  );
}

const CONSTANT_COMPLETIONS: Completion[] = CONSTANTS.map((c) => ({
  label: c.label,
  detail: c.detail,
  info: c.info,
  type: 'constant',
  boost: 2,
}));

// Modules are what people type most, so they outrank functions on ties.
/**
 * The whole built-in list, for one way of measuring circles.
 *
 * Built once per setting and kept, because the list is a few hundred entries
 * and the alternative is rebuilding it on every keystroke to answer a question
 * whose answer changes about twice a year.
 */
const builtinsByMeasure = new Map<RoundMeasure, Completion[]>();

function builtinCompletions(prefer: RoundMeasure): Completion[] {
  const existing = builtinsByMeasure.get(prefer);
  if (existing) return existing;

  const built = [
    ...MODULES.flatMap((d) => toCompletions(d, 3, prefer)),
    ...CONSTANT_COMPLETIONS,
    ...KEYWORD_SNIPPETS.flatMap((d) => toCompletions(d, 2, prefer)),
    ...FUNCTIONS.flatMap((d) => toCompletions(d, 1, prefer)),
  ];
  builtinsByMeasure.set(prefer, built);
  return built;
}

/**
 * Which measurement the completion list leads with.
 *
 * Module state rather than a facet: there is one editor, the setting changes
 * from one place, and threading a facet through `override` to reach it would
 * be machinery in place of an assignment.
 */
let roundMeasure: RoundMeasure = 'diameter';

export function setRoundMeasure(measure: RoundMeasure): void {
  roundMeasure = measure;
}

/** The completions as currently ordered. Exported for tests. */
export function currentBuiltins(): Completion[] {
  return builtinCompletions(roundMeasure);
}

const SPECIAL_COMPLETIONS: Completion[] = SPECIAL_VARIABLES.map((v) => ({
  label: v.label,
  type: 'variable',
  info: v.info,
  boost: 2,
}));

/** Symbols the current document defines, so local names complete too. */
function documentSymbols(source: string, upTo: number): Completion[] {
  const completions: Completion[] = [];
  const seen = new Set<string>();

  const add = (label: string, type: Completion['type'], detail?: string): void => {
    if (seen.has(label + type)) return;
    seen.add(label + type);
    completions.push({ label, type, detail, boost: 4 });
  };

  // Deliberately regex-based: this runs on every keystroke, and a full parse
  // of a half-typed file would be both slower and noisier.
  for (const match of source.matchAll(/\bmodule\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    add(match[1], 'class', `module(${match[2].trim()})`);
  }
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    add(match[1], 'function', `function(${match[2].trim()})`);
  }
  for (const match of source.matchAll(/^[ \t]*([A-Za-z_][\w$]*)\s*=/gm)) {
    add(match[1], 'variable');
  }
  // Parameters of the module or function being edited.
  const enclosing = /\b(?:module|function)\s+[\w$]*\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = enclosing.exec(source)) !== null) {
    if (match.index > upTo) break;
    for (const param of match[1].split(',')) {
      const name = param.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name, 'variable', 'parameter');
    }
  }

  return completions;
}

export function scadCompletions(context: CompletionContext): CompletionResult | null {
  const source = context.state.doc.toString();

  // `$` starts a special variable; match it explicitly because `$` is not a
  // word character to CodeMirror's default matcher.
  const special = context.matchBefore(/\$[\w$]*/);
  if (special) {
    return { from: special.from, options: SPECIAL_COMPLETIONS, validFor: /^\$[\w$]*$/ };
  }

  const word = context.matchBefore(/[A-Za-z_][\w$]*/);
  if (!word && !context.explicit) return null;

  const from = word ? word.from : context.pos;

  // Inside a string or comment, completing identifiers is just noise.
  const lineText = context.state.doc.lineAt(context.pos).text;
  const column = context.pos - context.state.doc.lineAt(context.pos).from;
  if (isInsideStringOrComment(lineText, column)) return null;

  return {
    from,
    options: [...builtinCompletions(roundMeasure), ...documentSymbols(source, context.pos)],
    validFor: /^[\w$]*$/,
  };
}

/** Cheap single-line check; good enough to suppress completions where they annoy. */
function isInsideStringOrComment(line: string, column: number): boolean {
  const before = line.slice(0, column);
  const commentAt = before.indexOf('//');
  if (commentAt >= 0) return true;
  let quotes = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '"' && before[i - 1] !== '\\') quotes++;
  }
  return quotes % 2 === 1;
}
