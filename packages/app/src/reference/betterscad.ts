/**
 * Everything BetterSCAD adds on top of OpenSCAD.
 *
 * One rule governs the whole list: every addition has a defined way back to
 * plain `.scad`, so nothing written here can strand a file. Each entry states
 * its own downgrade, and `is_range()` states that it has none.
 */

import type { ReferenceGroup } from './types.js';

export const NEW_SHAPES: ReferenceGroup = {
  id: 'new-shapes',
  title: 'Shapes',
  blurb: 'Four shapes you would otherwise build by hand every time.',
  entries: [
    {
      id: 'shape-radius',
      name: 'cube(r), square(r)',
      signature: 'cube(size, center, r) | square(size, center, r)',
      extension: true,
      plain:
        'A box or a rectangle with its edges eased off. It is the same `cube()` and `square()` ' +
        'you already use, with one more number on the end for how round the edges are.',
      details: [
        '`r` is the radius. Leave it out, or set it to `0`, and you have the stock primitive — ' +
          'the file exports byte for byte, and nothing is reported as an extension. It is only ' +
          'a BetterSCAD file once you actually round something.',
        '**`r` comes after `center`, not before it.** `cube(10, true)` has meant one thing since ' +
          'OpenSCAD was written and still does; the radius takes the third slot. Named ' +
          'arguments — `cube(10, r = 2)` — sidestep the question entirely and are what you ' +
          'should write.',
        'It is clamped to half the shortest side, with a warning: past that there is no straight ' +
          'section left to round. At exactly half, a square becomes a stadium and a cube a ' +
          'capsule.',
        '`cube(r = …)` rounds **every** edge, not just the vertical ones. For a box with rounded ' +
          'sides and a flat top, extrude a rounded square instead — the second example below.',
        'Both are built as the hull of their corner primitives, which **is** the Minkowski sum of ' +
          'the box and a disc or sphere, without the cost of computing one. The rounding follows ' +
          '`$fn`/`$fa`/`$fs` as usual.',
      ],
      params: [
        { name: 'size', description: 'As always: a number, or `[x, y]` / `[x, y, z]`.' },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
        { name: 'r', description: 'Edge radius, clamped to half the shortest side. Default `0`.' },
      ],
      downgrade:
        'With no `r`, nothing — the call is already stock. With one, a generated module using the ' +
        'same hull of corner circles or spheres, defined once however many times it is used.',
      examples: [
        {
          code: 'cube([44, 30, 16], r = 4, $fn = 32);',
          image: 'cube-radius',
          caption: 'Every edge and corner rounded to a radius of 4.',
        },
        {
          code: 'linear_extrude(height = 16) square([44, 30], r = 6);',
          image: 'square-radius-extruded',
          caption: 'Extruding a rounded square instead rounds the sides but leaves the top flat.',
        },
        {
          code: 'square([44, 28], r = 8);',
          image: 'square-radius',
          caption: 'The 2D form: a 44 x 28 rectangle with corners of radius 8.',
        },
        {
          code: 'square(30, r = 15);',
          image: 'square-radius-stadium',
          caption: 'At exactly half the shortest side the corners meet: a stadium.',
        },
      ],
      see: ['cube', 'square', 'cylinder-fillet', 'offset', 'hull', 'minkowski'],
      keywords: [
        'rounded', 'corners', 'radius', 'fillet', 'rounded_cube', 'rounded_square', 'box',
        'enclosure', 'edges',
      ],
    },
    {
      id: 'text-radius',
      name: 'text(radius)',
      signature: 'text(…, radius, start, facing)',
      extension: true,
      plain:
        'Bends a line of writing around a circle, the way a name runs around the rim of a coin. ' +
        'Give `text()` a radius and the letters follow it instead of sitting on a straight line.',
      details: [
        '`start` is the angle the run begins at, in degrees, measured the way `rotate()` measures ' +
          'them. It defaults to `90` — the top.',
        '`facing` is `"out"` (the default), where the letters stand away from the centre, or ' +
          '`"in"`, where they face it. The far side of a dial wants `"in"`: it keeps the words ' +
          'the right way up when you read them.',
        '**`halign` still means what it always did**, measured around `start` rather than around ' +
          'x = 0 — `"center"` centres the run on the angle, `"right"` ends there. `valign` still ' +
          'shifts the baseline, which out here moves it towards or away from the centre.',
        'Letters are spaced by their real widths, so an `i` takes less of the arc than an `M`. ' +
          'Each one is placed at the middle of its own width and turned to the tangent; the ' +
          'letters are not themselves bent, so a very tight circle with very large text will ' +
          'show gaps at the tops of the letters. More radius or less size is the fix.',
        'A radius of zero is an error rather than a guess, and a circle cannot be combined with ' +
          'a vertical `direction` — those are two different answers to "which way does the run ' +
          'go".',
        'Without `radius` this is the stock `text()`, and the file exports byte for byte.',
      ],
      params: [
        { name: 'radius', description: 'Radius of the baseline circle. Required for an arc.' },
        { name: 'start', description: 'Angle the run begins at, in degrees. Default `90`.' },
        { name: 'facing', description: '`"out"` (default) or `"in"`.' },
      ],
      downgrade:
        'A generated module that places each glyph with its own `text()` call. OpenSCAD has no ' +
        'way to measure a glyph — `textmetrics()` is not in the release this targets — so the ' +
        'letter widths are measured when the file is written and carried into it as a table. ' +
        'Size, spacing, radius and even the string stay live in the exported file; only the ' +
        'measurements are fixed. **Saving needs the font loaded**, and says so rather than ' +
        'writing text in the wrong places.',
      examples: [
        {
          code: 'text("BETTERSCAD", size = 5, radius = 20, halign = "center", $fn = 48);',
          image: 'text-radius',
          caption: 'A run centred on the top of a circle of radius 20.',
        },
        {
          code: [
            '$fn = 48;',
            'text("BETTERSCAD", size = 5, radius = 22, halign = "center");',
            'text("BATTERY CAP", size = 5, radius = 22, halign = "center",',
            '     start = 270, facing = "in");',
            'difference() { circle(28); circle(26); }',
          ].join('\n'),
          image: 'text-radius-dial',
          caption: '`facing = "in"` at the bottom, so both halves read the same way up.',
        },
        {
          code: [
            '$fn = 64;',
            'difference() {',
            '  cylinder(h = 4, r = 30, fillet2 = 1);',
            '  translatez(3) linear_extrude(2)',
            '    text("BETTERSCAD", size = 6, radius = 22, halign = "center");',
            '}',
          ].join('\n'),
          image: 'text-radius-engraved',
          caption: 'Extruded and subtracted, which is how it ends up engraved in a lid.',
        },
        {
          code: [
            '$fn = 32;',
            'for (i = [0 : 11])',
            '  text(str(i * 5), size = 3, radius = 22, halign = "center", start = 90 - i * 30);',
            'difference() { circle(28); circle(26); }',
          ].join('\n'),
          image: 'text-radius-gauge',
          caption: 'One call per label, each at its own angle — a gauge face.',
        },
      ],
      see: ['text', 'shape-radius', 'cylinder-fillet', 'rotate'],
      keywords: [
        'text on a circle', 'arc', 'curved text', 'around', 'dial', 'bezel', 'coin', 'ring',
        'engrave', 'label', 'path',
      ],
    },
    {
      id: 'cylinder-fillet',
      name: 'cylinder(fillet)',
      signature: 'cylinder(…, fillet, fillet1, fillet2, fillet_style)',
      extension: true,
      plain:
        'Takes the sharp rim off the end of a cylinder — rounded like a worn edge, or cut flat ' +
        'like a chamfer. `fillet` does both ends; `fillet1` is the bottom and `fillet2` the top.',
      details: [
        '`fillet1` and `fillet2` are numbered the same way round as `r1` and `r2`: **1 is the ' +
          'bottom, 2 is the top.** Either overrides `fillet` for its own end, exactly as `r1` ' +
          'overrides `r`. There is one convention on this module for "both, or each", and this ' +
          'is it.',
        '`fillet_style` is `"round"` (the default) — a true arc, tangent to both the wall and the ' +
          'face — or `"chamfer"`, a straight cut across the same two points. They are one ' +
          'argument rather than two shapes because they are the same construction: the chamfer ' +
          'is the chord of the fillet.',
        'It works on a cone as well as a straight cylinder. On a taper the corner is not a right ' +
          'angle, so the arc that meets both edges is not a quarter circle — the profile is ' +
          'solved for the actual angle rather than assumed.',
        'A fillet larger than the end it is easing is clamped to fit, with a warning.',
        'With no fillet this is the stock primitive: it exports byte for byte and is not reported ' +
          'as an extension. `fillet = 0` is the same shape as leaving it out, not a revolve that ' +
          'merely measures the same.',
      ],
      params: [
        { name: 'fillet', description: 'Radius at both ends. Default `0`.' },
        { name: 'fillet1', description: 'Bottom end, overriding `fillet`.' },
        { name: 'fillet2', description: 'Top end, overriding `fillet`.' },
        { name: 'fillet_style', description: '`"round"` (default) or `"chamfer"`.' },
      ],
      downgrade:
        'With no fillet, nothing — the call is already stock. With one, a generated module that ' +
        'revolves the same profile, defined once however many times it is used.',
      examples: [
        {
          code: 'cylinder(h = 24, r = 10, fillet = 3, $fn = 64);',
          image: 'cylinder-fillet',
          caption: 'Both ends rounded by 3.',
        },
        {
          code: 'cylinder(h = 24, r = 10, fillet2 = 6, $fn = 64);',
          image: 'cylinder-fillet-top',
          caption: '`fillet2` is the top only — 2 is the top, as it is for `r2`.',
        },
        {
          code: 'cylinder(h = 24, r = 10, fillet = 3, fillet_style = "chamfer", $fn = 64);',
          image: 'cylinder-chamfer',
          caption: 'The same 3, cut flat instead of rounded.',
        },
        {
          code: 'cylinder(h = 24, r1 = 14, r2 = 6, fillet = 2.5, $fn = 64);',
          image: 'cylinder-fillet-cone',
          caption: 'On a taper the corner is not square, and the arc is solved for the real angle.',
        },
      ],
      see: ['cylinder', 'shape-radius', 'rotate_extrude', 'minkowski'],
      keywords: ['fillet', 'chamfer', 'round', 'edge', 'rim', 'break edge', 'ease'],
    },
    {
      id: 'regular_polygon',
      name: 'regular_polygon()',
      signature: 'regular_polygon(sides, length)',
      extension: true,
      plain:
        'A flat shape with any number of equal sides — a hexagon, a pentagon — described the way ' +
        'you would measure one: by how long a side is.',
      details: [
        '`circle($fn = 6)` already gives a hexagon, but you have to work out the radius that ' +
          'produces the side length you actually want. This does that arithmetic for you.',
        'The circumradius used is `length / (2 * sin(180 / sides))`.',
        'Fewer than three sides cannot close a shape, and a side length of zero or less has no ' +
          'shape to describe. Both are errors rather than an empty result.',
        'The polygon is centred on the origin, with a vertex on the +X axis.',
      ],
      params: [
        { name: 'sides', description: 'Number of sides. Three or more.' },
        { name: 'length', description: 'Length of one side. Greater than zero.' },
      ],
      downgrade: 'A generated module wrapping `circle($fn = sides)` at the matching circumradius.',
      examples: [
        {
          code: 'regular_polygon(6, 20);',
          image: 'regular-polygon',
          caption: 'A hexagon whose every side is exactly 20 long.',
        },
        {
          code: 'linear_extrude(6) regular_polygon(5, 18);',
          image: 'regular-polygon-extruded',
          caption: 'A pentagon, extruded.',
        },
      ],
      see: ['circle', 'polygon', 'fn'],
      keywords: ['hexagon', 'pentagon', 'octagon', 'equilateral', 'nut', 'side length'],
    },
    {
      id: 'thread',
      name: 'thread()',
      signature: 'thread(d, pitch, h, internal, clearance, angle, chamfer, center, segments)',
      extension: true,
      plain:
        'A screw thread. Give it the diameter of the bolt, how far one turn advances, and how ' +
        'long it should be. Add `internal = true` and you get the hole that same bolt screws ' +
        'into — the two are made to fit.',
      details: [
        '`d` is the outside diameter, measured across the crests, and `pitch` is how far the ' +
          'thread advances in one turn. A common M8 bolt is `d = 8, pitch = 1.25`. Both are ' +
          'ordinary numbers; there is no table of standard sizes to look a name up in.',
        'The thread is right-handed, single start, and sits on a solid core, so `thread()` on ' +
          'its own is already a threaded rod — there is nothing to add a shaft to.',
        '`internal = true` is the whole mating story. It builds the **solid to subtract**, not ' +
          'the nut: put it under `negative()` or in a `difference()` and what is left is a hole ' +
          'the matching bolt turns into.',
        '`clearance` (default `0.2`) is the gap between the pair, and only the internal thread ' +
          'grows by it — a bolt always measures the `d` you asked for. Raise it for a looser ' +
          'fit or a printer that runs wide; `0` gives a geometrically exact pair, which will ' +
          'not assemble in any real material.',
        'The clearance is uniform, not merely radial: the female groove is wider across the ' +
          'flanks as well as deeper, which is what actually lets the two turn against each other.',
        'Both are the same construction with one number changed, so a bolt and its hole cannot ' +
          'drift apart. Anything true of one is true of the other.',
        '`chamfer` (default `true`) shapes the ends. External threads taper in, so the first ' +
          'turn runs out instead of ending in a knife edge that will not print. Internal ones ' +
          'flare out into a countersink, which is what lets a bolt start square rather than ' +
          'cross-threading. Set it `false` for a thread that continues into adjoining geometry.',
        '`angle` (default `60`) is the included angle of the tooth. 60 is the ISO metric ' +
          'profile; 29 is roughly an Acme leadscrew. The crest and root truncations follow ISO ' +
          'proportions at any angle.',
        '`center` behaves as it does for `cylinder()`. `segments` is the number of facets per ' +
          'turn; it follows `$fn`/`$fa`/`$fs` but never drops below 24, because a coarse circle ' +
          'is merely faceted while a coarse helix stops being a thread at all.',
        'A thread is a lot of geometry — a turn of facets for every turn of the helix. A long, ' +
          'fine-pitched, high-`$fn` thread says so in a warning rather than just going slow.',
        'A pitch too coarse for the diameter, or a clearance so large the groove closes up, are ' +
          'errors rather than a shape that is quietly not a thread.',
      ],
      params: [
        { name: 'd', description: 'Outside diameter, across the crests.' },
        { name: 'pitch', description: 'How far one turn advances.' },
        { name: 'h', description: 'Length of the threaded section.' },
        {
          name: 'internal',
          description:
            '`true` builds the solid to subtract for a matching hole. Default `false`.',
        },
        {
          name: 'clearance',
          description: 'Fit between the pair, applied to the internal thread only. Default `0.2`.',
        },
        { name: 'angle', description: 'Included angle of the tooth. Default `60`.' },
        {
          name: 'chamfer',
          description: 'Shape the ends — taper outside, countersink inside. Default `true`.',
        },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
        { name: 'segments', description: 'Facets per turn. Defaults from `$fn`, floored at 24.' },
      ],
      downgrade:
        'A generated module sweeping the same profile up the same twisted extrusion, defined ' +
        'once however many times it is used.',
      examples: [
        {
          code: 'thread(d = 8, pitch = 1.25, h = 10, $fn = 48);',
          image: 'thread',
          view: 'plan',
          zoom: 1.35,
          caption:
            'An M8 threaded rod: `d = 8` across the crests, advancing 1.25 per turn. Both ends ' +
            'taper so the first turn runs out rather than ending in a knife edge.',
        },
        {
          code: `difference() {
  cylinder(h = 7, r = 7.5, $fn = 6);
  thread(d = 8, pitch = 1.25, h = 7, internal = true, $fn = 48);
}`,
          image: 'thread-nut',
          view: 'plan',
          caption:
            'The same numbers with `internal = true`, subtracted from a hex blank: a nut the rod ' +
            'above screws into.',
        },
        {
          code: `union() {
  cylinder(h = 6, r = 9, $fn = 48);
  negative() thread(d = 8, pitch = 1.25, h = 6, internal = true, $fn = 48);
}`,
          image: 'thread-negative',
          view: 'plan',
          caption:
            'Written with `negative()` instead, so the threaded hole sits next to the thing it ' +
            'goes through.',
        },
      ],
      see: ['negative', 'cylinder', 'difference', 'regular_polygon', 'fn'],
      keywords: [
        'screw',
        'bolt',
        'nut',
        'helix',
        'helical',
        'metric',
        'iso',
        'm3',
        'm4',
        'm5',
        'm6',
        'm8',
        'tap',
        'tapped',
        'fastener',
        'pitch',
        'acme',
        'leadscrew',
        'threaded rod',
      ],
    },
  ],
};

