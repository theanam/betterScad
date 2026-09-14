/**
 * Autocomplete for OpenSCAD (spec feature 4).
 *
 * Three sources, merged:
 *  1. The built-in module and function library, with real signatures and docs.
 *  2. Symbols defined in the current document (modules, functions, variables).
 *  3. Special variables, offered as soon as `$` is typed.
 */

import {
  Completion,
  CompletionContext,
  CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete';

interface BuiltinDoc {
  label: string;
  /** Snippet template; `${name}` marks a tab stop. */
  template: string;
  detail: string;
  info: string;
  type: 'function' | 'keyword' | 'class';
}

/** Built-in modules, with the parameters that matter most placed first. */
const MODULES: BuiltinDoc[] = [
  { label: 'cube', template: 'cube(${size})', detail: 'cube(size, center)', info: 'Axis-aligned box. `size` is a number or [x, y, z].', type: 'class' },
  { label: 'sphere', template: 'sphere(r = ${1})', detail: 'sphere(r | d)', info: 'Sphere at the origin. Resolution follows $fn / $fa / $fs.', type: 'class' },
  { label: 'cylinder', template: 'cylinder(h = ${10}, r = ${5})', detail: 'cylinder(h, r | r1, r2 | d, d1, d2, center)', info: 'Cylinder or cone. A zero radius at one end gives a cone.', type: 'class' },
  { label: 'polyhedron', template: 'polyhedron(points = [${}], faces = [[${}]])', detail: 'polyhedron(points, faces, convexity)', info: 'Arbitrary solid. Faces are wound clockwise seen from outside.', type: 'class' },
  { label: 'square', template: 'square(${size})', detail: 'square(size, center)', info: '2D rectangle.', type: 'class' },
  { label: 'circle', template: 'circle(r = ${1})', detail: 'circle(r | d)', info: '2D circle, tessellated per $fn / $fa / $fs.', type: 'class' },
  { label: 'polygon', template: 'polygon(points = [${}])', detail: 'polygon(points, paths, convexity)', info: '2D polygon. With `paths`, extra contours become holes.', type: 'class' },
  { label: 'text', template: 'text("${text}", size = ${10})', detail: 'text(text, size, font, halign, valign, spacing, direction)', info: '2D text outlines. Fonts are managed in the Fonts dialog.', type: 'class' },
  { label: 'translate', template: 'translate([${0}, ${0}, ${0}])', detail: 'translate(v)', info: 'Moves children by a vector.\n\nBetterSCAD also accepts loose numbers: `translate(x, y, z)`.', type: 'class' },
  { label: 'rotate', template: 'rotate([${0}, ${0}, ${0}])', detail: 'rotate(a, v)', info: 'Rotates children. `rotate(a)` rotates about Z; `rotate(a, v)` about an axis.\n\nBetterSCAD also accepts loose numbers: `rotate(x, y, z)`.', type: 'class' },
  { label: 'scale', template: 'scale([${1}, ${1}, ${1}])', detail: 'scale(v)', info: 'Scales children per axis.', type: 'class' },
  { label: 'resize', template: 'resize([${x}, ${y}, ${z}])', detail: 'resize(newsize, auto)', info: 'Scales children to an absolute bounding-box size.', type: 'class' },
  { label: 'mirror', template: 'mirror([${1}, ${0}, ${0}])', detail: 'mirror(v)', info: 'Mirrors children across the plane with normal `v`.\n\nBetterSCAD also accepts loose numbers: `mirror(x, y, z)`.', type: 'class' },

  // Single-axis transforms (BetterSCAD extension). Grouped so the axis reads as
  // the point of the call rather than as a position in a vector.
  { label: 'translatex', template: 'translatex(${0})', detail: 'translatex(d)  — BetterSCAD', info: 'Moves children `d` along X.\n\nExports to `.scad` as `translate([d, 0, 0])`.', type: 'class' },
  { label: 'translatey', template: 'translatey(${0})', detail: 'translatey(d)  — BetterSCAD', info: 'Moves children `d` along Y.\n\nExports to `.scad` as `translate([0, d, 0])`.', type: 'class' },
  { label: 'translatez', template: 'translatez(${0})', detail: 'translatez(d)  — BetterSCAD', info: 'Moves children `d` along Z.\n\nExports to `.scad` as `translate([0, 0, d])`.', type: 'class' },
  { label: 'rotatex', template: 'rotatex(${0})', detail: 'rotatex(a)  — BetterSCAD', info: 'Rotates children `a` degrees about X.\n\nExports to `.scad` as `rotate([a, 0, 0])`.', type: 'class' },
  { label: 'rotatey', template: 'rotatey(${0})', detail: 'rotatey(a)  — BetterSCAD', info: 'Rotates children `a` degrees about Y.\n\nExports to `.scad` as `rotate([0, a, 0])`.', type: 'class' },
  { label: 'rotatez', template: 'rotatez(${0})', detail: 'rotatez(a)  — BetterSCAD', info: 'Rotates children `a` degrees about Z.\n\nExports to `.scad` as `rotate([0, 0, a])`.', type: 'class' },
  { label: 'mirrorx', template: 'mirrorx()', detail: 'mirrorx()  — BetterSCAD', info: 'Mirrors children across the YZ plane.\n\nExports to `.scad` as `mirror([1, 0, 0])`.', type: 'class' },
  { label: 'mirrory', template: 'mirrory()', detail: 'mirrory()  — BetterSCAD', info: 'Mirrors children across the XZ plane.\n\nExports to `.scad` as `mirror([0, 1, 0])`.', type: 'class' },
  { label: 'mirrorz', template: 'mirrorz()', detail: 'mirrorz()  — BetterSCAD', info: 'Mirrors children across the XY plane.\n\nExports to `.scad` as `mirror([0, 0, 1])`.', type: 'class' },
  { label: 'multmatrix', template: 'multmatrix(${m})', detail: 'multmatrix(m)', info: 'Applies a 4x4 (or 3x4) affine matrix.', type: 'class' },
  { label: 'color', template: 'color("${red}")', detail: 'color(c, alpha)', info: 'Sets preview colour. Accepts a CSS name, #hex, or [r, g, b, a] in 0..1.', type: 'class' },
  { label: 'offset', template: 'offset(r = ${1})', detail: 'offset(r | delta, chamfer)', info: '2D offset. `r` rounds corners; `delta` keeps them sharp.', type: 'class' },
  { label: 'union', template: 'union() {\n\t${}\n}', detail: 'union()', info: 'Combines children. Implicit for any group of siblings.', type: 'class' },
  { label: 'difference', template: 'difference() {\n\t${}\n}', detail: 'difference()', info: 'Subtracts every child after the first from the first.', type: 'class' },
  { label: 'intersection', template: 'intersection() {\n\t${}\n}', detail: 'intersection()', info: 'Keeps only the volume common to every child.', type: 'class' },
  { label: 'hull', template: 'hull() {\n\t${}\n}', detail: 'hull()', info: 'Convex hull of all children.', type: 'class' },
  { label: 'minkowski', template: 'minkowski() {\n\t${}\n}', detail: 'minkowski()', info: 'Minkowski sum of the children. Expensive; keep the second shape small.', type: 'class' },
  { label: 'linear_extrude', template: 'linear_extrude(height = ${10}) ${}', detail: 'linear_extrude(height, center, twist, slices, scale)', info: 'Extrudes 2D geometry along Z.', type: 'class' },
  { label: 'rotate_extrude', template: 'rotate_extrude(angle = ${360}) ${}', detail: 'rotate_extrude(angle, start)', info: 'Revolves 2D geometry about Z. The profile must sit at x >= 0.', type: 'class' },
  { label: 'projection', template: 'projection(cut = ${false}) ${}', detail: 'projection(cut)', info: 'Flattens 3D to 2D. `cut = true` slices at z = 0.', type: 'class' },
  { label: 'render', template: 'render() ${}', detail: 'render(convexity)', info: 'Forces full evaluation of a subtree.', type: 'class' },
  { label: 'import', template: 'import("${file.stl}")', detail: 'import(file, convexity, layer, origin, scale)', info: 'Imports STL, OBJ, OFF, DXF or SVG.', type: 'class' },
  { label: 'surface', template: 'surface("${heightmap.dat}")', detail: 'surface(file, center, invert)', info: 'Builds a solid from a heightmap (.dat grid or an image).', type: 'class' },
  { label: 'children', template: 'children(${})', detail: 'children(index)', info: 'Instantiates the children passed to this module.', type: 'class' },
  { label: 'negative', template: 'negative() {\n\t${}\n}', detail: 'negative()  — BetterSCAD extension', info: 'Turns a subtree into negative space, subtracted from every sibling in scope.\n\nExports to legacy .scad as a difference().', type: 'class' },
];

const FUNCTIONS: BuiltinDoc[] = [
  { label: 'sin', template: 'sin(${a})', detail: 'sin(degrees)', info: 'Sine. Angles are in degrees.', type: 'function' },
  { label: 'cos', template: 'cos(${a})', detail: 'cos(degrees)', info: 'Cosine. Angles are in degrees.', type: 'function' },
  { label: 'tan', template: 'tan(${a})', detail: 'tan(degrees)', info: 'Tangent. Angles are in degrees.', type: 'function' },
  { label: 'asin', template: 'asin(${x})', detail: 'asin(x)', info: 'Arc sine, in degrees.', type: 'function' },
  { label: 'acos', template: 'acos(${x})', detail: 'acos(x)', info: 'Arc cosine, in degrees.', type: 'function' },
  { label: 'atan', template: 'atan(${x})', detail: 'atan(x)', info: 'Arc tangent, in degrees.', type: 'function' },
  { label: 'atan2', template: 'atan2(${y}, ${x})', detail: 'atan2(y, x)', info: 'Full-circle arc tangent, in degrees.', type: 'function' },
  { label: 'abs', template: 'abs(${x})', detail: 'abs(x)', info: 'Absolute value.', type: 'function' },
  { label: 'sign', template: 'sign(${x})', detail: 'sign(x)', info: '-1, 0 or 1.', type: 'function' },
  { label: 'floor', template: 'floor(${x})', detail: 'floor(x)', info: 'Rounds down.', type: 'function' },
  { label: 'ceil', template: 'ceil(${x})', detail: 'ceil(x)', info: 'Rounds up.', type: 'function' },
  { label: 'round', template: 'round(${x})', detail: 'round(x)', info: 'Rounds half away from zero.', type: 'function' },
  { label: 'sqrt', template: 'sqrt(${x})', detail: 'sqrt(x)', info: 'Square root.', type: 'function' },
  { label: 'pow', template: 'pow(${base}, ${exp})', detail: 'pow(base, exponent)', info: 'Exponentiation. `base ^ exponent` is equivalent.', type: 'function' },
  { label: 'exp', template: 'exp(${x})', detail: 'exp(x)', info: 'e to the power x.', type: 'function' },
  { label: 'ln', template: 'ln(${x})', detail: 'ln(x)', info: 'Natural logarithm.', type: 'function' },
  { label: 'log', template: 'log(${x})', detail: 'log(x)', info: 'Base-10 logarithm.', type: 'function' },
  { label: 'min', template: 'min(${a}, ${b})', detail: 'min(a, b, …) | min(vector)', info: 'Smallest value.', type: 'function' },
  { label: 'max', template: 'max(${a}, ${b})', detail: 'max(a, b, …) | max(vector)', info: 'Largest value.', type: 'function' },
  { label: 'norm', template: 'norm(${v})', detail: 'norm(v)', info: 'Euclidean length of a vector.', type: 'function' },
  { label: 'cross', template: 'cross(${a}, ${b})', detail: 'cross(a, b)', info: 'Cross product (3D), or the scalar z-component (2D).', type: 'function' },
  { label: 'len', template: 'len(${v})', detail: 'len(list | string)', info: 'Element or character count.', type: 'function' },
  { label: 'concat', template: 'concat(${a}, ${b})', detail: 'concat(…)', info: 'Concatenates lists, flattening exactly one level.', type: 'function' },
  { label: 'str', template: 'str(${})', detail: 'str(…)', info: 'Converts and joins values into a string.', type: 'function' },
  { label: 'chr', template: 'chr(${code})', detail: 'chr(code | list)', info: 'Unicode code points to a string.', type: 'function' },
  { label: 'ord', template: 'ord(${s})', detail: 'ord(string)', info: 'Code point of the first character.', type: 'function' },
  { label: 'lookup', template: 'lookup(${key}, ${table})', detail: 'lookup(key, table)', info: 'Linear interpolation over a table of [key, value] pairs.', type: 'function' },
  { label: 'search', template: 'search(${needle}, ${haystack})', detail: 'search(match_value, string_or_vector, num_returns_per_match, index_col_num)', info: 'Finds indices of matching entries.', type: 'function' },
  { label: 'rands', template: 'rands(${min}, ${max}, ${count})', detail: 'rands(min_value, max_value, value_count, seed)', info: 'Random numbers. Pass `seed` for a reproducible sequence.', type: 'function' },
  { label: 'is_undef', template: 'is_undef(${x})', detail: 'is_undef(x)', info: 'True when the value is undef.', type: 'function' },
  { label: 'is_bool', template: 'is_bool(${x})', detail: 'is_bool(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_num', template: 'is_num(${x})', detail: 'is_num(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_string', template: 'is_string(${x})', detail: 'is_string(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_list', template: 'is_list(${x})', detail: 'is_list(x)', info: 'Type predicate.', type: 'function' },
  { label: 'is_function', template: 'is_function(${x})', detail: 'is_function(x)', info: 'Type predicate.', type: 'function' },
  { label: 'version', template: 'version()', detail: 'version()', info: 'Language version as [year, month, day].', type: 'function' },
  { label: 'echo', template: 'echo(${})', detail: 'echo(…)', info: 'Prints to the console panel.', type: 'function' },
  { label: 'assert', template: 'assert(${condition}, "${message}")', detail: 'assert(condition, message)', info: 'Stops evaluation with an error when the condition is false.', type: 'function' },
];

const KEYWORD_SNIPPETS: BuiltinDoc[] = [
  { label: 'module', template: 'module ${name}(${params}) {\n\t${}\n}', detail: 'module name(params) { … }', info: 'Defines a module: a reusable piece of geometry.', type: 'keyword' },
  { label: 'function', template: 'function ${name}(${params}) = ${expr};', detail: 'function name(params) = expr;', info: 'Defines a function. The body is a single expression.', type: 'keyword' },
  { label: 'for', template: 'for (${i} = [${0}:${9}]) {\n\t${}\n}', detail: 'for (var = range | list)', info: 'Repeats its children once per value.', type: 'keyword' },
  { label: 'intersection_for', template: 'intersection_for (${i} = [${0}:${9}]) {\n\t${}\n}', detail: 'intersection_for (var = range)', info: 'Intersects the results of every iteration.', type: 'keyword' },
  { label: 'if', template: 'if (${condition}) {\n\t${}\n}', detail: 'if (condition) … else …', info: 'Conditional instantiation.', type: 'keyword' },
  { label: 'let', template: 'let (${name} = ${value}) ${}', detail: 'let (assignments) expr-or-statement', info: 'Binds values for a single expression or statement.', type: 'keyword' },
  { label: 'each', template: 'each ${list}', detail: 'each list', info: 'Splices a list into the surrounding list comprehension.', type: 'keyword' },
  { label: 'include', template: 'include <${file.scad}>', detail: 'include <path>', info: 'Splices another file in, variables and geometry included.', type: 'keyword' },
  { label: 'use', template: 'use <${file.scad}>', detail: 'use <path>', info: 'Imports only the modules and functions from another file.', type: 'keyword' },
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

function toCompletion(doc: BuiltinDoc, boost: number): Completion {
  return snippetCompletion(doc.template, {
    label: doc.label,
    detail: doc.detail,
    info: doc.info,
    type: doc.type,
    boost,
  });
}

const CONSTANT_COMPLETIONS: Completion[] = CONSTANTS.map((c) => ({
  label: c.label,
  detail: c.detail,
  info: c.info,
  type: 'constant',
  boost: 2,
}));

// Modules are what people type most, so they outrank functions on ties.
const BUILTIN_COMPLETIONS: Completion[] = [
  ...MODULES.map((d) => toCompletion(d, 3)),
  ...CONSTANT_COMPLETIONS,
  ...KEYWORD_SNIPPETS.map((d) => toCompletion(d, 2)),
  ...FUNCTIONS.map((d) => toCompletion(d, 1)),
];

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
    options: [...BUILTIN_COMPLETIONS, ...documentSymbols(source, context.pos)],
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
