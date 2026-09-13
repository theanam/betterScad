/**
 * Manifold WASM loader.
 *
 * Manifold (Apache-2.0) provides the robust boolean kernel, so BetterSCAD does
 * not reinvent exact CSG, and — critically — never touches CGAL or any other
 * GPL component (spec feature 3a).
 *
 * The module is a singleton: instantiating the WASM more than once wastes
 * several megabytes and gives geometry from different instances that cannot be
 * combined.
 */

import ManifoldModule from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';

export type ManifoldAPI = ManifoldToplevel;

let instance: ManifoldAPI | undefined;
let pending: Promise<ManifoldAPI> | undefined;

export interface WasmOptions {
  /**
   * Absolute or relative URL of `manifold.wasm`.
   *
   * Bundlers rewrite the asset path, so the app passes this explicitly rather
   * than relying on Emscripten's default resolution.
   */
  wasmUrl?: string;
}

export async function loadKernel(options: WasmOptions = {}): Promise<ManifoldAPI> {
  if (instance) return instance;
  if (!pending) {
    pending = (async () => {
      const module = options.wasmUrl
        ? await ManifoldModule({ locateFile: () => options.wasmUrl! })
        : await ManifoldModule();
      module.setup();
      instance = module;
      return module;
    })();
  }
  return pending;
}

/** The loaded kernel, or `undefined` if `loadKernel` has not resolved yet. */
export function kernelIfReady(): ManifoldAPI | undefined {
  return instance;
}
