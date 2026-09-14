/**
 * The cheatsheet's function library.
 *
 * These return values rather than geometry, so their examples carry the console
 * output they produce instead of a screenshot. `npm run reference` runs every
 * one of them and fails if the printed output here is not what the engine
 * actually prints, which is what keeps this file honest.
 */

import type { ReferenceGroup } from './types.js';

export const MATH: ReferenceGroup = {
  id: 'math',
  title: 'Maths',
  blurb:
    'All the usual arithmetic. **Angles are in degrees everywhere**, not radians — which is the ' +
    'one thing to remember if you have used these functions in another language.',
  entries: [
    {
      id: 'abs',
      name: 'abs()',
      signature: 'abs(x)',
      plain: 'Drops the minus sign. `abs(-5)` and `abs(5)` are both `5`.',
      examples: [{ code: 'echo(abs(-5), abs(5));', output: 'ECHO: 5, 5' }],
      keywords: ['absolute', 'positive', 'magnitude'],
    },
    {
      id: 'sign',
      name: 'sign()',
      signature: 'sign(x)',
      plain: 'Tells you which way a number points: `-1` for negative, `1` for positive, `0` for zero.',
      examples: [{ code: 'echo(sign(-8), sign(0), sign(3.2));', output: 'ECHO: -1, 0, 1' }],
      keywords: ['positive', 'negative', 'direction'],
    },
    {
      id: 'sin',
      name: 'sin(), cos(), tan()',
      signature: 'sin(degrees) | cos(degrees) | tan(degrees)',
      plain:
        'The trigonometry functions — the tools for working out positions around a circle. ' +
        '`cos` gives the across, `sin` gives the up.',
      details: [
        '**Angles are in degrees**, not radians. `sin(90)` is `1`.',
        'BetterSCAD snaps the exact cases to exact answers: `sin(180)` is `0`, not `1.2e-16`. ' +
          'Without that, float noise spreads into every polygon built from them and turns up ' +
          'later as non-planar faces and failed booleans.',
        '`tan(90)` has no finite value and returns infinity.',
      ],
      examples: [
        { code: 'echo(sin(30), cos(60), sin(180));', output: 'ECHO: 0.5, 0.5, 0' },
        {
          code: 'for (a = [0 : 30 : 330])\n  translate([26 * cos(a), 26 * sin(a), 0]) cylinder(h = 6, r = 4, $fn = 24);',
          image: 'sin',
          caption: '`cos` gives each post its x, `sin` gives it its y, and twelve of them make a circle.',
        },
      ],
      see: ['asin'],
      keywords: ['sine', 'cosine', 'tangent', 'trig', 'circle', 'angle', 'degrees'],
    },
    {
      id: 'asin',
      name: 'asin(), acos(), atan(), atan2()',
      signature: 'asin(x) | acos(x) | atan(x) | atan2(y, x)',
      plain:
        'The other direction: given a ratio, these give you back the angle. `atan2` is the one ' +
        'to use when you have an x and a y and want the angle between them.',
      details: [
        'All results are in **degrees**.',
        '`asin` and `acos` need an input between `-1` and `1`; outside that there is no angle and ' +
          'the result is `nan`.',
        '`atan(y / x)` cannot tell which quadrant you are in — it only ever answers between -90 ' +
          'and 90. `atan2(y, x)` takes the two separately and covers the full circle, -180 to ' +
          '180. Prefer it.',
      ],
      examples: [
        {
          code: 'echo(asin(0.5), acos(0.5), atan(1), atan2(1, -1));',
          output: 'ECHO: 30, 60, 45, 135',
        },
      ],
      see: ['sin'],
      keywords: ['arc sine', 'arctan', 'inverse', 'angle', 'quadrant'],
    },
    {
      id: 'floor',
      name: 'floor(), ceil(), round()',
      signature: 'floor(x) | ceil(x) | round(x)',
      plain:
        'Turn a number with a fraction into a whole number: `floor` always goes down, `ceil` ' +
        'always goes up, `round` goes to whichever is nearer.',
      details: [
        '`floor(-2.5)` is `-3` and `ceil(-2.5)` is `-2`: down and up mean along the number line, ' +
          'not towards or away from zero.',
        '`round()` rounds a half **away from zero**: `round(2.5)` is `3` and `round(-2.5)` is ' +
          '`-3`. This matches OpenSCAD, and differs from JavaScript’s `Math.round`, which would ' +
          'give `-2`.',
      ],
      examples: [
        {
          code: 'echo(floor(2.7), ceil(2.1), round(2.5), round(-2.5));',
          output: 'ECHO: 2, 3, 3, -3',
        },
      ],
      keywords: ['integer', 'whole', 'truncate', 'nearest'],
    },
    {
      id: 'pow',
      name: 'pow()',
      signature: 'pow(base, exponent)',
      plain: 'Multiplies a number by itself a number of times. `pow(2, 10)` is 2 times itself ten times.',
      details: [
        'The operator `^` does the same thing: `2 ^ 10`.',
        '`^` binds **tighter than a leading minus**, so `-2 ^ 2` is `-4`, not `4`.',
        'It is right-associative: `2 ^ 3 ^ 2` is `2 ^ (3 ^ 2)`, which is `512`.',
        'A fractional exponent gives a root: `pow(8, 1/3)` is `2`.',
      ],
      examples: [{ code: 'echo(pow(2, 10), 2 ^ 3 ^ 2, -2 ^ 2);', output: 'ECHO: 1024, 512, -4' }],
      see: ['sqrt'],
      keywords: ['power', 'exponent', 'squared', 'cubed', 'caret'],
    },
    {
      id: 'sqrt',
      name: 'sqrt()',
      signature: 'sqrt(x)',
      plain:
        'The square root: the number that gives you `x` when multiplied by itself. `sqrt(9)` is `3`.',
      details: ['A negative input has no real square root and gives `nan`.'],
      examples: [{ code: 'echo(sqrt(9), sqrt(2));', output: 'ECHO: 3, 1.41421' }],
      see: ['pow', 'norm'],
      keywords: ['root', 'square root'],
    },
    {
      id: 'ln',
      name: 'ln(), log(), exp()',
      signature: 'ln(x) | log(x) | exp(x)',
      plain:
        'Logarithms and their opposite. `log` answers "ten to the what?", `ln` answers the same ' +
        'for the number e, and `exp` goes back the other way.',
      details: [
        '`log` is base 10; `ln` is base e (about 2.71828).',
        '`exp(x)` is e to the power x, so `exp(ln(x))` is `x`.',
        'A zero or negative input to `ln` or `log` has no answer: `ln(0)` is `-inf` and `ln(-1)` ' +
          'is `nan`.',
      ],
      examples: [{ code: 'echo(ln(1), log(1000), exp(0));', output: 'ECHO: 0, 3, 1' }],
      keywords: ['logarithm', 'natural log', 'exponential', 'e'],
    },
    {
      id: 'min',
      name: 'min(), max()',
      signature: 'min(a, b, …) | min(vector)',
      plain: 'The smallest, or the largest, of the numbers you give them.',
      details: [
        'Both forms work: several arguments, or one list.',
        'Handy for clamping: `min(max(x, 0), 10)` keeps `x` between 0 and 10.',
      ],
      examples: [{ code: 'echo(min(4, 2, 9), max([4, 2, 9]));', output: 'ECHO: 2, 9' }],
      keywords: ['smallest', 'largest', 'clamp', 'limit'],
    },
    {
      id: 'norm',
      name: 'norm()',
      signature: 'norm(v)',
      plain:
        'How long a vector is — the straight-line distance from the origin to the point it names.',
      details: [
        'Works in any number of dimensions: the square root of the sum of the squares.',
        'For the distance between two points, subtract them first: `norm(b - a)`.',
      ],
      examples: [{ code: 'echo(norm([3, 4]), norm([1, 2, 2]));', output: 'ECHO: 5, 3' }],
      see: ['cross', 'sqrt'],
      keywords: ['length', 'distance', 'magnitude', 'vector'],
    },
    {
      id: 'cross',
      name: 'cross()',
      signature: 'cross(a, b)',
      plain:
        'Given two directions in 3D, gives a third one at right angles to both. It is how you ' +
        'find which way a surface faces.',
      details: [
        'On two 3D vectors it returns a 3D vector. On two 2D vectors it returns the single number ' +
          'that would be the z component.',
        'The length of the result is the area of the parallelogram the two inputs make, so it is ' +
          '`0` when they point the same way.',
        'Order matters: `cross(a, b)` is the negative of `cross(b, a)`.',
      ],
      examples: [{ code: 'echo(cross([1, 0, 0], [0, 1, 0]));', output: 'ECHO: [0, 0, 1]' }],
      see: ['norm'],
      keywords: ['perpendicular', 'normal', 'vector', 'product'],
    },
    {
      id: 'rands',
      name: 'rands()',
      signature: 'rands(min_value, max_value, value_count, seed)',
      plain:
        'Gives you a list of random numbers between two limits. Pass a `seed` and you get the ' +
        'same "random" numbers every time, which is what you want in a model you have to rebuild.',
      details: [
        'Always returns a **list**, even for one value: `rands(0, 1, 1)[0]`.',
        'Without a seed, every render is different — including the render your export used, which ' +
          'is rarely what you want in a part.',
        'Seeded sequences use mt19937, the same core generator OpenSCAD seeds, so results are ' +
          'reproducible and principled. Exact agreement with OpenSCAD’s own distribution mapping ' +
          'is not claimed.',
      ],
      examples: [
        {
          code: 'for (v = rands(0, 30, 6, seed = 42)) translate([v, 0, 0]) cube([2, 8, 8]);',
          image: 'rands',
          caption: 'Six seeded positions — the same six on every render.',
        },
      ],
      keywords: ['random', 'noise', 'seed', 'scatter'],
    },
    {
      id: 'pi',
      name: 'PI',
      plain: 'The number 3.14159…, the one that turns up whenever circles do.',
      details: [
        '**The only built-in constant.** There is no `E`, and no `inf` or `nan` names.',
        'Those values do exist — you produce them arithmetically: `1/0` is `inf`, `-1/0` is ' +
          '`-inf`, `0/0` is `nan`.',
        '`PI` sits below every user scope, so a file may shadow it by assigning to it. Adding ' +
          '`E`, `inf` and `nan` as names would be a language extension, and every BetterSCAD ' +
          'extension has to have a way back to plain `.scad` — these have none, so they are not ' +
          'added.',
      ],
      examples: [{ code: 'echo(PI, 1/0, 0/0);', output: 'ECHO: 3.14159, inf, nan' }],
      keywords: ['pi', 'constant', 'circle', 'infinity', 'nan'],
    },
  ],
};

