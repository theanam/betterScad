/**
 * The cheatsheet's language half: how a file is written, rather than what it
 * draws. Variables, definitions, control flow, modifiers and the `$` variables.
 */

import type { ReferenceGroup } from './types.js';

export const SYNTAX: ReferenceGroup = {
  id: 'syntax',
  title: 'Writing a model',
  blurb: 'The rules the file itself follows.',
  entries: [
    {
      id: 'variables',
      name: 'name = value;',
      plain:
        'Gives a number, a word or a list a name, so you can use it in several places and change ' +
        'it in one. Every statement ends in a semicolon.',
      details: [
        '**A variable is not a box you keep putting new things in.** Within one scope, the *last* ' +
          'assignment to a name wins everywhere in that scope, including on lines above it. ' +
          'Assignments are all evaluated before any shape is drawn.',
        'So `a = 1; echo(a); a = 2;` prints `2`. This surprises everyone once; it is how OpenSCAD ' +
          'has always worked, and BetterSCAD matches it exactly.',
        'Assignments still evaluate in source order, so a *read* on an earlier line sees the ' +
          'earlier value: `a = 1; b = a; a = 2;` leaves `b` at `1`.',
        'Values are numbers, booleans, strings, ranges, lists, functions, or `undef`. Lists are ' +
          'written `[1, 2, 3]` and indexed from zero: `v[0]`. A list can hold anything, including ' +
          'other lists.',
        'Comments are `//` to the end of the line, or `/* … */` across several.',
      ],
      examples: [
        {
          code: 'width = 40;\nheight = 12;\ncube([width, width, height]);',
          image: 'variables',
          caption: 'One value, named once, used twice.',
        },
        {
          code: 'a = 1;\necho(a);\na = 2;',
          output: 'ECHO: 2',
          caption: 'The last assignment wins for the whole scope, even above itself.',
        },
      ],
      see: ['module', 'function', 'let'],
      keywords: ['variable', 'assign', 'constant', 'name', 'value', 'semicolon'],
    },
    {
      id: 'operators',
      name: 'Operators',
      signature: '+  -  *  /  %  ^   <  <=  ==  !=  >=  >   &&  ||  !   ? :   v[i]   [a : b]',
      plain:
        'The arithmetic and comparison symbols. Most behave the way you would expect from a ' +
        'calculator; the ones worth knowing about are what `*` does to two lists, and the fact ' +
        'that `/` never rounds.',
      details: [
        '**Arithmetic** is `+ - * / %`. Division is always exact: `7 / 2` is `3.5`, never `3`. ' +
          '`%` is the remainder, and takes its sign from the left-hand side — `-7 % 3` is `-1`.',
        'That `%` is unrelated to the `%` that makes a shape a ghost. They never collide: one ' +
          'sits between two numbers, the other in front of a statement.',
        '`^` raises to a power, the same as `pow()`. It binds tighter than a leading minus, so ' +
          '`-2 ^ 2` is `-4`, and it groups to the right, so `2 ^ 3 ^ 2` is `512`.',
        '**Lists do arithmetic too**, and `*` means three different things depending on what is ' +
          'on each side. `+` and `-` work element by element on two lists of the same length. ' +
          '`[1, 2, 3] * 2` scales every element. `[1, 2] * [3, 4]` is the **dot product**, a ' +
          'single number — `11`, not a list. And a matrix times a vector is a matrix ' +
          'multiplication.',
        '**Comparison** is `< <= == != >= >`. `==` compares lists element by element, however ' +
          'deeply nested, so `[1, 2] == [1, 2]` is `true`. Strings compare in dictionary order.',
        '**Logic** is `&&` (and), `||` (or) and `!` (not). `&&` and `||` stop as soon as the ' +
          'answer is known, so the right-hand side of `is_list(x) && len(x) > 0` is safe.',
        '`condition ? a : b` picks between two **values**, and works anywhere a value does — ' +
          'including inside a function, where `if` cannot go.',
        '`v[i]` reads element `i` of a list, counting from `0`, or character `i` of a string. ' +
          'Past the end it is `undef` rather than an error, which is the single most common ' +
          'source of a mysterious `undef` further down.',
        '`[a : b]` is a **range**, and `[a : step : b]` steps by something other than 1. Both ' +
          'ends are included. A range is its own kind of value, not a list — `[0 : 3]` prints as ' +
          '`[0 : 1 : 3]`, and `is_list()` says `false`. Use `is_range()` to test for one.',
        'There is no `+` for joining lists or strings. `concat()` joins lists and `str()` joins ' +
          'text.',
      ],
      examples: [
        {
          code: 'echo(7 / 2, 7 % 3, -7 % 3, 2 ^ 10);',
          output: 'ECHO: 3.5, 1, -1, 1024',
        },
        {
          code: 'echo([1, 2, 3] + [10, 20, 30], [1, 2, 3] * 2, [1, 2] * [3, 4]);',
          output: 'ECHO: [11, 22, 33], [2, 4, 6], 11',
          caption:
            'The last one is the dot product: two lists multiplied together give one number.',
        },
        {
          code: 'v = [10, 20, 30];\necho(v[1], v[9], [1, 2] == [1, 2]);',
          output: 'ECHO: 20, undef, true',
        },
      ],
      see: ['variables', 'pow', 'if', 'is_range', 'concat', 'background'],
      keywords: [
        'operator', 'plus', 'minus', 'times', 'divide', 'modulo', 'remainder', 'percent',
        'power', 'dot product', 'index', 'range', 'ternary', 'comparison', 'boolean', 'and', 'or',
      ],
    },
    {
      id: 'module',
      name: 'module',
      signature: 'module name(params) { … }',
      plain:
        'Gives a piece of a model a name so you can use it again and again. Define it once, then ' +
        'write `name();` wherever you want one.',
      details: [
        'Parameters may have defaults: `module peg(d = 4, h = 10)`. Callers can pass arguments in ' +
          'order, or by name — `peg(h = 20)` — and named arguments may come in any order.',
        'A module’s body is its own scope. Variables it defines are invisible outside, and ' +
          'variables outside are visible inside only if they were in scope **where the module was ' +
          'written**, not where it was called. `$`-variables are the exception; see below.',
        'A module can take children: shapes written in braces after the call, reached with ' +
          '`children()`.',
        'Modules may call themselves. Recursion is capped at 200 levels deep, which reports a ' +
          'clear error rather than hanging the tab.',
      ],
      examples: [
        {
          code: [
            'module post(h = 20, d = 8) {',
            '  cylinder(h = h, d = d, $fn = 32);',
            '}',
            '',
            'post();',
            'translate([20, 0, 0]) post(h = 30);',
            'translate([40, 0, 0]) post(h = 12, d = 14);',
          ].join('\n'),
          image: 'module',
          caption: 'One definition, three posts, each a different size.',
        },
      ],
      see: ['function', 'children', 'variables'],
      keywords: ['define', 'reuse', 'part', 'component', 'subroutine'],
    },
    {
      id: 'function',
      name: 'function',
      signature: 'function name(params) = expression;',
      plain:
        'Names a calculation rather than a shape. You give it some numbers and it hands one value ' +
        'back.',
      details: [
        'The body is a **single expression** — there are no statements inside a function and ' +
          'nothing to return. Use `let()` to name intermediate values, and `a ? b : c` to choose ' +
          'between them.',
        'Functions may be recursive, under the same 200-level cap as modules.',
        'A function can also be a value: `f = function (x) x * 2;` creates one without a name, and ' +
          '`f(4)` calls it. That makes functions passable as arguments.',
        'A function cannot produce geometry, and a module cannot return a value. They are separate ' +
          'for that reason.',
      ],
      examples: [
        {
          code: 'function ring_r(teeth, pitch) = teeth * pitch / (2 * PI);\n\necho(ring_r(24, 3));',
          output: 'ECHO: 11.4592',
          caption: 'A named calculation, used the way you would use a number.',
        },
        {
          code: [
            'function stack(n) = [for (i = [0 : n - 1]) i * 6];',
            '',
            'for (z = stack(5)) translate([0, 0, z]) cube([20, 20, 4]);',
          ].join('\n'),
          image: 'function',
          caption: 'A function returning a list, driving a loop.',
        },
      ],
      see: ['module', 'let', 'list-comprehension'],
      keywords: ['calculate', 'return', 'expression', 'lambda', 'math'],
    },
    {
      id: 'children',
      name: 'children()',
      signature: 'children() | children(i) | children([a : b]) | children([i, j])',
      plain:
        'Inside a module, this stands for whatever shapes were written after the call. It lets ' +
        'you write a module that does something *to* a shape without knowing what the shape is.',
      details: [
        '`children()` with no argument instantiates all of them, in order.',
        '`children(i)` picks one, counting from `0`. `children([1 : 3])` takes a range, and ' +
          '`children([0, 2])` takes a specific list.',
        '`$children` is how many there are, which is what you loop over to handle any number.',
        'Children are instantiated where `children()` is written, so any transform wrapped around ' +
          'the call applies to them.',
      ],
      examples: [
        {
          code: [
            'module ring(n = 6, r = 26) {',
            '  for (i = [0 : n - 1]) rotate([0, 0, i * 360 / n]) translate([r, 0, 0]) children();',
            '}',
            '',
            'ring() cube(8, center = true);',
          ].join('\n'),
          image: 'children',
          caption: 'The module arranges the shape; the caller decides what the shape is.',
        },
      ],
      see: ['module', 'children-count'],
      keywords: ['children', 'wrapper', 'operator module', 'pass shapes'],
    },
    {
      id: 'include',
      name: 'include <…>',
      signature: 'include <path>',
      plain:
        'Pastes another file into this one, as if you had typed it here. Its variables and its ' +
        'shapes all come along.',
      details: [
        'The path is relative to the file doing the including. Angle brackets are part of the ' +
          'syntax, and there is no semicolon.',
        'Because the whole file is spliced in, any geometry at the top level of the included file ' +
          'is drawn. Use `use <…>` when you want only the definitions.',
        'Included files may include others. The chain is followed breadth-first and capped at 32 ' +
          'levels, and a cycle is detected rather than followed.',
        'In the app, files opened in other tabs resolve as includes, so a project can be split ' +
          'across tabs.',
      ],
      examples: [{ code: 'include <shared/hardware.scad>\n\nm3_bolt(len = 16);', norender: true }],
      see: ['use'],
      keywords: ['import file', 'library', 'require'],
    },
    {
      id: 'use',
      name: 'use <…>',
      signature: 'use <path>',
      plain:
        'Borrows the modules and functions from another file, without drawing anything that file ' +
        'draws by itself.',
      details: [
        'Same path rules as `include`, and no semicolon.',
        'Definitions come across; top-level variables and top-level geometry do not. That makes it ' +
          'the right choice for a library that also has test shapes in it.',
      ],
      examples: [{ code: 'use <shared/gears.scad>\n\ngear(teeth = 24);', norender: true }],
      see: ['include'],
      keywords: ['import', 'library', 'modules only'],
    },
  ],
};

