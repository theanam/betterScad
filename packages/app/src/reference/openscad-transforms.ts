/**
 * The cheatsheet's operators: transforms, booleans, hulls and the extrusions
 * that move geometry between 2D and 3D.
 */

import type { ReferenceGroup } from './types.js';

export const TRANSFORMS: ReferenceGroup = {
  id: 'transforms',
  title: 'Moving and changing shapes',
  blurb: 'Each of these takes the shapes written after it and changes where or how big they are.',
  entries: [
    {
      id: 'translate',
      name: 'translate()',
      signature: 'translate(v)',
      plain: 'Slides a shape somewhere else. `[10, 0, 0]` means ten units along X and nowhere else.',
      details: [
        '`v` is `[x, y, z]`, or `[x, y]` for 2D. Missing components are `0`.',
        'It moves the shapes written after it, and only those. Everything else stays where it was.',
        'BetterSCAD also accepts loose numbers — `translate(10, 5, 2)` — and one call per axis: ' +
          '`translatex()`, `translatey()`, `translatez()`.',
      ],
      params: [{ name: 'v', description: '`[x, y, z]` offset.' }],
      examples: [
        {
          code: '%cube(20);\ntranslate([30, 0, 0]) cube(20);',
          image: 'translate',
          caption: 'The ghost is where the cube started; the solid is where `translate` put it.',
        },
      ],
      see: ['rotate', 'scale', 'translatex'],
      keywords: ['move', 'position', 'offset', 'shift'],
    },
    {
      id: 'rotate',
      name: 'rotate()',
      signature: 'rotate(a) | rotate(a, v) | rotate([x, y, z])',
      plain:
        'Turns a shape. Angles are in degrees, and the shape turns around the origin — so a ' +
        'shape far from the origin swings around like something on the end of a rope.',
      details: [
        '`rotate([x, y, z])` turns about each axis in turn: Z first, then Y, then X.',
        '`rotate(a)` with a single number turns `a` degrees about Z.',
        '`rotate(a, v)` turns `a` degrees about the arbitrary axis `v`, using the right-hand ' +
          'rule — point your right thumb along `v` and your fingers curl the way it turns.',
        'To spin a shape in place, centre it on the origin first (`cube(20, center = true)`), or ' +
          'rotate it and then translate it into position.',
        'BetterSCAD also accepts loose numbers — `rotate(0, 0, 90)` — and one call per axis: ' +
          '`rotatex()`, `rotatey()`, `rotatez()`. The stock `rotate(a, v)` form is untouched.',
      ],
      params: [
        { name: 'a', description: 'Degrees: a number, or `[x, y, z]`.' },
        { name: 'v', description: 'Axis to turn about, when `a` is a single number.' },
      ],
      examples: [
        {
          code: '%cube([40, 10, 10]);\nrotate([0, 0, 35]) cube([40, 10, 10]);',
          image: 'rotate',
          caption: '35 degrees about Z. The bar pivots about the origin at its corner.',
        },
        {
          code: 'rotate(45, [1, 1, 0]) cube(20, center = true);',
          image: 'rotate-axis',
          caption: '`rotate(a, v)`: 45 degrees about the diagonal axis `[1, 1, 0]`.',
        },
      ],
      see: ['translate', 'mirror', 'rotatex'],
      keywords: ['turn', 'spin', 'angle', 'degrees', 'orient'],
    },
    {
      id: 'scale',
      name: 'scale()',
      signature: 'scale(v)',
      plain:
        'Makes a shape bigger or smaller. `2` doubles it; `0.5` halves it; `[2, 1, 1]` stretches ' +
        'it along X only.',
      details: [
        '`v` is a number for all axes, or `[x, y, z]` per axis. `1` means unchanged.',
        'Scaling is measured from the origin, so a shape away from the origin moves further away ' +
          'as it grows.',
        'A negative factor flips the shape across that axis as well as scaling it. For a pure ' +
          'flip, `mirror()` says what you mean.',
        'A factor of `0` collapses the shape to nothing and reports a warning.',
      ],
      params: [{ name: 'v', description: 'Number, or `[x, y, z]` factors.' }],
      examples: [
        {
          code: '%cube(20);\nscale([2, 1, 0.5]) cube(20);',
          image: 'scale',
          caption: 'Twice as wide, the same depth, half the height.',
        },
      ],
      see: ['resize', 'mirror'],
      keywords: ['size', 'bigger', 'smaller', 'stretch', 'shrink'],
    },
    {
      id: 'resize',
      name: 'resize()',
      signature: 'resize(newsize, auto)',
      plain:
        'Like `scale()`, but you say the size you want rather than how much to multiply by. ' +
        '"Make this 50 long", not "make this twice as long".',
      details: [
        '`newsize` is `[x, y, z]`, the size of the result’s bounding box.',
        'A `0` in any slot leaves that axis alone — unless `auto` says otherwise.',
        '`auto = true` scales the untouched axes by the same factor as the ones you gave, keeping ' +
          'the proportions. `auto` can also be a list, `[true, false, true]`, to pick per axis.',
        'The measurement is the bounding box, not the shape — resizing a sphere and a spiky star ' +
          'to the same box makes their boxes match, not their outlines.',
      ],
      params: [
        { name: 'newsize', description: '`[x, y, z]` target size. `0` leaves that axis alone.' },
        { name: 'auto', description: '`true`, or a per-axis list, to keep proportions.' },
      ],
      examples: [
        {
          code: '%cube([20, 20, 20]);\nresize([50, 20, 10]) cube(20);',
          image: 'resize',
          caption: 'The same cube, told to be exactly 50 x 20 x 10.',
        },
      ],
      see: ['scale'],
      keywords: ['size', 'fit', 'exact', 'dimensions'],
    },
    {
      id: 'mirror',
      name: 'mirror()',
      signature: 'mirror(v)',
      plain:
        'Flips a shape over, like holding it up to a mirror. `v` points at the mirror — ' +
        '`[1, 0, 0]` flips left to right.',
      details: [
        '`v` is the normal of the mirror plane: the direction the mirror faces. The plane itself ' +
          'always passes through the origin.',
        '`[1, 0, 0]` mirrors across the YZ plane (swapping left and right), `[0, 1, 0]` across ' +
          'XZ, `[0, 0, 1]` across XY (swapping up and down).',
        'The original is *not* kept. Write the shape twice — once plain, once mirrored — if you ' +
          'want both halves.',
        'BetterSCAD also accepts loose numbers — `mirror(1, 0, 0)` — and one call per plane: ' +
          '`mirrorx()`, `mirrory()`, `mirrorz()`.',
      ],
      params: [{ name: 'v', description: 'Normal of the mirror plane, e.g. `[1, 0, 0]`.' }],
      examples: [
        {
          code: 'cylinder(h = 16, r1 = 12, r2 = 0);\nmirror([0, 0, 1]) cylinder(h = 16, r1 = 12, r2 = 0);',
          image: 'mirror',
          // Seen from the front: from the corner, the upper cone hides the one
          // below it and the pair reads as a single shape with a spike.
          view: 'front',
          caption: 'A cone and its reflection in the ground plane, written as two statements.',
        },
      ],
      see: ['mirrorx', 'rotate', 'scale'],
      keywords: ['flip', 'reflect', 'reverse', 'symmetry'],
    },
    {
      id: 'multmatrix',
      name: 'multmatrix()',
      signature: 'multmatrix(m)',
      plain:
        'Applies a move, turn, stretch and skew all at once, written as a grid of numbers. This ' +
        'is the raw form every other transform is built on.',
      details: [
        '`m` is a 4x4 matrix, or a 3x4 one with the bottom row `[0, 0, 0, 1]` assumed. Rows are ' +
          '`[x, y, z, translation]`.',
        'It can do everything the named transforms do, plus shear, which none of them expose.',
        'Prefer the named transforms where they fit: `translate([10, 0, 0])` says what it does, ' +
          'and a matrix does not.',
      ],
      params: [{ name: 'm', description: '4x4 or 3x4 affine matrix, row-major.' }],
      examples: [
        {
          code: [
            '%cube(20);',
            'multmatrix([[1, 0.6, 0, 0],',
            '            [0, 1,   0, 0],',
            '            [0, 0,   1, 0]]) cube(20);',
          ].join('\n'),
          image: 'multmatrix',
          caption: 'A shear — the one thing the named transforms cannot express.',
        },
      ],
      see: ['translate', 'rotate', 'scale'],
      keywords: ['matrix', 'affine', 'shear', 'skew', 'transform'],
    },
    {
      id: 'color',
      name: 'color()',
      signature: 'color(c, alpha) | color([r, g, b, a])',
      plain:
        'Paints a shape a colour so you can tell parts apart on screen. It changes how the model ' +
        'looks, not what it is.',
      details: [
        '`c` is a CSS colour name (`"red"`, `"steelblue"`), a `#rrggbb` string, or `[r, g, b]` ' +
          'with each component from `0` to `1`. A fourth component, or the separate `alpha` ' +
          'argument, sets transparency where `1` is solid.',
        '**Colour is preview only.** STL has nowhere to put it and it is dropped on export; 3MF ' +
          'and AMF keep it. It never affects the geometry, and never affects a boolean.',
        'The nearest enclosing `color()` wins, so a coloured part inside another `color()` keeps ' +
          'its own.',
      ],
      params: [
        { name: 'c', description: 'Colour name, `#hex`, or `[r, g, b]` / `[r, g, b, a]` in 0..1.' },
        { name: 'alpha', description: 'Transparency, `0`–`1`. Default `1`.' },
      ],
      examples: [
        {
          code: 'color("steelblue") cube([30, 20, 10]);\ntranslate([0, 0, 10]) color([0.9, 0.3, 0.2]) cube([30, 20, 6]);',
          image: 'color',
          caption: 'Two parts, two colours, so the seam between them is visible.',
        },
      ],
      see: ['background'],
      keywords: ['paint', 'colour', 'red', 'green', 'blue', 'transparent', 'alpha'],
    },
    {
      id: 'offset',
      name: 'offset()',
      signature: 'offset(r | delta, chamfer)',
      plain:
        'Grows or shrinks a flat shape by the same amount all the way round, like drawing a line ' +
        'a few millimetres outside the edge. A negative number shrinks it instead.',
      details: [
        '**2D only.** There is no 3D offset.',
        '`r` grows the shape and rounds every outside corner to that radius. `delta` grows it by ' +
          'the same distance but keeps corners sharp, extending the edges until they meet.',
        '`chamfer = true` applies only with `delta`, and cuts the corner off flat instead of ' +
          'extending it to a point.',
        'A negative value shrinks. Shrink a shape by more than its own narrowest half-width and ' +
          'parts of it simply vanish, which is a legitimate way to remove thin slivers.',
        '`offset(r = 2) offset(r = -2)` is the standard trick for rounding inside corners while ' +
          'leaving outside ones alone.',
      ],
      params: [
        { name: 'r', description: 'Distance, with rounded outside corners.' },
        { name: 'delta', description: 'Distance, with sharp corners.' },
        { name: 'chamfer', description: 'With `delta`, cuts corners flat instead of sharp.' },
      ],
      examples: [
        {
          code: 'offset(r = 6) square([40, 25], center = true);',
          image: 'offset',
          caption: '`r` grows the square by 6 and rounds its corners to a radius of 6.',
        },
        {
          code: 'offset(delta = 6) square([40, 25], center = true);',
          image: 'offset-delta',
          caption: 'The same growth with `delta`: corners stay sharp.',
        },
      ],
      see: ['shape-radius', 'square', 'minkowski'],
      keywords: ['grow', 'shrink', 'inset', 'outset', 'round corners', 'chamfer'],
    },
    {
      id: 'hull',
      name: 'hull()',
      signature: 'hull()',
      plain:
        'Shrink-wraps everything inside it. Imagine stretching cling film over the shapes — you ' +
        'get the outside, and every dent is filled in.',
      details: [
        'The result is the **convex hull**: the smallest shape with no dents that still contains ' +
          'everything you gave it.',
        'Two spheres hulled together make a capsule; four circles at the corners of a rectangle ' +
          'hull into a rounded rectangle. That second one is exactly how `square(r = …)` is built.',
        'All children must be the same dimension — all 2D, or all 3D. A 2D hull gives a 2D shape.',
        'Holes inside the children do not survive: a hull has no interior detail by definition.',
      ],
      examples: [
        {
          code: 'hull() {\n  sphere(8);\n  translate([35, 0, 0]) sphere(8);\n}',
          image: 'hull',
          caption: 'Two balls, wrapped into a capsule.',
        },
        {
          code: 'hull() {\n  translate([0, 0]) circle(6);\n  translate([40, 0]) circle(6);\n  translate([40, 25]) circle(6);\n  translate([0, 25]) circle(6);\n}',
          image: 'hull-2d',
          caption: 'Four circles hulled into a rounded rectangle.',
        },
      ],
      see: ['minkowski', 'shape-radius'],
      keywords: ['wrap', 'convex', 'envelope', 'shrink wrap'],
    },
    {
      id: 'minkowski',
      name: 'minkowski()',
      signature: 'minkowski()',
      plain:
        'Rolls one shape around the outside of another, so the first one grows by the shape of ' +
        'the second. Roll a ball around a box and you get a box with rounded edges.',
      details: [
        'Formally: the Minkowski sum, every point of the first child added to every point of the ' +
          'second.',
        'The result grows — a `cube(10)` plus a `sphere(2)` is `14` across, not `10`. Shrink the ' +
          'original by the rolling radius first if you want to keep the outside size.',
        '**It is expensive.** Cost rises with the product of the two shapes’ complexity, so keep ' +
          'the second one simple and low-resolution. A `$fn = 12` sphere is usually plenty.',
        'For the common case of rounding a box, `cube(r = …)` gives the same shape from a ' +
          'hull, at a small fraction of the cost.',
      ],
      examples: [
        {
          code: 'minkowski() {\n  cube([30, 20, 6]);\n  sphere(3, $fn = 16);\n}',
          image: 'minkowski',
          caption: 'A slab with every edge and corner rounded by a 3-unit ball.',
        },
      ],
      see: ['hull', 'shape-radius', 'offset'],
      keywords: ['sum', 'round edges', 'fillet', 'grow'],
    },
  ],
};

