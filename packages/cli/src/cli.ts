/**
 * `bscad` — headless BetterSCAD renderer (spec feature 24).
 *
 * Batch-renders `.scad` / `.bscad` files to any supported export format, with
 * parameter overrides, so parametric families and CI checks need no GUI. It
 * uses the same engine the browser app does, which is the point of keeping the
 * engine UI-agnostic (spec feature 3).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import {
  ENGINE_VERSION,
  Engine,
  EXPORT_FORMATS,
  FontRegistry,
  parse,
  parseBscad,
  toStockScad,
  type AssetProvider,
  type Diagnostic,
  type ExportFormat,
  type Value,
} from '@betterscad/engine';

interface Options {
  input: string[];
  outPath?: string;
  format?: ExportFormat;
  parameters: Record<string, Value>;
  fonts: string[];
  /** `$t` for a single render, or a frame count for `--frames`. */
  time: number;
  frames?: number;
  legacy: boolean;
  quiet: boolean;
  warningsAsErrors: boolean;
}

const USAGE = `bscad — headless BetterSCAD renderer

Usage
  bscad <input.scad|input.bscad>... [options]

Options
  -o, --output <path>      Output file, or a directory when rendering several inputs.
                           Defaults to the input name with the format's extension.
  -f, --format <name>      ${EXPORT_FORMATS.map((f) => f.format).join(', ')} (default: stl)
  -D, --define <k=v>       Override a top-level variable. Repeatable.
                           Values are parsed as OpenSCAD literals: 10, 1.5, true, "text", [1,2,3]
      --font <file.ttf>    Load a font for text(). Repeatable.
      --time <t>           Set $t for the render (default: 0).
      --frames <n>         Render n frames with $t from 0 to 1; output gets a -0000 suffix.
      --legacy-scad        Write stock OpenSCAD .scad instead of rendering. A file that
                           uses no extensions is copied byte for byte.
  -q, --quiet              Only print errors.
      --strict             Treat warnings as errors (useful in CI).
  -h, --help               Show this help.
  -v, --version            Show the engine version.

Examples
  bscad model.scad -o model.stl
  bscad model.scad -D size=30 -D label='"v2"' -o out/
  bscad *.scad -f 3mf -o build/
  bscad anim.scad --frames 60 -o frames/
  bscad model.bscad --legacy-scad -o model.scad
`;

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (!options) return;

  if (options.input.length === 0) {
    process.stderr.write(USAGE);
    throw new Error('No input files given.');
  }

  const format = options.format ?? 'stl';
  const descriptor = EXPORT_FORMATS.find((f) => f.format === format);
  if (!descriptor) {
    throw new Error(`Unknown format "${format}". Known formats: ${EXPORT_FORMATS.map((f) => f.format).join(', ')}`);
  }

  const fonts = new FontRegistry();
  for (const path of options.fonts) {
    const data = await readFile(path);
    const face = fonts.register(data);
    if (!face) throw new Error(`Could not read font "${path}".`);
    if (fonts.families.length === 1) fonts.setDefaultFamily(face.family);
    if (!options.quiet) log(`font: ${face.family} (${face.style})`);
  }

  // Transpiling needs no geometry kernel, so it skips the WASM load entirely —
  // but it does need the fonts, because `text(radius = …)` is rewritten from
  // measured glyph widths.
  if (options.legacy) {
    for (const input of options.input) await transpileFile(input, options, fonts);
    return;
  }

  const engine = await Engine.create({ fonts });
  let failures = 0;

  for (const input of options.input) {
    try {
      await renderFile(engine, input, options, format, descriptor.extension);
    } catch (err) {
      failures++;
      process.stderr.write(`${input}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${options.input.length} file(s) failed.`);
  }
}

// ---------------------------------------------------------------------------