export const FLOW: ReferenceGroup = {
  id: 'flow',
  title: 'Repeating and choosing',
  blurb: 'Draw something many times, or only sometimes.',
  entries: [
    {
      id: 'for',
      name: 'for',
      signature: 'for (i = [start : end]) … | for (i = [start : step : end]) … | for (i = list) …',
      plain:
        'Draws its shapes once for every value in a list or a range. The loop variable takes each ' +
        'value in turn, so each copy can be a bit different.',
      details: [
        '`[0 : 4]` counts 0, 1, 2, 3, 4 — **both ends included**, unlike most languages. ' +
          '`[0 : 2 : 10]` counts in twos. A negative step counts down.',
        '`for (v = [10, 25, 40])` walks a list instead of a range.',
        'Several variables can be given at once: `for (x = [0:2], y = [0:2])` runs every ' +
          'combination — nine times here, not three.',
        'Everything a `for` draws is unioned together. It is a loop over geometry, not a loop that ' +
          'changes variables: the loop variable exists only inside the body, and assigning to a ' +
          'variable in the body does not carry to the next pass.',
        'One range may not produce more than 1,000,000 values; beyond that it reports an error ' +
          'rather than hanging.',
        'BetterSCAD also accepts the C-style `for (i = 0; i < n; i = i + 1)` as a statement.',
      ],
      examples: [
        {
          code: 'for (i = [0 : 5]) translate([i * 14, 0, 0]) cube([10, 10, 4 + i * 4]);',
          image: 'for',
          caption: 'Six copies, each using `i` for both its position and its height.',
        },
        {
          code: 'for (x = [0 : 2], y = [0 : 2]) translate([x * 16, y * 16, 0]) cylinder(h = 10, r = 5, $fn = 24);',
          image: 'for-nested',
          caption: 'Two variables in one `for`: every combination, so nine pegs.',
        },
      ],
      see: ['c-style-for', 'intersection_for', 'list-comprehension'],
      keywords: ['loop', 'repeat', 'iterate', 'range', 'array', 'each'],
    },
    {
      id: 'intersection_for',
      name: 'intersection_for',
      signature: 'intersection_for (i = range) …',
      plain:
        'Like `for`, but instead of adding every copy together it keeps only the part they all ' +
        'share. Useful for carving a shape from many directions at once.',
      details: [
        'It exists because a plain `for` inside an `intersection()` would union its copies first, ' +
          'leaving the intersection with a single child and nothing to do.',
        'With no iterations at all the result is empty.',
      ],
      examples: [
        {
          code: 'intersection_for (a = [0 : 45 : 135])\n  rotate([0, 0, a]) cube([46, 18, 12], center = true);',
          image: 'intersection-for',
          caption: 'Four bars at different angles; only the core common to all of them survives.',
        },
      ],
      see: ['intersection', 'for'],
      keywords: ['loop', 'intersect', 'carve', 'common'],
    },
    {
      id: 'if',
      name: 'if / else',
      signature: 'if (condition) … else …',
      plain: 'Draws one thing when something is true, and optionally something else when it is not.',
      details: [
        'Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`. Combine them with `&&` (and), `||` (or) ' +
          'and `!` (not).',
        '`else if` chains as you would expect.',
        'For choosing between two *values* rather than two shapes, use the conditional expression ' +
          '`condition ? a : b`, which works anywhere a value does — including inside a function.',
        '`undef`, `false`, `0`, `""` and `[]` all count as false; everything else counts as true.',
      ],
      examples: [
        {
          code: [
            'rounded = true;',
            '',
            'if (rounded) cylinder(h = 12, r = 15, $fn = 48);',
            'else cube([30, 30, 12], center = true);',
          ].join('\n'),
          image: 'if',
          caption: 'One flag at the top of the file chooses which shape gets drawn.',
        },
      ],
      see: ['variables', 'let'],
      keywords: ['condition', 'branch', 'else', 'ternary', 'boolean'],
    },
    {
      id: 'let',
      name: 'let()',
      signature: 'let (name = value, …) expression-or-statement',
      plain:
        'Names a value for one expression or one statement only. Handy inside a function, where ' +
        'you cannot write ordinary assignments.',
      details: [
        'Bindings are evaluated in order and each one can see the ones before it.',
        'The names disappear at the end of the `let`. A name that already exists is shadowed, not ' +
          'overwritten.',
        'It works both as a statement wrapping geometry and as an expression inside a formula.',
      ],
      examples: [
        {
          code: 'function hyp(a, b) = let (sq = a * a + b * b) sqrt(sq);\n\necho(hyp(3, 4));',
          output: 'ECHO: 5',
          caption: 'A named intermediate value inside a function body.',
        },
      ],
      see: ['function', 'variables'],
      keywords: ['bind', 'local', 'temporary', 'scope'],
    },
    {
      id: 'list-comprehension',
      name: 'List comprehensions',
      signature: '[ for (i = range) expr ]',
      plain:
        'Builds a list by running a small rule over a range — "for every `i` from 0 to 9, give me ' +
        '`i` squared" — instead of typing the list out.',
      details: [
        '`[for (i = [0 : 4]) i * i]` is `[0, 1, 4, 9, 16]`.',
        '`if` filters: `[for (i = [0 : 9]) if (i % 2 == 0) i]` keeps the even ones. An `else` may ' +
          'follow it to substitute a value instead of dropping the entry.',
        '`each` splices a nested list in flat instead of nesting it: `[for (p = pairs) each p]`.',
        '`let` names intermediate values inside the comprehension.',
        'The C-style form `[for (i = 0; i < n; i = i + 1) …]` is allowed here in stock OpenSCAD, ' +
          'and BetterSCAD also allows it as a statement.',
      ],
      examples: [
        {
          code: 'points = [for (a = [0 : 30 : 330]) [20 * cos(a), 20 * sin(a)]];\n\npolygon(points);',
          image: 'list-comprehension',
          caption: 'Twelve points calculated round a circle, then joined into a polygon.',
        },
        {
          code: 'echo([for (i = [0 : 9]) if (i % 2 == 0) i]);',
          output: 'ECHO: [0, 2, 4, 6, 8]',
          caption: '`if` inside a comprehension drops the entries that do not match.',
        },
      ],
      see: ['for', 'function', 'c-style-for'],
      keywords: ['list', 'array', 'generate', 'map', 'filter', 'each'],
    },
  ],
};

