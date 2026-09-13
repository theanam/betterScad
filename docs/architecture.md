# Architecture

How a `.scad` file becomes triangles, and why the pieces are split where they are.

```
source text
    │
    ▼
  lexer.ts ──────► tokens
    │
    ▼
  parser.ts ─────► AST                    (hand-written, recovers from errors)
    │
    ▼
interpreter.ts ─► scene graph             (roles, not hardcoded modifiers)
    │
    ▼
kernel/evaluate.ts ─► geometry            (Manifold WASM does the CSG)
    │
    ├──► viewport (Three.js)
    └──► io/export/* (STL, 3MF, OFF, AMF, SVG, DXF)
```

Everything left of the viewport lives in `@betterscad/engine` and has no DOM
dependency. That is what lets the same code run in the browser app, in a Web
Worker, and in the Node CLI.

## Lexer

`packages/engine/src/lexer.ts`

Straightforward, with two context-sensitive details resolved here rather than
pushed downstream:

- `include <path>` and `use <path>` scan the angle brackets as a single path
  token. Everywhere else `<` and `>` are comparison operators, and only the
  preceding keyword disambiguates them.
- `%`, `#`, `!` and `*` are emitted as ordinary operator tokens. Whether a given
  occurrence is a debug modifier or arithmetic depends purely on
  statement-versus-expression position, which is the parser's job.

Comments are captured rather than discarded: the Customizer reads its parameter
annotations out of them.

## Parser

`packages/engine/src/parser.ts`

Recursive descent for statements, precedence climbing for expressions. Written
from the documented grammar; no tables or code derived from upstream OpenSCAD.

Two things are worth knowing:

**Error recovery.** A parse error records a diagnostic and skips to the next
`;` or `}` at the current brace depth, then continues. The editor can therefore
show every problem in a file at once rather than one per save.

**`^` binds tighter than unary minus.** `-2 ^ 2` is `-4`, not `4`. Precedence
climbing cannot express that, so exponentiation lives in its own `parsePower`
rule sitting *below* `parseUnary`:

```
power := postfix ('^' unary)?
unary := ('-' | '+' | '!') unary | power
```

## Interpreter

`packages/engine/src/interpreter.ts`

Walks the AST and produces a scene graph. It implements the two OpenSCAD
semantics that surprise people coming from ordinary languages:

**Assignments are scope-wide.** Within a scope, every assignment is evaluated —
in source order — *before* any geometry statement runs. So the last assignment
to a name is what every statement in that scope sees:

```scad
a = 1;
echo(a);   // 2
a = 2;
```

**`$`-variables are dynamically scoped.** They flow down into called modules,
while ordinary variables resolve lexically at the definition site. Each scope
therefore keeps two parent pointers, one lexical and one dynamic.

One subtlety that is easy to get wrong: `difference() { a; b; }` has a single
*syntactic* child — the brace block — but two CSG operands. `executeChildren`
unwraps a lone unmodified block so the boolean sees its operands separately.
Without it, every braced boolean silently collapses to a no-op union.

## Roles: modifiers without special cases

`packages/engine/src/roles.ts`

OpenSCAD hardcodes four debug modifiers and special-cases each one throughout
its CSG evaluator. BetterSCAD gives every scene node a list of **role names**,
and the evaluator dispatches on what a role *declares*:

| Contribution | Meaning | Stock syntax |
| --- | --- | --- |
| `solid` | Ordinary geometry, combined with the enclosing operation. | (default) |
| `ignored` | Contributes nothing at all. | `*` |
| `annotation` | Drawn in the preview, excluded from geometry. | `%` |
| `isolate` | This subtree replaces the entire enclosing scope. | `!` |
| `subtractive` | Assembled, then subtracted from every sibling in scope. | — (`negative()`) |

`combine()` in `kernel/evaluate.ts` never mentions `%`, `#`, `!` or `*`. It asks
`resolveContribution()` what each child's roles mean and routes accordingly.

`subtractive` is the one contribution that needs more than routing, because it
has a *reach*: a negative cuts its siblings in the enclosing brace scope, but is
usually written under a wrapper — `translate(…) negative() …`, or inside an `if`
or `for` — that has no geometry of its own. So an assembly carries a `negatives`
list alongside its pieces: a wrapper with nothing to cut passes them up (through
`applyTransform`, so they arrive positioned correctly), and a scope consumes
them. `scopeGroup()` marks what counts as a scope — a `{ … }` block, a module
body, the top level — and dimension-changing nodes bound it too, since a 2D
negative means nothing in the 3D scope above a `linear_extrude`.

`defineRole()` **throws** unless the role declares a legacy downgrade path. The
spec's cross-cutting constraint is enforced at registration rather than
documented and hoped for.

## Geometry kernel

`packages/engine/src/kernel/`

[Manifold](https://github.com/elalish/manifold) (Apache-2.0) provides robust
boolean operations, hulls, Minkowski sums, extrusion and revolution, plus
Clipper2 for 2D. Reinventing exact CSG was never the interesting part of this
project, and avoiding CGAL keeps the licence clean.

Three decisions shape this layer:

**Assemblies, not single solids.** A scene evaluates to a flat list of *pieces*,
each with its own colour. OpenSCAD's colours are a display property, not part of
the solid, so eagerly unioning everything would lose them. Pieces are unioned
once, at export.

**Primitives use OpenSCAD's own tessellation.** `sphere($fn=6)` and
`cylinder($fn=3)` are used deliberately to get a specific low-poly solid, so
spheres, cylinders and circles place vertices exactly where OpenSCAD does rather
than using Manifold's equivalent-but-different generators.

**Assets are preloaded.** `import()` and `surface()` files are fetched in a
pre-pass so the recursive evaluator can stay synchronous. An `await` per node
would turn a 50k-node scene into 50k microtasks.

**Memory is arena-managed.** The WASM heap is not garbage collected from
JavaScript. Every Manifold handle is tracked in an `Arena` and freed in one go
after results are copied into plain typed arrays. Without it, each re-render
would leak its entire intermediate geometry.

## The app

`packages/app/`

The engine — including the WASM kernel — runs in a Web Worker. Geometry crosses
the boundary as transferable typed arrays, so a large model costs one pointer
handoff rather than a structured clone, and a slow boolean never freezes typing.

Renders are **coalesced, not queued**: while one is in flight, further requests
replace each other. Dragging a Customizer slider therefore produces a steady
stream of fresh frames instead of a backlog of stale ones.

Vertex normals are computed in the worker, area-weighted from the un-normalised
face cross products, because the worker already owns the data.

The viewport renders **on demand** rather than in a continuous rAF loop. A CAD
model is static between interactions, and spinning the GPU at 60fps to redraw an
unchanged scene drains laptop batteries for nothing.

## Native file format

`packages/engine/src/bscad.ts`

`.bscad` is a `.scad` file with a metadata header in a leading block comment:

```scad
/* BetterSCAD
{ "version": 1, "layout": { … }, "presets": { … } }
*/
cube(10);
```

Stock OpenSCAD reads it unchanged, because a comment is just a comment. The
native format is its own downgrade path.

## Legacy export

`packages/engine/src/transpile.ts`

Doubles as a pretty-printer, deliberately. A transpiler that can only emit the
constructs it rewrites drifts out of sync with the grammar; one that prints
every node is exercised by every file it touches.

Binary expressions are parenthesised unconditionally. The output must re-parse
identically, and precedence-aware printing is not worth the risk of getting
subtly wrong.