export const NEGATIVE_SPACE: ReferenceGroup = {
  id: 'negative-space',
  title: 'Negative space',
  blurb: 'Write a hole where the hole is, instead of hoisting it to the top of the file.',
  entries: [
    {
      id: 'negative',
      name: 'negative()',
      signature: 'negative() { … }',
      extension: true,
      plain:
        'Turns whatever is inside it into a hole instead of material. The hole is cut out of ' +
        'everything else nearby, so you can write it right next to the thing it goes through.',
      details: [
        'With `difference()`, the material has to come first and every hole has to be collected ' +
          'after it. In a model of any size that means the hole ends up a long way from the part ' +
          'it belongs to. `negative()` lets you write it in place.',
        '**Its reach is the enclosing braces** — the `{ … }` block, module body, or top level it ' +
          'is written in. Never further. It is global only when written at the top level.',
        'Wrappers that are not scopes are transparent to it: `translate`, `rotate`, `color`, ' +
          '`if`, `for` and `let` pass a negative through to the enclosing scope, carrying their ' +
          'transforms with it. So `translate([5, 0, 0]) negative() cube(10)` and ' +
          '`negative() translate([5, 0, 0]) cube(10)` cut identically.',
        'Adding braces makes a wrapper a scope, which contains the negative: ' +
          '`translate([5, 0, 0]) { negative() cube(10); }` cuts nothing, and warns.',
        'A module body is always a scope, braced or not, so a `negative()` inside a module can ' +
          'never reach out and cut its caller.',
        'A negative that reaches its scope with nothing to cut produces no geometry, and reports ' +
          'a warning.',
      ],
      downgrade:
        'The enclosing scope is rewritten as `difference() { union() { …siblings… } …negatives… }`, ' +
        'with each cutter keeping the wrappers it was written under. The geometry is identical, ' +
        'and the round trip is covered by tests for every nesting case above.',
      examples: [
        {
          code: [
            'union() {',
            '  cylinder(h = 8, r = 26, $fn = 64);',
            '  cylinder(h = 22, r = 10, $fn = 48);',
            '',
            '  negative() {',
            '    translate([0, 0, -1]) cylinder(h = 30, r = 5, $fn = 40);',
            '    for (i = [0 : 4])',
            '      rotate([0, 0, i * 72]) translate([18, 0, -1]) cylinder(h = 10, r = 2.5, $fn = 24);',
            '  }',
            '}',
          ].join('\n'),
          image: 'negative',
          caption: 'One `negative()` block cuts both the plate and the boss above it.',
        },
        {
          code: [
            'cube([40, 40, 10]);',
            'translate([20, 20, -1]) negative() cylinder(h = 12, r = 8, $fn = 40);',
          ].join('\n'),
          image: 'negative-bubble',
          caption:
            'The negative is written under a `translate`, which is not a scope — so it rides up ' +
            'to the top level, keeping the transform, and cuts the cube.',
        },
      ],
      see: ['difference', 'background', 'highlight'],
      keywords: ['hole', 'cut', 'subtract', 'difference', 'negative space', 'bore'],
    },
  ],
};