export const LISTS_AND_STRINGS: ReferenceGroup = {
  id: 'lists-and-strings',
  title: 'Lists and text',
  blurb: 'Measuring, joining and searching lists and strings.',
  entries: [
    {
      id: 'len',
      name: 'len()',
      signature: 'len(list | string)',
      plain: 'How many things are in a list, or how many characters are in a string.',
      details: [
        'On a number or a boolean it is `undef`, which is a useful way to ask "is this a list?" ' +
          'in older code — though `is_list()` says it better.',
        'Nested lists count only the outer level: `len([[1, 2], [3, 4]])` is `2`.',
      ],
      examples: [{ code: 'echo(len([4, 5, 6]), len("hello"));', output: 'ECHO: 3, 5' }],
      see: ['is_list'],
      keywords: ['length', 'count', 'size'],
    },
    {
      id: 'concat',
      name: 'concat()',
      signature: 'concat(…)',
      plain: 'Joins lists end to end into one longer list.',
      details: [
        'It flattens **exactly one level**. `concat([1, 2], [3, 4])` is `[1, 2, 3, 4]`, and ' +
          '`concat([[1, 2]], [[3]])` is `[[1, 2], [3]]`.',
        'Values that are not lists are added as single entries: `concat(1, [2, 3])` is ' +
          '`[1, 2, 3]`.',
        'It is the standard way to build a list up in a recursive function.',
      ],
      examples: [{ code: 'echo(concat([1, 2], [3, 4], 5));', output: 'ECHO: [1, 2, 3, 4, 5]' }],
      see: ['list-comprehension'],
      keywords: ['join', 'append', 'combine', 'merge lists'],
    },
    {
      id: 'str',
      name: 'str()',
      signature: 'str(…)',
      plain:
        'Turns values into text and sticks them together. It is how you build a label out of a ' +
        'number.',
      details: [
        'Takes any number of values of any type and joins them with nothing in between.',
        'Numbers print the way `echo` prints them, to six significant figures.',
      ],
      examples: [
        { code: 'n = 12;\necho(str("M", n, " bolt"));', output: 'ECHO: "M12 bolt"' },
        {
          code: 'size = 16;\nlinear_extrude(3) text(str(size, " mm"), size = 8, halign = "center");',
          image: 'str',
          view: 'plan',
          caption: 'A number turned into a label and extruded into the part.',
        },
      ],
      see: ['text', 'chr'],
      keywords: ['string', 'text', 'label', 'concatenate', 'format'],
    },
    {
      id: 'chr',
      name: 'chr(), ord()',
      signature: 'chr(code | list) | ord(string)',
      plain:
        'Convert between a character and its number. Every character has one — `A` is 65 — and ' +
        'these swap between the two.',
      details: [
        '`chr` accepts one code point, or a list of them, and returns a string.',
        '`ord` returns the code point of the **first** character only.',
        'Code points are Unicode, so `chr(8364)` is a euro sign, not a byte.',
      ],
      examples: [{ code: 'echo(chr(65), chr([72, 105]), ord("A"));', output: 'ECHO: "A", "Hi", 65' }],
      see: ['str'],
      keywords: ['character', 'ascii', 'unicode', 'code point'],
    },
    {
      id: 'search',
      name: 'search()',
      signature: 'search(match_value, string_or_vector, num_returns_per_match, index_col_num)',
      plain: 'Finds where something appears in a list or a string, and tells you the position.',
      details: [
        'With the default `num_returns_per_match` of `1`, each needle contributes **at most one** ' +
          'index, and **a miss contributes nothing at all**.',
        'That last part is what makes `search` usable for filtering, and it is also its trap: you ' +
          'cannot compare the length of the result to the length of the needle to detect misses, ' +
          'because a miss simply is not there.',
        '`num_returns_per_match = 0` returns every match for each needle, as a list of lists.',
        '`index_col_num` picks which column of a table of pairs is searched. It defaults to `0`.',
      ],
      examples: [
        { code: 'echo(search("b", "abcb"), search([3], [[1], [3], [3]], 0));', output: 'ECHO: [1], [[1, 2]]' },
      ],
      see: ['lookup', 'len'],
      keywords: ['find', 'index', 'contains', 'position', 'filter'],
    },
    {
      id: 'lookup',
      name: 'lookup()',
      signature: 'lookup(key, table)',
      plain:
        'Reads a value out of a table of pairs, and works out an in-between value when your key ' +
        'falls between two rows.',
      details: [
        '`table` is a list of `[key, value]` pairs. It should be sorted by key.',
        'Between two rows the answer is **interpolated** — halfway between the keys gives halfway ' +
          'between the values. That is the whole point of it, and what makes it different from a ' +
          'plain index.',
        'Outside the table it clamps to the nearest end rather than extrapolating.',
      ],
      examples: [
        {
          code: 'table = [[0, 10], [10, 20], [20, 60]];\necho(lookup(5, table), lookup(15, table), lookup(99, table));',
          output: 'ECHO: 15, 40, 60',
        },
      ],
      see: ['search'],
      keywords: ['table', 'interpolate', 'map', 'curve'],
    },
  ],
};

