/**
 * The cheatsheet's shapes: the 3D solids and the 2D outlines.
 *
 * Everything here is stock OpenSCAD and behaves exactly as it does there.
 */

import type { ReferenceGroup } from './types.js';

export const SOLIDS: ReferenceGroup = {
  id: 'solids',
  title: '3D shapes',
  blurb: 'The five solids everything else is built from.',
  entries: [
    {
      id: 'cube',
      name: 'cube()',
      signature: 'cube(size, center)',
      plain:
        'A box. One number makes a cube with equal sides; three numbers make a box that is a ' +
        'different width, depth and height.',
      details: [
        '`size` is a number, or `[x, y, z]`. It defaults to `1`.',
        'By default the box sits in the corner between the three axes, with one corner on the ' +
          'origin and the whole thing in positive X, Y and Z. `center = true` moves it so the ' +
          'origin is in the middle instead — which is usually what you want when you are about ' +
          'to rotate it, because a shape rotates around the origin, not around itself.',
        'A size of zero or less on any axis produces nothing, and reports a warning.',
      ],
      params: [
        { name: 'size', description: 'Number, or `[x, y, z]`. Default `1`.' },
        { name: 'center', description: '`true` centres the box on the origin. Default `false`.' },
      ],
      examples: [
        {
          code: 'cube(20);',
          image: 'cube',
          caption: 'A 20 x 20 x 20 cube, sitting on the origin corner.',
        },
        {
          code: 'cube([40, 20, 10]);',
          image: 'cube-size',
          caption: 'Different on each axis: 40 wide, 20 deep, 10 tall.',
        },
        {
          code: '%cube(20);\ncube(20, center = true);',
          image: 'cube-center',
          caption:
            'The ghost is the default position; the solid is the same cube with `center = true`.',
        },
      ],
      see: ['rounded_cube', 'sphere', 'cylinder'],
      keywords: ['box', 'block', 'rectangle', 'brick'],
    },
    {
      id: 'sphere',
      name: 'sphere()',
      signature: 'sphere(r | d)',
      plain:
        'A ball, centred on the origin. Say how big with `r` (the radius — the distance from ' +
        'the middle to the surface) or `d` (the diameter — all the way across).',
      details: [
        'A sphere is not really round: it is a many-sided shape that gets closer to round the ' +
          'more sides you allow. `$fn`, `$fa` and `$fs` control how many. The default settings ' +
          'are deliberately coarse so that editing stays fast; raise `$fn` before you export.',
        '`d` wins if you pass both. `r` defaults to `1`.',
        'The sphere is always centred on the origin — there is no `center` argument, because ' +
          'there is nothing else it could mean.',
      ],
      params: [
        { name: 'r', description: 'Radius. Default `1`.' },
        { name: 'd', description: 'Diameter. Overrides `r`.' },
        { name: '$fn / $fa / $fs', description: 'Resolution. See the special variables.' },
      ],
      examples: [
        { code: 'sphere(12);', image: 'sphere', caption: 'A ball of radius 12, at default resolution.' },
        {
          code: 'sphere(12, $fn = 8);\ntranslate([30, 0, 0]) sphere(12, $fn = 24);\ntranslate([60, 0, 0]) sphere(12, $fn = 96);',
          image: 'sphere-fn',
          caption: 'The same ball at `$fn = 8`, `24` and `96`. Only the last one looks round.',
        },
      ],
      see: ['fn', 'cylinder'],
      keywords: ['ball', 'round', 'globe'],
    },
    {
      id: 'cylinder',
      name: 'cylinder()',
      signature: 'cylinder(h, r | r1, r2 | d, d1, d2, center)',
      plain:
        'A tube or a cone. Give it a height and a radius for a tube; give it a different radius ' +
        'at each end and it becomes a cone, or a cone with its tip cut off.',
      details: [
        '`r` sets both ends. `r1` is the bottom and `r2` the top; `d`, `d1` and `d2` are the ' +
          'diameter versions and win over the radius ones. Set one end to `0` for a proper ' +
          'pointed cone.',
        'By default the cylinder stands on the XY plane and grows upward. `center = true` puts ' +
          'the middle of its height on the origin, so it runs from `-h/2` to `+h/2`.',
        'Like a sphere, it is really a many-sided prism. With `$fn = 6` you get a clean hexagonal ' +
          'rod, which is a genuinely useful thing to want — nut pockets and hex shafts are ' +
          'usually drawn this way.',
        '`h` defaults to `1`, and a height of zero or less produces nothing.',
      ],
      params: [
        { name: 'h', description: 'Height. Default `1`.' },
        { name: 'r', description: 'Radius, both ends.' },
        { name: 'r1 / r2', description: 'Bottom and top radius.' },
        { name: 'd / d1 / d2', description: 'Diameter forms. These win over the radius forms.' },
        { name: 'center', description: '`true` centres the height on the origin. Default `false`.' },
      ],
      examples: [
        { code: 'cylinder(h = 30, r = 10);', image: 'cylinder', caption: 'A plain round rod.' },
        {
          code: 'cylinder(h = 30, r1 = 14, r2 = 0);',
          image: 'cylinder-cone',
          caption: 'A radius of `0` at the top gives a cone.',
        },
        {
          code: 'cylinder(h = 10, r = 12, $fn = 6);',
          image: 'cylinder-hex',
          caption: '`$fn = 6` turns the same call into a hexagon — a nut pocket.',
        },
      ],
      see: ['sphere', 'fn', 'rotate_extrude'],
      keywords: ['tube', 'rod', 'cone', 'pipe', 'hexagon', 'circle'],
    },
    {
      id: 'polyhedron',
      name: 'polyhedron()',
      signature: 'polyhedron(points, faces, convexity)',
      plain:
        'A shape you describe corner by corner. You list every corner, then list which corners ' +
        'make up each flat face. It is the escape hatch for shapes nothing else can make.',
      details: [
        '`points` is a list of `[x, y, z]` corners. `faces` is a list of lists: each inner list ' +
          'names the corners of one face, by their position in `points` counting from `0`.',
        '**Winding matters.** Seen from outside the solid, the corners of every face must be ' +
          'listed clockwise. Get one face backwards and the solid is inside out, which shows up ' +
          'as a failed boolean or an unprintable export rather than as an obvious error.',
        'Every edge must be shared by exactly two faces, and faces must be flat. A face with ' +
          'more than three corners that are not coplanar is not a face, and will be triangulated ' +
          'into something you did not draw.',
        '`convexity` is a rendering hint in OpenSCAD and is accepted and ignored here — ' +
          'BetterSCAD computes exact geometry, so it never needs the hint.',
      ],
      params: [
        { name: 'points', description: 'List of `[x, y, z]` corners.' },
        { name: 'faces', description: 'List of corner-index lists, wound clockwise from outside.' },
        { name: 'convexity', description: 'Accepted for compatibility; has no effect.' },
      ],
      examples: [
        {
          code: [
            'polyhedron(',
            '  points = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [10, 10, 22]],',
            '  faces  = [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [3, 2, 1, 0]]',
            ');',
          ].join('\n'),
          image: 'polyhedron',
          caption: 'A square pyramid: four corners on the ground, one apex, five faces.',
        },
      ],
      see: ['polygon', 'hull'],
      keywords: ['mesh', 'custom', 'faces', 'vertices', 'pyramid'],
    },
    {
      id: 'surface',
      name: 'surface()',
      signature: 'surface(file, center, invert, convexity)',
      plain:
        'Turns a grid of heights into a solid landscape — a heightmap. Bright means tall, dark ' +
        'means short, and you get a lumpy slab with that shape on top.',
      details: [
        'The file is either a `.dat` text grid — rows of numbers separated by spaces, blank ' +
          'lines and `#` comments ignored — or an image, where each pixel’s brightness is its ' +
          'height.',
        'One data point becomes one unit in X and Y, so a 100 x 100 grid makes a 100 x 100 ' +
          'object. Scale it with `scale()` if you want something else.',
        '`center = true` puts the middle of the grid on the origin instead of its corner. ' +
          '`invert = true` flips bright and dark, for an image whose heights read the wrong way.',
        'Image heightmaps work in the browser app, which has an image decoder. The command-line ' +
          '`bscad` reports a clear error for them rather than pulling an image codec into the ' +
          'engine; `.dat` files work everywhere.',
      ],
      params: [
        { name: 'file', description: 'Path to a `.dat` grid or an image.' },
        { name: 'center', description: '`true` centres the grid on the origin. Default `false`.' },
        { name: 'invert', description: '`true` swaps bright and dark. Default `false`.' },
        { name: 'convexity', description: 'Accepted for compatibility; has no effect.' },
      ],
      examples: [
        {
          code: 'surface("terrain.dat", center = true);',
          norender: true,
          caption: 'Needs a data file next to the model, so there is nothing to show here.',
        },
      ],
      see: ['import'],
      keywords: ['heightmap', 'terrain', 'landscape', 'dat', 'image'],
    },
    {
      id: 'import',
      name: 'import()',
      signature: 'import(file, convexity, layer, origin, scale)',
      plain:
        'Brings in a shape from another file — a model someone else made, or a drawing you ' +
        'exported from another program — and treats it like any other shape.',
      details: [
        '3D formats: `.stl`, `.obj`, `.off`. 2D formats: `.dxf`, `.svg`. What you get back is ' +
          '2D or 3D according to the file, and a 2D import can be extruded like any other 2D shape.',
        '`layer` picks a single named layer out of a DXF. `origin` shifts the 2D result before ' +
          'anything else happens, and `scale` multiplies it — both apply to 2D imports only.',
        'An imported mesh is used as-is. If it has holes, flipped faces or duplicate vertices, ' +
          'booleans against it can fail; repair it in a mesh tool first.',
        '`convexity` is accepted for compatibility and has no effect.',
      ],
      params: [
        { name: 'file', description: 'Path, relative to the model file.' },
        { name: 'layer', description: 'DXF layer name. 2D only.' },
        { name: 'origin', description: '`[x, y]` shift applied to a 2D import.' },
        { name: 'scale', description: 'Multiplier applied to a 2D import. Default `1`.' },
      ],
      examples: [
        {
          code: 'import("bracket.stl");',
          norender: true,
          caption: 'Needs the file alongside the model, so there is nothing to show here.',
        },
      ],
      see: ['surface', 'linear_extrude'],
      keywords: ['stl', 'obj', 'off', 'dxf', 'svg', 'open', 'load'],
    },
  ],
};