export const SHORTHAND: ReferenceGroup = {
  id: 'shorthand',
  title: 'Transforms without the brackets',
  blurb: 'The same three transforms, written the way you would say them out loud.',
  entries: [
    {
      id: 'loose-numbers',
      name: 'translate(x, y, z)',
      signature: 'translate(x, y, z) | rotate(x, y, z) | mirror(x, y, z)',
      extension: true,
      plain:
        'Write the numbers straight into the brackets instead of wrapping them in a list. ' +
        '`translate(10, 5, 2)` means the same as `translate([10, 5, 2])`.',
      details: [
        'Available on `translate`, `rotate` and `mirror`.',
        'A missing third number is `0`, so `translate(10, 5)` moves in X and Y only.',
        '**Stock spellings are untouched.** `rotate(a, v)` is still the axis rotation it always ' +
          'was, and a single argument still means what it always did — the loose form only ' +
          'applies from the second argument onwards.',
      ],
      downgrade: 'The numbers are collected back into a vector. Exact.',
      examples: [
        {
          code: '%cube(20);\ntranslate(30, 10, 5) cube(20);',
          image: 'loose-numbers',
          caption: 'The same move as `translate([30, 10, 5])`, with two fewer brackets.',
        },
      ],
      see: ['translate', 'rotate', 'mirror', 'translatex'],
      keywords: ['loose', 'numbers', 'brackets', 'shorthand', 'vector'],
    },
    {
      id: 'translatex',
      name: 'translatex(), translatey(), translatez()',
      signature: 'translatex(d) | translatey(d) | translatez(d)',
      extension: true,
      plain:
        'Move along one axis, with the axis in the name. `translatez(10)` lifts something ten ' +
        'units up — no counting commas to check which slot is which.',
      details: [
        'Exactly equivalent to the matching `translate()` call, and stackable with everything else.',
        'The gain is at reading time, not writing time: `translatez(-1)` on a cutter says "poke ' +
          'it through the bottom" in a way `translate([0, 0, -1])` does not.',
      ],
      params: [{ name: 'd', description: 'Distance along that axis.' }],
      downgrade:
        '`translatex(d)` becomes `translate([d, 0, 0])`, and likewise for Y and Z. Exact, and ' +
        'rewritten in place rather than via a module.',
      examples: [
        {
          code: '%cube(20);\ntranslatez(28) cube(20);',
          image: 'translatez',
          caption: 'Straight up, with the axis named rather than counted.',
        },
      ],
      see: ['translate', 'rotatex', 'mirrorx'],
      keywords: ['axis', 'move', 'x', 'y', 'z', 'shorthand'],
    },
    {
      id: 'rotatex',
      name: 'rotatex(), rotatey(), rotatez()',
      signature: 'rotatex(a) | rotatey(a) | rotatez(a)',
      extension: true,
      plain:
        'Turn about one axis, with the axis in the name. `rotatez(90)` spins something a quarter ' +
        'turn about the vertical axis.',
      details: [
        'The angle is in degrees, and the rotation is about the origin — the same as `rotate()`.',
        'Equivalent to `rotate()` with zeros in the other two slots.',
      ],
      params: [{ name: 'a', description: 'Degrees about that axis.' }],
      downgrade: '`rotatex(a)` becomes `rotate([a, 0, 0])`, and likewise for Y and Z. Exact.',
      examples: [
        {
          code: '%cylinder(h = 30, r = 6, $fn = 32);\nrotatex(90) cylinder(h = 30, r = 6, $fn = 32);',
          image: 'rotatex',
          caption: 'The ghost stands up; `rotatex(90)` lays the same cylinder down.',
        },
      ],
      see: ['rotate', 'translatex', 'mirrorx'],
      keywords: ['axis', 'turn', 'spin', 'x', 'y', 'z', 'shorthand'],
    },
    {
      id: 'mirrorx',
      name: 'mirrorx(), mirrory(), mirrorz()',
      signature: 'mirrorx() | mirrory() | mirrorz()',
      extension: true,
      plain:
        'Flip across one plane, with the plane in the name. They take no argument at all, because ' +
        'a mirror is a plane, not a distance.',
      details: [
        '`mirrorx()` flips across the YZ plane — the one facing along X — so left and right swap. ' +
          '`mirrory()` swaps front and back, `mirrorz()` top and bottom.',
        'As with `mirror()`, the original is not kept. Write the part twice for both halves.',
      ],
      downgrade: '`mirrorx()` becomes `mirror([1, 0, 0])`, and likewise for Y and Z. Exact.',
      examples: [
        {
          code: 'module bracket() {\n  cube([26, 8, 6]);\n  cube([8, 8, 22]);\n}\n\nbracket();\nmirrorx() bracket();',
          image: 'mirrorx',
          caption: 'One bracket definition, drawn plain and mirrored, making a symmetric pair.',
        },
      ],
      see: ['mirror', 'translatex', 'rotatex'],
      keywords: ['flip', 'reflect', 'symmetry', 'plane', 'shorthand'],
    },
  ],
};