export const BOOLEANS: ReferenceGroup = {
  id: 'booleans',
  title: 'Combining shapes',
  blurb: 'Add shapes together, cut one out of another, or keep only the overlap.',
  entries: [
    {
      id: 'union',
      name: 'union()',
      signature: 'union()',
      plain:
        'Glues shapes together into one. Anywhere any of them is solid, the result is solid.',
      details: [
        'You rarely have to write it: shapes sitting side by side in the same block are already ' +
          'unioned. It is worth writing when you need a group to act as a single child of ' +
          'something else — the first child of a `difference()`, say.',
        'Overlapping unioned shapes merge properly; they do not leave a wall between them.',
        'All children must be the same dimension.',
      ],
      examples: [
        {
          code: 'union() {\n  cube([30, 30, 8], center = true);\n  cylinder(h = 26, r = 7, center = true);\n}',
          image: 'union',
          caption: 'One solid, not two touching ones.',
        },
      ],
      see: ['difference', 'intersection'],
      keywords: ['add', 'join', 'merge', 'combine', 'plus'],
    },
    {
      id: 'difference',
      name: 'difference()',
      signature: 'difference()',
      plain:
        'Cuts shapes out of the first one. The first shape is the material; everything after it ' +
        'is a hole.',
      details: [
        '**Order matters.** The first child is kept and every later child is removed from it.',
        'Make the cutting shape slightly longer than the thing it passes through. A hole that ' +
          'ends exactly flush with the surface leaves a zero-thickness face, which shows up as ' +
          'flickering on screen and as a defect in the export. Sticking out by `0.01` on each ' +
          'side is enough.',
        'All children must be the same dimension.',
        'BetterSCAD’s `negative()` does the same job written the other way round — the hole next ' +
          'to the thing it goes through, instead of a `difference()` wrapped around both.',
      ],
      examples: [
        {
          code: 'difference() {\n  cube([40, 40, 12], center = true);\n  cylinder(h = 20, r = 12, center = true);\n}',
          image: 'difference',
          caption: 'The cylinder is removed from the block, leaving a hole through it.',
        },
      ],
      see: ['negative', 'union', 'intersection'],
      keywords: ['subtract', 'cut', 'hole', 'remove', 'minus'],
    },
    {
      id: 'intersection',
      name: 'intersection()',
      signature: 'intersection()',
      plain:
        'Keeps only the part where every shape overlaps. If one of them is missing from a spot, ' +
        'nothing is left there.',
      details: [
        'Order does not matter, unlike `difference()`.',
        'It is the usual way to trim something to a boundary: intersect a complicated part with ' +
          'a big cube to chop everything outside that cube away.',
        'All children must be the same dimension. With no overlap at all, the result is empty.',
      ],
      examples: [
        {
          code: 'intersection() {\n  cube(26, center = true);\n  sphere(17);\n}',
          image: 'intersection',
          caption: 'Only the volume inside both the cube and the sphere survives.',
        },
      ],
      see: ['union', 'difference', 'intersection_for'],
      keywords: ['overlap', 'common', 'both', 'trim', 'clip'],
    },
  ],
};

