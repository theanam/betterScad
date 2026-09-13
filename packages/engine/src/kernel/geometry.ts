/**
 * The geometry carriers that flow through CSG evaluation.
 *
 * A scene evaluates to an *assembly*: a flat list of pieces, each with its own
 * colour and display treatment. Keeping pieces separate rather than eagerly
 * unioning them is what lets `color()` survive to the preview — OpenSCAD's
 * colours are a display property, not part of the solid — while still allowing
 * one final union for export.
 */

import type { CrossSection, Manifold } from 'manifold-3d';
import type { Display } from '../roles.js';

export type RGBA = [number, number, number, number];

export interface Piece {
  dim: 2 | 3;
  /** `Manifold` when `dim === 3`, `CrossSection` when `dim === 2`. */
  solid: Manifold | CrossSection;
  color?: RGBA;
  display: Display;
}

export interface Assembly {
  /** Geometry that participates in booleans and is exported. */
  pieces: Piece[];
  /**
   * Preview-only geometry from `background`-role subtrees (`%`). Carried
   * alongside rather than inside `pieces` precisely so that an enclosing
   * `difference()` cannot cut with it.
   */
  annotations: Piece[];
  /**
   * `negative`-role geometry that has not yet found anything to cut.
   *
   * A negative subtracts from its siblings in the enclosing *brace* scope, but
   * it is often written under a wrapper that has no geometry of its own —
   * `translate(…) negative() …`, or inside an `if` or `for`. Those wrappers are
   * not scopes, so the negative rides up through them (picking up their
   * transforms) until it reaches a scope with something to cut.
   */
  negatives: Piece[];

  /**
   * True once a `root`-role node (`!`) has claimed the render; ancestors must
   * then discard their other children.
   */
  isolated: boolean;
}

export function assembly(
  pieces: Piece[],
  annotations: Piece[] = [],
  isolated = false,
  negatives: Piece[] = [],
): Assembly {
  return { pieces, annotations, isolated, negatives };
}

export const emptyAssembly = (): Assembly => assembly([]);

export function piecesOfDim(a: Assembly, dim: 2 | 3): Piece[] {
  return a.pieces.filter((p) => p.dim === dim);
}

export function isEmpty(a: Assembly): boolean {
  return a.pieces.length === 0 && a.annotations.length === 0 && a.negatives.length === 0;
}

/** The dominant dimension of an assembly, preferring 3D when both are present. */
export function dimensionOf(a: Assembly): 2 | 3 | 0 {
  let has2 = false;
  let has3 = false;
  for (const p of a.pieces) {
    if (p.dim === 2) has2 = true;
    else has3 = true;
  }
  if (has3) return 3;
  if (has2) return 2;
  return 0;
}

/**
 * Tracks every Manifold/CrossSection handle so they can be freed in one go.
 *
 * The WASM heap is not garbage collected from JavaScript: without this, each
 * re-render of a model would leak its entire intermediate geometry, and a
 * session of live-editing would exhaust memory within minutes.
 */
export class Arena {
  private readonly handles: { delete(): void }[] = [];

  track<T extends { delete(): void }>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  trackAll<T extends { delete(): void }>(handles: T[]): T[] {
    for (const h of handles) this.handles.push(h);
    return handles;
  }

  get size(): number {
    return this.handles.length;
  }

  /** Frees everything tracked. Call only after results are copied out to JS. */
  disposeAll(): void {
    for (const handle of this.handles) {
      try {
        handle.delete();
      } catch {
        // Already deleted, or the module is being torn down; nothing to do.
      }
    }
    this.handles.length = 0;
  }
}
