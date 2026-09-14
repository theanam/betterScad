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
  blurb: 'Three shapes you would otherwise build by hand every time.',
  entries: [
    {
      id: 'rounded_square',
      name: 'rounded_square()',
      signature: 'rounded_square(size, r, center)',
      extension: true,
      plain:
        'A flat rectangle with rounded corners. Exactly like `square()`, plus a number for how ' +
        'round the corners are.',
      details: [
        '`size` and `center` behave exactly as they do for `square()`: a number or `[x, y]`, and ' +
          '`center = true` puts the origin in the middle.',
        '`r` is the corner radius. It is clamped to half the shortest side, with a warning — past ' +
          'that there is no straight section left to round.',
        'At exactly half the shortest side the corners meet and you get a stadium shape. At ' +
          '`r = 0` you get a plain square.',
        'It is built as the hull of four corner circles, which **is** the Minkowski sum of the ' +
          'rectangle and a disc, without the cost of computing one. Rounding resolution follows ' +
          '`$fn`/`$fa`/`$fs` as usual.',
      ],
      params: [
        { name: 'size', description: 'Number, or `[x, y]`.' },
        { name: 'r', description: 'Corner radius, clamped to half the shortest side.' },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
      ],
      downgrade:
        'A generated module using the same hull of four circles, defined once however many times ' +
        'it is used.',
      examples: [
        {
          code: 'rounded_square([44, 28], 8);',
          image: 'rounded-square',
          caption: 'A 44 x 28 rectangle with corners of radius 8.',
        },
        {
          code: 'rounded_square(30, 15);',
          image: 'rounded-square-stadium',
          caption: 'At exactly half the shortest side the corners meet: a stadium.',
        },
      ],
      see: ['square', 'rounded_cube', 'offset', 'hull'],
      keywords: ['rounded', 'corners', 'radius', 'rectangle', 'fillet', '2d'],
    },
    {
      id: 'rounded_cube',
      name: 'rounded_cube()',
      signature: 'rounded_cube(size, r, center)',
      extension: true,
      plain:
        'A box with rounded edges and corners — the shape almost every enclosure actually is. ' +
        'Like `cube()`, plus a radius.',
      details: [
        '`size` and `center` behave exactly as they do for `cube()`.',
        '`r` is clamped to half the shortest side, with a warning. At exactly half, it is a capsule.',
        'Built as the hull of eight corner spheres — the Minkowski sum of the box and a ball, ' +
          'without paying for a Minkowski. Resolution follows `$fn`/`$fa`/`$fs`.',
        'Every edge is rounded, not just the vertical ones. For vertical-only rounding, extrude a ' +
          '`rounded_square()` instead.',
      ],
      params: [
        { name: 'size', description: 'Number, or `[x, y, z]`.' },
        { name: 'r', description: 'Radius, clamped to half the shortest side.' },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
      ],
      downgrade:
        'A generated module using the same hull of eight spheres, defined once however many times ' +
        'it is used.',
      examples: [
        {
          code: 'rounded_cube([44, 30, 16], 4, $fn = 32);',
          image: 'rounded-cube',
          caption: 'Every edge and corner rounded to a radius of 4.',
        },
        {
          code: 'linear_extrude(height = 16) rounded_square([44, 30], 6);',
          image: 'rounded-cube-vertical',
          caption: 'Extruding a `rounded_square()` instead rounds the sides but leaves the top flat.',
        },
      ],
      see: ['cube', 'rounded_square', 'minkowski', 'hull'],
      keywords: ['rounded', 'box', 'fillet', 'enclosure', 'radius', 'edges'],
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
          code: 'translatez(10) rotatez(45) rounded_cube([30, 20, 8], 3);',
          norender: true,
          caption: 'Written in BetterSCAD…',
        },
        {
          code: [
            'module __rounded_cube(size, r) {',
            '  hull() for (x = [r, size[0] - r], y = [r, size[1] - r], z = [r, size[2] - r])',
            '    translate([x, y, z]) sphere(r = r);',
            '}',
            '',
            'translate([0, 0, 10]) rotate([0, 0, 45]) __rounded_cube([30, 20, 8], 3);',
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