export const MODIFIERS: ReferenceGroup = {
  id: 'modifiers',
  title: 'Modifier characters',
  blurb:
    'One character in front of a shape, for finding your way around a model while you are ' +
    'working on it. None of them change the geometry.',
  entries: [
    {
      id: 'disable',
      name: '* (disable)',
      signature: '* shape;',
      plain:
        'Switches a shape off. It stays in the file but is not drawn — like commenting it out, ' +
        'except it still has to be valid code.',
      details: [
        'Applies to the whole statement after it, children included.',
        'It affects exports as well as the preview: a disabled shape is not there at all.',
      ],
      examples: [
        {
          code: 'cube([30, 30, 8], center = true);\n*translate([0, 0, 12]) sphere(10);',
          image: 'disable',
          caption: 'The sphere is written in the file and is not drawn.',
        },
      ],
      see: ['root', 'highlight', 'background'],
      keywords: ['disable', 'off', 'comment out', 'hide', 'asterisk', 'star'],
    },
    {
      id: 'root',
      name: '! (show only this)',
      signature: '! shape;',
      plain:
        'Shows only this shape and throws everything else away, so you can look at one part of a ' +
        'big model on its own.',
      details: [
        'The marked subtree becomes the whole model. Its ancestors still apply their transforms ' +
          'to it, but their *other* children are discarded.',
        'Only one `!` takes effect; if there are several, the first one found wins.',
        'It affects exports too — a file with a stray `!` exports only that part, which is worth ' +
          'remembering before wondering where the rest of the model went.',
      ],
      examples: [
        {
          code: 'cube([40, 40, 8], center = true);\n!translate([0, 0, 14]) sphere(10, $fn = 48);',
          image: 'root',
          caption: 'Only the marked sphere is rendered; the plate is dropped.',
        },
      ],
      see: ['disable', 'highlight'],
      keywords: ['root', 'only', 'isolate', 'focus', 'exclamation'],
    },
    {
      id: 'highlight',
      name: '# (highlight)',
      signature: '# shape;',
      plain:
        'Draws a shape in a bright colour so you can pick it out of everything around it, while ' +
        'leaving it exactly where it was and exactly what it was.',
      details: [
        'It is a preview treatment only: the shape still contributes whatever it was ' +
          'contributing, and exports are untouched.',
        'BetterSCAD draws it in the cool cyan reserved for exactly this, so a highlighted shape ' +
          'can never be mistaken for model material — the model is amber.',
        '**A `#` on a cutting shape inside a `difference()` is not drawn.** Stock OpenSCAD shows ' +
          'the cutter as a transparent highlighted volume, which is the single most common use of ' +
          'the modifier; here the boolean consumes the cutter before the preview sees it, so ' +
          'there is nothing left to colour. Until that gap is closed, use `%` on a copy of the ' +
          'cutter to see where a hole is going.',
      ],
      examples: [
        {
          code: 'cube([40, 40, 10], center = true);\n#translate([0, 0, 13]) sphere(8, $fn = 48);',
          image: 'highlight',
          caption: 'The sphere is still part of the model; the cyan only says "this one".',
        },
        {
          code: [
            'difference() {',
            '  cube([40, 40, 12], center = true);',
            '  cylinder(h = 30, r = 8, center = true, $fn = 40);',
            '}',
            '%cylinder(h = 30, r = 8, center = true, $fn = 40);',
          ].join('\n'),
          image: 'highlight-cutter',
          caption: 'The workaround: a `%` ghost of the cutter, alongside the real one.',
        },
      ],
      see: ['background', 'difference'],
      keywords: ['highlight', 'debug', 'show', 'hash', 'pound', 'cutter'],
    },
    {
      id: 'background',
      name: '% (ghost)',
      signature: '% shape;',
      plain:
        'Draws a shape as a faint ghost, for reference only. It does not join anything, cut ' +
        'anything or get exported — it is just there to look at.',
      details: [
        'Use it for the thing your part has to fit: the board, the enclosure, the bolt.',
        'It is deliberately kept out of every boolean, so a `difference()` cannot cut with it ' +
          'even when it is written as a child of one.',
        'Every "before" ghost in this reference is a `%` shape.',
      ],
      examples: [
        {
          code: '%cylinder(h = 40, r = 16, $fn = 48);\ncube([20, 20, 40]);',
          image: 'background',
          caption: 'The cylinder is reference only: nothing is unioned, nothing is exported.',
        },
      ],
      see: ['highlight', 'color'],
      keywords: ['background', 'ghost', 'reference', 'transparent', 'percent'],
    },
  ],
};