export const LANGUAGE_ADDITIONS: ReferenceGroup = {
  id: 'language-additions',
  title: 'Language',
  blurb: 'Two small additions to the language itself.',
  entries: [
    {
      id: 'c-style-for',
      name: 'C-style for',
      signature: 'for (i = start; condition; i = next) …',
      extension: true,
      plain:
        'The kind of loop most programming languages use — start here, keep going while this is ' +
        'true, change it like this each time — usable as a statement, not only inside a list.',
      details: [
        'Stock OpenSCAD allows this form only inside a list comprehension. BetterSCAD also accepts ' +
          'it as a statement, so a loop whose step is not a fixed interval does not have to be ' +
          'rewritten as a range.',
        'It is the natural way to write a loop that doubles, halves, or advances by a computed ' +
          'amount.',
        'Capped at 1,000,000 iterations, which reports a clear error rather than hanging the tab.',
      ],
      downgrade:
        'Rewritten as a bounded range `for` with the condition kept as a guard, and the original ' +
        'preserved in a comment. This is exact only for the common ' +
        '`i = start; i < limit; i = i + step` shape, so the export reports it.',
      examples: [
        {
          code: 'for (d = 4; d < 40; d = d * 1.6)\n  translate([d * 3, 0, 0]) cylinder(h = 6, d = d, $fn = 32);',
          image: 'c-style-for',
          caption: 'A step that multiplies rather than adds — awkward to write as a range.',
        },
      ],
      see: ['for', 'list-comprehension'],
      keywords: ['loop', 'c-style', 'while', 'step', 'iterate'],
    },
    {
      id: 'is_range',
      name: 'is_range()',
      signature: 'is_range(x)',
      extension: true,
      plain:
        '`true` when a value is a range like `[0 : 10]`. It fills the one gap in OpenSCAD’s set ' +
        'of type checks.',
      details: [
        'Every other type has an `is_*` function; ranges did not, so a module that accepts either ' +
          'a range or a list had no way to tell them apart.',
        '**This is the one extension with no way back to plain `.scad`.** A call is left exactly ' +
          'as written on export, and evaluates to `undef` in stock OpenSCAD — and you are *not* ' +
          'warned about it, because there is no rewrite to describe. Avoid it in files you intend ' +
          'to share.',
      ],
      downgrade:
        'None. The call is left as written and becomes `undef` in stock OpenSCAD. This is the ' +
        'single exception to the downgrade rule, and is called out wherever it appears.',
      examples: [
        {
          code: 'echo(is_range([0 : 10]), is_range([0, 1, 2]), is_list([0 : 10]));',
          output: 'ECHO: true, false, false',
        },
      ],
      see: ['is_num', 'for'],
      keywords: ['range', 'type', 'predicate', 'check'],
    },
  ],
};