export const EXTRUSIONS: ReferenceGroup = {
  id: 'extrusions',
  title: 'Between 2D and 3D',
  blurb: 'Turn a flat outline into a solid, or flatten a solid back into an outline.',
  entries: [
    {
      id: 'linear_extrude',
      name: 'linear_extrude()',
      signature: 'linear_extrude(height, center, convexity, twist, slices, scale, v)',
      plain:
        'Takes a flat shape and pulls it straight upward into a solid, like squeezing toothpaste ' +
        'through a shaped nozzle.',
      details: [
        '`height` is how far it is pulled. `center = true` splits that about the origin, from ' +
          '`-height/2` to `+height/2`.',
        '`twist` rotates the top relative to the bottom, in degrees, giving a spiral. Note that ' +
          'it turns **clockwise** seen from above, which is the opposite of `rotate()`.',
        '`scale` shrinks or grows the shape as it rises — a number, or `[x, y]` for a different ' +
          'factor on each axis. `scale = 0` brings it to a point.',
        '`slices` is how many horizontal steps the twist is cut into. More is smoother and ' +
          'heavier. Left alone, it is chosen from the twist angle.',
        '`v` extrudes along an arbitrary direction instead of straight up Z.',
        'The child must be 2D. `convexity` is accepted for compatibility and has no effect.',
      ],
      params: [
        { name: 'height', description: 'Extrusion distance. Default `100`.' },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
        { name: 'twist', description: 'Degrees of rotation over the height. Clockwise from above.' },
        { name: 'scale', description: 'Size at the top: a number or `[x, y]`. Default `1`.' },
        { name: 'slices', description: 'Steps used for a twist. Default: derived from `twist`.' },
        { name: 'v', description: 'Direction to extrude along. Default `[0, 0, 1]`.' },
      ],
      examples: [
        {
          code: 'linear_extrude(height = 20) square([30, 18], center = true);',
          image: 'linear-extrude',
          caption: 'A flat rectangle pulled up into a block.',
        },
        {
          code: 'linear_extrude(height = 40, twist = 180, scale = 0.4, $fn = 60)\n  square([24, 24], center = true);',
          image: 'linear-extrude-twist',
          caption: '`twist` and `scale` applied over the same extrusion.',
        },
      ],
      see: ['rotate_extrude', 'projection', 'square'],
      keywords: ['extrude', 'pull', 'thickness', 'twist', '3d from 2d'],
    },
    {
      id: 'rotate_extrude',
      name: 'rotate_extrude()',
      signature: 'rotate_extrude(angle, start, convexity)',
      plain:
        'Spins a flat shape around the vertical axis to make a round solid — the way a potter’s ' +
        'wheel turns a flat profile into a bowl.',
      details: [
        'The profile must sit at **x >= 0**. Anything at negative X would sweep through the axis ' +
          'and turn the solid inside out, so it is an error.',
        '`angle` is how far round it goes, in degrees. The default is `360`, a full revolution; ' +
          'less leaves an open wedge with flat faces at each end.',
        '`start` is the angle it begins at, so `start`/`angle` together place the wedge.',
        'The profile is taken in the XZ plane: X becomes the distance from the axis, and the ' +
          'profile’s Y becomes the model’s Z.',
        'Resolution follows `$fn`/`$fa`/`$fs`, measured on the largest radius.',
        '`convexity` is accepted for compatibility and has no effect.',
      ],
      params: [
        { name: 'angle', description: 'Degrees to sweep. Default `360`.' },
        { name: 'start', description: 'Angle the sweep begins at. Default `0`.' },
      ],
      examples: [
        {
          code: 'rotate_extrude($fn = 64)\n  translate([20, 0]) circle(6, $fn = 32);',
          image: 'rotate-extrude',
          caption: 'A circle held 20 away from the axis, swept all the way round: a doughnut.',
        },
        {
          code: 'rotate_extrude(angle = 240, $fn = 64)\n  translate([20, 0]) square([8, 14]);',
          image: 'rotate-extrude-angle',
          caption: '`angle = 240` stops the sweep two-thirds of the way round.',
        },
      ],
      see: ['linear_extrude', 'cylinder'],
      keywords: ['revolve', 'lathe', 'spin', 'torus', 'ring', 'bowl'],
    },
    {
      id: 'projection',
      name: 'projection()',
      signature: 'projection(cut)',
      plain:
        'Flattens a solid back into a flat outline — either its shadow from directly above, or ' +
        'the slice where it crosses the ground.',
      details: [
        '`cut = false` (the default) is the shadow: everything the solid covers, seen from above, ' +
          'merged into one outline.',
        '`cut = true` is a cross-section: the exact slice of the solid at `z = 0`. Translate the ' +
          'solid down first to slice it somewhere else.',
        'The result is 2D, so it can be extruded again, offset, or exported as SVG or DXF.',
      ],
      params: [
        { name: 'cut', description: '`true` slices at `z = 0` instead of casting a shadow.' },
      ],
      examples: [
        {
          code: 'projection() {\n  cylinder(h = 30, r1 = 20, r2 = 6);\n  translate([0, 0, 10]) cube([44, 8, 6], center = true);\n}',
          image: 'projection',
          caption: 'The shadow of a cone and a bar, flattened into one outline.',
        },
        {
          code: [
            'projection(cut = true)',
            '  translate([0, 0, -8]) difference() {',
            '    cylinder(h = 30, r = 20, $fn = 64);',
            '    translate([0, 0, -1]) cylinder(h = 32, r = 12, $fn = 64);',
            '  }',
          ].join('\n'),
          image: 'projection-cut',
          caption:
            'A slice through a tube, taken at `z = 0` after moving the tube down. A shadow of ' +
            'the same tube would have been a solid disc — the hole only survives in a section.',
        },
      ],
      see: ['linear_extrude', 'offset'],
      keywords: ['flatten', 'shadow', 'slice', 'section', '2d from 3d'],
    },
  ],
};