export const FLAT_SHAPES: ReferenceGroup = {
  id: 'flat-shapes',
  title: '2D shapes',
  blurb:
    'Flat outlines with no thickness. On their own they export as SVG or DXF; extrude them and ' +
    'they become solids.',
  entries: [
    {
      id: 'square',
      name: 'square()',
      signature: 'square(size, center)',
      plain:
        'A flat rectangle, lying on the ground. One number gives a square; two give a rectangle.',
      details: [
        '`size` is a number or `[x, y]`, and defaults to `1`. `center = true` puts the origin in ' +
          'the middle instead of at the bottom-left corner.',
        'A 2D shape has no thickness at all. You cannot mix it with 3D shapes in the same ' +
          'boolean — `union()` of a square and a cube is an error, not a shape.',
      ],
      params: [
        { name: 'size', description: 'Number, or `[x, y]`. Default `1`.' },
        { name: 'center', description: '`true` centres it on the origin. Default `false`.' },
      ],
      examples: [
        { code: 'square([40, 25]);', image: 'square', caption: 'A 40 x 25 rectangle.' },
        {
          code: 'linear_extrude(height = 12) square([40, 25]);',
          image: 'square-extruded',
          caption: 'The same rectangle, extruded into a solid.',
        },
      ],
      see: ['rounded_square', 'circle', 'linear_extrude'],
      keywords: ['rectangle', '2d', 'flat'],
    },
    {
      id: 'circle',
      name: 'circle()',
      signature: 'circle(r | d)',
      plain: 'A flat disc, centred on the origin. Set the size with `r` (radius) or `d` (diameter).',
      details: [
        'Like a sphere, it is really a many-sided polygon, and `$fn`, `$fa` and `$fs` decide how ' +
          'many sides.',
        '`circle($fn = 3)` is a triangle, `circle($fn = 6)` a hexagon. That is often the tidiest ' +
          'way to draw a regular polygon — though `regular_polygon()` lets you give the side ' +
          'length instead of working back from a radius.',
        '`d` wins if both are given. `r` defaults to `1`.',
      ],
      params: [
        { name: 'r', description: 'Radius. Default `1`.' },
        { name: 'd', description: 'Diameter. Overrides `r`.' },
      ],
      examples: [
        { code: 'circle(20);', image: 'circle', caption: 'A disc of radius 20.' },
        {
          code: 'circle(20, $fn = 5);',
          image: 'circle-fn',
          caption: '`$fn = 5` makes the same call a pentagon.',
        },
      ],
      see: ['regular_polygon', 'square', 'fn'],
      keywords: ['disc', 'round', '2d', 'polygon'],
    },
    {
      id: 'polygon',
      name: 'polygon()',
      signature: 'polygon(points, paths, convexity)',
      plain:
        'A flat shape you draw by listing its corners in order, as if joining dots. The last ' +
        'corner joins back to the first on its own.',
      details: [
        '`points` is a list of `[x, y]` corners.',
        'Without `paths`, all the points form one outline. With `paths`, each entry is a list of ' +
          'indices into `points` describing one contour — the first is the outside and the rest ' +
          'are holes.',
        'Contours may not cross themselves or each other. A self-intersecting outline has no ' +
          'well-defined inside, and the result will not be what you drew.',
        '`convexity` is accepted for compatibility and has no effect.',
      ],
      params: [
        { name: 'points', description: 'List of `[x, y]` corners.' },
        { name: 'paths', description: 'Lists of indices: first the outline, then the holes.' },
        { name: 'convexity', description: 'Accepted for compatibility; has no effect.' },
      ],
      examples: [
        {
          code: 'polygon([[0, 0], [40, 0], [40, 15], [20, 30], [0, 15]]);',
          image: 'polygon',
          caption: 'Five corners, joined in the order they are listed.',
        },
        {
          code: [
            'polygon(',
            '  points = [[0, 0], [40, 0], [40, 40], [0, 40],',
            '            [10, 10], [30, 10], [30, 30], [10, 30]],',
            '  paths  = [[0, 1, 2, 3], [4, 5, 6, 7]]',
            ');',
          ].join('\n'),
          image: 'polygon-hole',
          caption: 'The second path becomes a hole in the first.',
        },
      ],
      see: ['polyhedron', 'circle'],
      keywords: ['shape', 'outline', 'points', '2d', 'hole'],
    },
    {
      id: 'text',
      name: 'text()',
      signature: 'text(text, size, font, halign, valign, spacing, direction, language, script)',
      plain:
        'Writes words as a flat shape you can extrude, cut out, or export. It is real geometry, ' +
        'not a label stuck on top.',
      details: [
        '`size` is the font size in the same units as everything else — roughly the height of a ' +
          'capital letter, not of the whole line. It defaults to `10`.',
        '`font` is `"Family"`, or `"Family:style=Style"` for anything other than Regular. The ' +
          'app’s **Fonts** dialog previews every face in its own typeface and shows the exact ' +
          'string to use, so the spelling never has to be guessed.',
        '`halign` is `"left"` (default), `"center"` or `"right"`. `valign` is `"baseline"` ' +
          '(default), `"top"`, `"center"` or `"bottom"`.',
        '**Alignment is measured against the font, not against the letters you typed.** ' +
          '`valign` uses the font’s ascender and descender band, so `text("Ag")` and ' +
          '`text("xx")` get the same offset and a line does not jump when you type a letter with ' +
          'a tail. One consequence: centred text with no descender sits very slightly above the ' +
          'visual middle of its own ink, and that is correct.',
        '`spacing` multiplies the gap between letters — `1` is the font’s own spacing, `1.2` ' +
          'opens it up. `direction` is `"ltr"`, `"rtl"`, `"ttb"` or `"btt"`.',
        '`language` and `script` are accepted for compatibility.',
      ],
      params: [
        { name: 'text', description: 'The string to draw.' },
        { name: 'size', description: 'Font size. Default `10`.' },
        { name: 'font', description: '`"Family"` or `"Family:style=Bold"`.' },
        { name: 'halign', description: '`"left"` (default), `"center"`, `"right"`.' },
        { name: 'valign', description: '`"baseline"` (default), `"top"`, `"center"`, `"bottom"`.' },
        { name: 'spacing', description: 'Letter-spacing multiplier. Default `1`.' },
        { name: 'direction', description: '`"ltr"` (default), `"rtl"`, `"ttb"`, `"btt"`.' },
      ],
      examples: [
        {
          code: 'text("Hello", size = 20);',
          image: 'text',
          caption: 'Flat letter outlines, sitting on the baseline at the origin.',
        },
        {
          code: 'linear_extrude(height = 4) text("CAD", size = 24, halign = "center");',
          image: 'text-extruded',
          view: 'plan',
          caption: 'Extruded into a solid you could print.',
        },
      ],
      see: ['linear_extrude', 'offset'],
      keywords: ['label', 'letters', 'word', 'font', 'write', 'engrave'],
    },
  ],
};