async function renderFile(
  engine: Engine,
  input: string,
  options: Options,
  format: ExportFormat,
  extension: string,
): Promise<void> {
  const raw = await readFile(input, 'utf8');
  // A `.bscad` file is a `.scad` superset; strip the metadata header first.
  const { source, metadata } = parseBscad(raw);

  // Presets stored in the file are the baseline; -D overrides win over them.
  const presetName = metadata.activePreset;
  const preset = (presetName && metadata.presets?.[presetName]) ?? {};
  const parameters = { ...(preset as Record<string, Value>), ...options.parameters };

  const frameCount = options.frames ?? 1;

  for (let frame = 0; frame < frameCount; frame++) {
    const time = options.frames ? frame / frameCount : options.time;
    const started = Date.now();

    const result = await engine.render(source, {
      file: basename(input),
      parameters,
      time,
      preview: false,
      resolveInclude: makeResolver(input),
      assets: makeAssets(input),
    });

    reportDiagnostics(input, result.diagnostics, options);

    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) throw new Error(`${errors.length} error(s); nothing written.`);
    if (options.warningsAsErrors && result.diagnostics.some((d) => d.severity === 'warning')) {
      throw new Error('Warnings present and --strict was given.');
    }

    const file = engine.export(result, format, { generator: `BetterSCAD ${ENGINE_VERSION}` });
    const outPath = resolveOutputPath(input, options, extension, options.frames ? frame : undefined);
    await writeFile(outPath, file.data);

    if (!options.quiet) {
      const { triangles, volume } = result.geometry.stats;
      log(
        `${input} -> ${outPath}  ` +
          `${triangles.toLocaleString()} tris, ${formatBytes(file.data.length)}, ${Date.now() - started} ms` +
          (volume > 0 ? `, volume ${volume.toFixed(2)}` : ''),
      );
    }
  }
}

async function transpileFile(input: string, options: Options, fonts: FontRegistry): Promise<void> {
  const raw = await readFile(input, 'utf8');
  const { source } = parseBscad(raw);
  const result = toStockScad(source, basename(input), { fonts });

  if (result.errors.length > 0) {
    for (const error of result.errors) process.stderr.write(formatDiagnostic(input, error) + '\n');
    // Not always a parse error: `text(radius = …)` also refuses here when the
    // font it needs measuring was not given.
    throw new Error('Nothing written.');
  }

  const outPath = resolveOutputPath(input, options, 'scad');
  await writeFile(outPath, result.source, 'utf8');

  if (!options.quiet) {
    log(`${input} -> ${outPath}`);
    if (result.verbatim) {
      // Worth saying out loud: an unchanged copy is the right answer for a file
      // that was already stock, not a sign the transpile was skipped by mistake.
      log('  already stock OpenSCAD; copied unchanged');
      return;
    }
    for (const extension of result.extensions) log(`  rewrote ${extension.name}: ${extension.downgrade}`);
    for (const rewrite of result.rewrites) log(`  ${rewrite}`);
  }
}

/**
 * Resolves the output path.
 *
 * A directory target (existing, or ending in a separator) keeps each input's
 * own stem, which is what makes `bscad *.scad -o build/` behave sensibly.
 */
function resolveOutputPath(
  input: string,
  options: Options,
  extension: string,
  frame?: number,
): string {
  const stem = basename(input, extname(input));
  const suffix = frame === undefined ? '' : `-${String(frame).padStart(4, '0')}`;
  const filename = `${stem}${suffix}.${extension}`;

  if (!options.outPath) return join(dirname(input), filename);

  const target = isAbsolute(options.outPath) ? options.outPath : resolve(options.outPath);
  const looksLikeDirectory =
    options.outPath.endsWith('/') ||
    options.input.length > 1 ||
    frame !== undefined ||
    (existsSync(target) && !extname(target));

  return looksLikeDirectory ? join(target, filename) : target;
}

function makeResolver(input: string) {
  const base = dirname(resolve(input));
  return async (path: string): Promise<string | undefined> => {
    // Resolve relative to the including file, as OpenSCAD does.
    const candidate = isAbsolute(path) ? path : join(base, path);
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      return undefined;
    }
  };
}