export const SPECIAL_VARIABLES: ReferenceGroup = {
  id: 'special-variables',
  title: 'Special variables',
  blurb:
    'Variables whose names start with `$`. They pass down into everything you call, so setting ' +
    'one affects the whole subtree beneath it.',
  entries: [
    {
      id: 'fn',
      name: '$fn',
      plain:
        'How many flat sides to use when drawing something round. Low numbers are fast and ' +
        'chunky; high numbers are smooth and slow. `0` means "work it out from `$fa` and `$fs`".',
      details: [
        'When `$fn` is greater than `0` it wins outright and `$fa`/`$fs` are ignored.',
        'It can be set for the whole file (`$fn = 64;` at the top), for one subtree ' +
          '(`cylinder(h = 5, r = 3, $fn = 6)`), or anywhere in between.',
        'A common pattern ties it to the preview flag, so editing stays fast and exports stay ' +
          'smooth: `$fn = $preview ? 24 : 96;`.',
        'It is also how you draw a deliberate polygon: `$fn = 6` on a cylinder is a hex rod.',
        'Default `0`.',
      ],
      examples: [
        {
          code: '$fn = 6;\ncylinder(h = 12, r = 14);',
          image: 'fn',
          caption: 'Six sides, on purpose.',
        },
      ],
      see: ['fa', 'fs', 'preview', 'circle'],
      keywords: ['resolution', 'segments', 'smooth', 'facets', 'quality'],
    },
    {
      id: 'fa',
      name: '$fa',
      plain:
        'The biggest angle one flat side of a curve is allowed to cover. Smaller means more ' +
        'sides and a smoother curve.',
      details: [
        'In degrees. Default `12`, which is 30 sides for a full circle.',
        'Ignored when `$fn` is set.',
        'Used together with `$fs`: the number of sides is whichever of the two rules asks for ' +
          'more, with a floor of 5.',
      ],
      see: ['fn', 'fs'],
      keywords: ['resolution', 'angle', 'smooth'],
    },
    {
      id: 'fs',
      name: '$fs',
      plain:
        'The shortest a flat side is allowed to be. It keeps small circles from being wastefully ' +
        'detailed and big ones from being chunky.',
      details: [
        'In model units. Default `2`.',
        'Ignored when `$fn` is set.',
        'Because it is a length, a large circle gets more sides than a small one automatically — ' +
          'which is usually what you want and is why leaving `$fn` alone is often the better ' +
          'default.',
      ],
      see: ['fn', 'fa'],
      keywords: ['resolution', 'size', 'smooth', 'fragment'],
    },
    {
      id: 't',
      name: '$t',
      plain:
        'The animation clock: a number that runs from 0 to 1 and back to 0 as the animation ' +
        'plays. Use it in your model and the model moves.',
      details: [
        'It is `0` for an ordinary render. The app’s animation bar plays it; `bscad --frames n` ' +
          'renders a sequence with it.',
        'Anything can depend on it: `rotate([0, 0, $t * 360])` spins a part through one full turn ' +
          'over the animation.',
      ],
      examples: [
        {
          code: 'rotate([0, 0, $t * 360]) translate([20, 0, 0]) cube(8, center = true);',
          image: 't',
          caption: 'At `$t = 0` — the first frame of a full revolution.',
        },
      ],
      see: ['preview'],
      keywords: ['animation', 'time', 'frame', 'movement'],
    },
    {
      id: 'preview',
      name: '$preview',
      plain:
        '`true` while you are editing (F5), `false` for the final render (F6) and for every ' +
        'export. Use it to draw a quick version while you work and the good one when it counts.',
      details: [
        'In stock OpenSCAD, F5 and F6 use two different geometry engines, and `$preview` tells ' +
          'you which. **BetterSCAD produces exact geometry either way** — so the two differ only ' +
          'for models that read `$preview` and deliberately simplify themselves.',
        'The usual use is resolution: `$fn = $preview ? 12 : 96;`.',
      ],
      examples: [
        {
          code: '$fn = $preview ? 12 : 96;\nsphere(10);',
          image: 'preview',
          caption:
            'Coarse while editing, smooth on export. Every screenshot in this reference is a ' +
            'final render, so this is the 96-sided branch.',
        },
      ],
      see: ['fn', 't'],
      keywords: ['f5', 'f6', 'render', 'draft', 'quality'],
    },
    {
      id: 'children-count',
      name: '$children',
      plain: 'Inside a module, how many shapes were handed to it.',
      details: [
        'Used with `children(i)` to walk them one at a time — `for (i = [0 : $children - 1])`.',
        'It is `0` in a module called with no children, which is the tidy way to give a module a ' +
          'different default when nothing was passed.',
      ],
      see: ['children', 'module'],
      keywords: ['count', 'number of children'],
    },
    {
      id: 'vpr',
      name: '$vpr, $vpt, $vpd, $vpf',
      plain:
        'Where the camera is right now: its rotation, what it is looking at, how far away it is, ' +
        'and how wide its lens is. A model can read these and react to the view.',
      details: [
        '`$vpr` is `[x, y, z]` rotation in degrees, `$vpt` the point being looked at, `$vpd` the ' +
          'distance, `$vpf` the field of view.',
        'BetterSCAD’s orbit camera maps onto OpenSCAD’s convention exactly: `$vpr` is ' +
          '`[polar, 0, azimuth + 90]`, so `[90, 0, 0]` is the front view and `[0, 0, 0]` is the top.',
        'Reading them makes a model depend on the view, which means it renders differently in the ' +
          'app and on the command line. Useful for labels that always face you; a trap for ' +
          'anything you intend to export.',
      ],
      see: ['t'],
      keywords: ['camera', 'viewport', 'view', 'rotation', 'distance'],
    },
  ],
};

