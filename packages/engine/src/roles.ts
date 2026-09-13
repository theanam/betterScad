/**
 * Modifier roles.
 *
 * OpenSCAD hardcodes four debug modifiers (`% # ! *`) and special-cases each
 * one throughout its CSG evaluator. BetterSCAD instead gives every node a list
 * of *role* names, and the evaluator dispatches on what a role declares
 * (spec feature 3a). Adding a modifier — the motivating example being a
 * `negative()` that cuts into everything else in its scope — is then a registry
 * entry plus, at most, a new `contribution` case, rather than a rearchitecture.
 *
 * Every role must also declare how it degrades to legacy `.scad`
 * (spec feature 21): nothing enters the language without a downgrade path.
 */

/**
 * How a node participates in the CSG scope that contains it.
 *
 * - `solid`      — ordinary geometry, combined with the enclosing operation.
 * - `ignored`    — contributes nothing at all (`*`).
 * - `annotation` — drawn in the preview, excluded from geometry (`%`).
 * - `subtractive`— assembled, then subtracted from every sibling in scope.
 *                  Not reachable from stock OpenSCAD syntax; this is the hook
 *                  the `negative()` extension is built on.
 * - `isolate`    — this subtree replaces the entire enclosing scope (`!`).
 */
export type Contribution = 'solid' | 'ignored' | 'annotation' | 'subtractive' | 'isolate';

/** How the preview renderer should draw a node carrying this role. */
export type Display = 'normal' | 'transparent' | 'highlight';

export interface ModifierRole {
  name: string;
  contribution: Contribution;
  display: Display;
  /** Whether descendants inherit the role's display treatment. */
  inheritsDisplay: boolean;
  description: string;
  /**
   * Downgrade path to legacy OpenSCAD (spec feature 21).
   *
   * `modifier` is the equivalent stock prefix character when one exists;
   * `transpile` describes the rewrite when it does not.
   */
  legacy: { modifier?: string; transpile?: string };
}

const registry = new Map<string, ModifierRole>();

export function defineRole(role: ModifierRole): void {
  if (registry.has(role.name)) {
    throw new Error(`Modifier role "${role.name}" is already registered.`);
  }
  if (!role.legacy.modifier && !role.legacy.transpile) {
    // Enforced rather than documented: spec feature 21 is a hard constraint.
    throw new Error(
      `Modifier role "${role.name}" must declare a legacy .scad downgrade path ` +
        `(either \`legacy.modifier\` or \`legacy.transpile\`).`,
    );
  }
  registry.set(role.name, role);
}

export function getRole(name: string): ModifierRole | undefined {
  return registry.get(name);
}

export function allRoles(): ModifierRole[] {
  return [...registry.values()];
}

// --- stock OpenSCAD modifiers ---------------------------------------------

defineRole({
  name: 'background',
  contribution: 'annotation',
  display: 'transparent',
  inheritsDisplay: true,
  description: 'Draw the subtree as a transparent reference; exclude it from the result geometry.',
  legacy: { modifier: '%' },
});

defineRole({
  name: 'highlight',
  contribution: 'solid',
  display: 'highlight',
  inheritsDisplay: true,
  description: 'Draw the subtree highlighted while still contributing to the result.',
  legacy: { modifier: '#' },
});

defineRole({
  name: 'root',
  contribution: 'isolate',
  display: 'normal',
  inheritsDisplay: false,
  description: 'Render only this subtree, discarding everything else in the scope.',
  legacy: { modifier: '!' },
});

defineRole({
  name: 'disabled',
  contribution: 'ignored',
  display: 'normal',
  inheritsDisplay: false,
  description: 'Ignore the subtree entirely.',
  legacy: { modifier: '*' },
});

// --- BetterSCAD extension --------------------------------------------------

defineRole({
  name: 'negative',
  contribution: 'subtractive',
  display: 'transparent',
  inheritsDisplay: true,
  description:
    'Turn the subtree into negative space: it is subtracted from every sibling in the enclosing scope.',
  legacy: {
    transpile:
      'Rewrite the enclosing scope as difference() { <non-negative siblings>; <negative subtrees>; }.',
  },
});

/**
 * Resolves a node's role list to the single contribution that governs it.
 *
 * Precedence is deliberate and ordered by how destructive the role is:
 * `ignored` beats everything (an explicitly disabled node stays disabled),
 * then `isolate`, then `annotation`, then `subtractive`.
 */
export function resolveContribution(roles: readonly string[]): Contribution {
  let result: Contribution = 'solid';
  const order: Contribution[] = ['solid', 'subtractive', 'annotation', 'isolate', 'ignored'];
  for (const name of roles) {
    const role = registry.get(name);
    if (!role) continue;
    if (order.indexOf(role.contribution) > order.indexOf(result)) {
      result = role.contribution;
    }
  }
  return result;
}

/** The display treatment for a node, given its own roles and an inherited one. */
export function resolveDisplay(roles: readonly string[], inherited: Display = 'normal'): Display {
  for (const name of roles) {
    const role = registry.get(name);
    if (role && role.display !== 'normal') return role.display;
  }
  return inherited;
}