function makeAssets(input: string): AssetProvider {
  const base = dirname(resolve(input));
  return {
    async read(path) {
      const candidate = isAbsolute(path) ? path : join(base, path);
      try {
        return new Uint8Array(await readFile(candidate));
      } catch {
        return undefined;
      }
    },
    // No `decodeImage`: pulling an image codec into the CLI for `surface()` is
    // not worth the dependency. `.dat` heightmaps work; images report clearly.
  };
}

function reportDiagnostics(input: string, diagnostics: Diagnostic[], options: Options): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'echo') {
      if (!options.quiet) process.stdout.write(`${diagnostic.message}\n`);
      continue;
    }
    if (diagnostic.severity === 'info') continue;
    if (diagnostic.severity === 'warning' && options.quiet) continue;
    process.stderr.write(formatDiagnostic(input, diagnostic) + '\n');
  }
}

function formatDiagnostic(input: string, diagnostic: Diagnostic): string {
  const where = diagnostic.span
    ? `${input}:${diagnostic.span.start.line}:${diagnostic.span.start.column}`
    : input;
  return `${where}: ${diagnostic.severity}: ${diagnostic.message}`;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------

/** Returns `undefined` when the run is finished (help/version were printed). */
function parseArgs(argv: string[]): Options | undefined {
  const options: Options = {
    input: [],
    parameters: {},
    fonts: [],
    time: 0,
    legacy: false,
    quiet: false,
    warningsAsErrors: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      return value;
    };

    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return undefined;
      case '-v':
      case '--version':
        process.stdout.write(`${ENGINE_VERSION}\n`);
        return undefined;
      case '-o':
      case '--output':
        options.outPath = next();
        break;
      case '-f':
      case '--format':
        options.format = next() as ExportFormat;
        break;
      case '-D':
      case '--define': {
        const [name, ...rest] = next().split('=');
        if (rest.length === 0) throw new Error(`--define expects name=value, got "${name}".`);
        options.parameters[name.trim()] = parseLiteral(rest.join('='));
        break;
      }
      case '--font':
        options.fonts.push(next());
        break;
      case '--time':
        options.time = Number(next());
        break;
      case '--frames':
        options.frames = Math.max(1, Math.floor(Number(next())));
        break;
      case '--legacy-scad':
        options.legacy = true;
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      case '--strict':
        options.warningsAsErrors = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}". Try --help.`);
        options.input.push(arg);
    }
  }

  return options;
}

/**
 * Parses a `-D` value as an OpenSCAD literal.
 *
 * Reusing the real parser means `-D v=[1,2,3]` and `-D s="text"` behave exactly
 * as they would in the script, rather than following a second, subtly different
 * set of rules invented for the command line.
 */
export function parseLiteral(text: string): Value {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'undef') return undefined;

  const asNumber = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(asNumber)) return asNumber;

  const parsed = parse(`__value = ${trimmed};`, '<define>');
  const statement = parsed.file.body[0];
  if (
    parsed.diagnostics.some((d) => d.severity === 'error') ||
    !statement ||
    statement.kind !== 'assign'
  ) {
    // Not a valid literal: treat it as a bare string, which is what a shell
    // user writing `-D name=hello` almost certainly meant.
    return trimmed;
  }

  return literalOf(statement.value);
}

function literalOf(expr: import('@betterscad/engine').Expr): Value {
  switch (expr.kind) {
    case 'number':
      return expr.value;
    case 'string':
      return expr.value;
    case 'bool':
      return expr.value;
    case 'undef':
      return undefined;
    case 'unary': {
      const inner = literalOf(expr.operand);
      if (typeof inner !== 'number') return undefined;
      return expr.op === '-' ? -inner : inner;
    }
    case 'list':
      return expr.elements.map((element) =>
        element.kind === 'item' ? literalOf(element.value) : undefined,
      );
    default:
      return undefined;
  }
}