export const OTHER: ReferenceGroup = {
  id: 'other',
  title: 'Output and checks',
  blurb: 'Printing values, stopping on mistakes, and the two leftovers.',
  entries: [
    {
      id: 'echo',
      name: 'echo()',
      signature: 'echo(…)',
      plain:
        'Prints values to the Console panel. It is how you find out what a number actually is when ' +
        'a shape comes out wrong.',
      details: [
        'Takes any number of values, of any type, and prints them separated by commas.',
        'Named arguments print as `name = value`, which is the quickest way to label what you are ' +
          'looking at.',
        'It draws nothing, and can be used as an expression: `echo("here") cube(10);` prints and ' +
          'then draws.',
      ],
      examples: [
        {
          code: 'size = 24;\necho(size, half = size / 2);',
          output: 'ECHO: 24, half = 12',
        },
      ],
      see: ['assert'],
      keywords: ['print', 'log', 'debug', 'console', 'output'],
    },
    {
      id: 'assert',
      name: 'assert()',
      signature: 'assert(condition, message)',
      plain:
        'Checks that something is true and stops with an error if it is not. It turns a silently ' +
        'wrong model into a clear complaint.',
      details: [
        'The message is optional but worth writing: it is what you will read in six months.',
        'It works as a statement and as an expression, so it can guard a function: ' +
          '`function f(x) = assert(x > 0, "x must be positive") sqrt(x);`.',
        'Use it on a module’s arguments to catch impossible combinations — a wall thickness ' +
          'larger than the part, a count of zero — before they become confusing geometry.',
      ],
      examples: [
        {
          code: [
            'wall  = 3;',
            'bore  = 10;',
            'outer = 17;',
            '',
            'assert(outer - bore >= 2 * wall, "wall too thin for this bore");',
            '',
            'difference() {',
            '  cylinder(h = 20, d = outer, $fn = 48);',
            '  translate([0, 0, -1]) cylinder(h = 22, d = bore, $fn = 48);',
            '}',
          ].join('\n'),
          image: 'assert',
          caption:
            'The check passes, so the part is drawn. Set `bore` to 13 and nothing is drawn at ' +
            'all — you get that message instead.',
        },
      ],
      see: ['echo'],
      keywords: ['check', 'validate', 'error', 'guard', 'test'],
    },
    {
      id: 'render',
      name: 'render()',
      signature: 'render(convexity)',
      plain:
        'In OpenSCAD, forces a piece of the model to be worked out properly instead of ' +
        'approximated. BetterSCAD already does that everywhere, so it changes nothing here.',
      details: [
        'Accepted so that existing files keep working, and it does pass its children through ' +
          'unchanged.',
        'OpenSCAD needs it because its fast preview uses a different, approximate engine. ' +
          'BetterSCAD computes exact geometry in both preview and render, so there is nothing for ' +
          '`render()` to force.',
        '`convexity` is accepted and ignored for the same reason.',
      ],
      examples: [{ code: 'render() difference() {\n  cube(20, center = true);\n  sphere(12);\n}', norender: true }],
      see: ['preview'],
      keywords: ['force', 'cache', 'convexity'],
    },
    {
      id: 'not-implemented',
      name: 'Not implemented',
      plain:
        'Two functions of OpenSCAD’s are not here. Calling either warns and gives you `undef` ' +
        'rather than failing silently.',
      details: [
        '`parent_module(n)` — the name of the module `n` levels up the call stack. It exists so ' +
          'that a module can behave differently depending on who called it, which is a thing ' +
          'worth being able to do and not a thing worth relying on.',
        '`textmetrics(…)` — the measured size of a string. It is in OpenSCAD’s development ' +
          'snapshots, not in the 2021.01 release BetterSCAD implements.',
        'Third-party libraries (BOSL2, MCAD) are also untested and unsupported. They lean on deep ' +
          'recursion and large list comprehensions; they may well work, and they are not ' +
          'promised to.',
        '`surface()` with an **image** heightmap works in the browser, which has an image ' +
          'decoder, but not in the command-line `bscad`, which reports a clear error rather than ' +
          'pulling an image codec into the engine. `.dat` grids work in both.',
      ],
      examples: [
        {
          code: 'echo(parent_module(0));',
          output: 'ECHO: undef',
          caption: 'Also reports `parent_module() is not a known function` as a warning.',
        },
      ],
      see: ['surface', 'version'],
      keywords: ['parent_module', 'textmetrics', 'missing', 'unsupported', 'bosl2', 'mcad'],
    },
    {
      id: 'assign',
      name: 'assign()',
      signature: 'assign(name = value) …',
      plain:
        'The old way of naming a value for one statement. `let()` replaced it years ago; it is ' +
        'here so that old files still open.',
      details: [
        'Behaves like `let()`. Prefer `let()` in anything new.',
        'Unlike `let()`, it cannot be used as an expression.',
      ],
      examples: [{ code: 'assign(r = 12) cylinder(h = 20, r = r);', norender: true }],
      see: ['let'],
      keywords: ['deprecated', 'legacy', 'old'],
    },
  ],
};