export const PORTABILITY: ReferenceGroup = {
  id: 'portability',
  title: 'Getting back to plain OpenSCAD',
  blurb: 'What happens to all of the above when you save a file for someone else.',
  entries: [
    {
      id: 'downgrade',
      name: 'Save as OpenSCAD .scad',
      extension: true,
      plain:
        'Everything on this page can be written back out as ordinary OpenSCAD. The app rewrites ' +
        'it for you, shows you exactly which lines will change first, and a file that needs no ' +
        'changes is saved byte for byte.',
      details: [
        'It lives in the **Save** menu, and is offered whatever the file’s extension is: a `.scad` ' +
          'that uses extensions is exactly the case where the guarantee is worth having and the ' +
          'file name does not give it away.',
        'Two rules govern what comes out. A one-liner is rewritten in place — `translatez(4)` ' +
          'becomes `translate([0, 0, 4])` on the spot. Anything larger becomes a **generated ' +
          'module**, named `__<shape>`, defined once however many times it is used, so the ' +
          'exported file keeps the shape of the file that produced it.',
        'A generated name that the source already declares gets a numbered suffix rather than ' +
          'shadowing it.',
        '`is_range()` is the single exception, and says so in its own entry.',
        'On the command line: `bscad model.bscad --legacy-scad -o out.scad`.',
      ],
      examples: [
        {
          code: 'translatez(10) rotatez(45) cube([30, 20, 8], r = 3);',
          norender: true,
          caption: 'Written in BetterSCAD…',
        },
        {
          code: [
            'module __rounded_cube(size, center = false, r = 0) {',
            '  hull() for (x = [r, size[0] - r], y = [r, size[1] - r], z = [r, size[2] - r])',
            '    translate([x, y, z]) sphere(r = r);',
            '}',
            '',
            'translate([0, 0, 10]) rotate([0, 0, 45]) __rounded_cube([30, 20, 8], r = 3);',
          ].join('\n'),
          norender: true,
          caption: '…and the same file saved as stock `.scad`.',
        },
      ],
      see: ['bscad-format'],
      keywords: ['export', 'legacy', 'compatibility', 'portable', 'transpile', 'downgrade'],
    },
    {
      id: 'bscad-format',
      name: 'The .bscad file',
      extension: true,
      plain:
        'BetterSCAD’s own file type — which is also just a `.scad` file. The extra bits it keeps ' +
        'live in a comment at the top, so OpenSCAD opens it without noticing.',
      details: [
        'The leading comment holds the panel layout, the Customizer presets and the camera ' +
          'position. Everything below it is ordinary source.',
        'Saving follows the extension: a `.bscad` keeps its extras, a `.scad` is written as plain ' +
          'source. Neither changes the geometry.',
        'Opening a `.scad` that uses any of the extensions above warns you, and names the lines.',
      ],
      see: ['downgrade'],
      keywords: ['file format', 'bscad', 'save', 'presets', 'camera'],
    },
  ],
};