export const TYPES: ReferenceGroup = {
  id: 'types',
  title: 'Checking types',
  blurb:
    'Ask what kind of value something is. Mostly used to give a module sensible behaviour when ' +
    'an argument is left out.',
  entries: [
    {
      id: 'is_undef',
      name: 'is_undef()',
      signature: 'is_undef(x)',
      plain:
        '`true` when a value is `undef` — the "nothing here" value a variable has when it was ' +
        'never given one.',
      details: [
        'This is the normal way to detect an argument the caller did not pass, when the useful ' +
          'default depends on the other arguments.',
        'An unknown name is `undef` rather than an error, which is why this check is needed at all.',
      ],
      examples: [
        {
          code: 'module plate(w = 20, h) {\n  height = is_undef(h) ? w / 4 : h;\n  cube([w, w, height]);\n}\n\nplate();\ntranslate([30, 0, 0]) plate(20, 16);',
          image: 'is-undef',
          caption: 'The left plate works its height out; the right one was told.',
        },
      ],
      see: ['is_num'],
      keywords: ['undefined', 'missing', 'default', 'optional'],
    },
    {
      id: 'is_num',
      name: 'is_bool(), is_num(), is_string(), is_list(), is_function()',
      signature: 'is_num(x)',
      plain:
        'Each answers `true` or `false` for one kind of value: a true/false, a number, some text, ' +
        'a list, or a function.',
      details: [
        '`is_num` is `false` for `nan`, which is deliberate — `nan` is a number that no ' +
          'calculation should be trusted with.',
        '`is_list` is `true` for `[]`. Check `len()` as well if empty is not acceptable.',
        'A common pattern is accepting either form of an argument: ' +
          '`size = is_list(s) ? s : [s, s, s]`.',
        'BetterSCAD adds `is_range()` to the set.',
      ],
      examples: [
        {
          code: 'echo(is_num(3), is_string("a"), is_list([1]), is_bool(false), is_function(function (x) x));',
          output: 'ECHO: true, true, true, true, true',
        },
      ],
      see: ['is_undef', 'is_range'],
      keywords: ['type', 'predicate', 'check', 'kind'],
    },
    {
      id: 'version',
      name: 'version(), version_num()',
      signature: 'version() | version_num()',
      plain:
        'Reports which language version is running — as a list of three numbers, or as one ' +
        'number. Libraries use it to decide what they can rely on.',
      details: [
        '`version()` is `[year, month, day]`; `version_num()` is the same three numbers packed ' +
          'into one, as `yyyymmdd` — so `[2021, 1, 0]` is `20210100`.',
        'BetterSCAD reports the OpenSCAD language version it implements, not its own, because ' +
          'that is the question a library is asking.',
      ],
      examples: [{ code: 'echo(version(), version_num());', output: 'ECHO: [2021, 1, 0], 20210100' }],
      keywords: ['version', 'compatibility'],
    },
  ],
};
