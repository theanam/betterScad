/**
 * The arrangement of the workspace's panels, as plain data.
 *
 * Two columns, each a stack of panels top to bottom. Any panel can sit in
 * either column at any position, be hidden, or be maximized over the rest.
 * Kept free of the DOM so the rules — what a preset is, where a moved panel
 * lands, what a damaged saved layout comes back as — can be tested on their
 * own, and so the UI only ever renders an arrangement rather than editing one.
 */

export type PanelId = 'editor' | 'viewport' | 'console' | 'customizer' | 'files';

export const PANEL_IDS: readonly PanelId[] = ['editor', 'viewport', 'console', 'customizer', 'files'];

export const PANEL_NAMES: Record<PanelId, string> = {
  editor: 'Code editor',
  viewport: 'Viewport',
  console: 'Console',
  customizer: 'Customizer',
  files: 'Files',
};

export interface Arrangement {
  /** Left column, then right, each top to bottom. Every panel is in exactly one. */
  columns: [PanelId[], PanelId[]];
  visible: Record<PanelId, boolean>;
  /**
   * How a column's height is shared. Relative, and only among the panels
   * showing: hiding one hands its share to the others rather than leaving a
   * gap, and showing it again takes the same share back.
   */
  weights: Record<PanelId, number>;
  /** The left column's share of the width, when both columns have something showing. */
  split: number;
  /** One panel filling the whole workspace, or none. */
  maximized: PanelId | null;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  arrangement: Omit<Arrangement, 'maximized'>;
}

const DEFAULT_WEIGHTS: Record<PanelId, number> = {
  editor: 58,
  customizer: 42,
  files: 34,
  viewport: 74,
  console: 26,
};

const ALL_BUT = (...hidden: PanelId[]): Record<PanelId, boolean> =>
  Object.fromEntries(PANEL_IDS.map((id) => [id, !hidden.includes(id)])) as Record<PanelId, boolean>;

export const PRESETS: readonly Preset[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'Code on the left; the model and the console on the right',
    arrangement: {
      columns: [
        ['editor', 'customizer', 'files'],
        ['viewport', 'console'],
      ],
      visible: ALL_BUT('customizer', 'files'),
      weights: DEFAULT_WEIGHTS,
      split: 0.44,
    },
  },
  {
    id: 'model',
    label: 'Model focus',
    description: 'Hide the code: the model, with the console under it',
    arrangement: {
      columns: [
        ['editor', 'customizer', 'files'],
        ['viewport', 'console'],
      ],
      visible: ALL_BUT('editor', 'customizer', 'files'),
      weights: DEFAULT_WEIGHTS,
      split: 0.44,
    },
  },
  {
    id: 'code',
    label: 'Code focus',
    description: 'A wide editor with the console under it, the model beside',
    arrangement: {
      columns: [
        ['editor', 'console'],
        ['viewport', 'customizer', 'files'],
      ],
      visible: ALL_BUT('customizer', 'files'),
      weights: { ...DEFAULT_WEIGHTS, editor: 74, console: 26, viewport: 58 },
      split: 0.62,
    },
  },
  {
    id: 'tune',
    label: 'Tune parameters',
    description: 'The model large, the Customizer beside it, the code put away',
    arrangement: {
      columns: [
        ['viewport', 'console'],
        ['customizer', 'editor', 'files'],
      ],
      visible: ALL_BUT('editor', 'files'),
      weights: { ...DEFAULT_WEIGHTS, viewport: 80, console: 20, customizer: 60 },
      split: 0.68,
    },
  },
  {
    id: 'swapped',
    label: 'Model on the left',
    description: 'The default, mirrored: model and console left, code right',
    arrangement: {
      columns: [
        ['viewport', 'console'],
        ['editor', 'customizer', 'files'],
      ],
      visible: ALL_BUT('customizer', 'files'),
      weights: DEFAULT_WEIGHTS,
      split: 0.56,
    },
  },
];

/** A fresh copy, so nothing that edits an arrangement can edit a preset. */
export function fromPreset(id: string): Arrangement {
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  const a = preset.arrangement;
  return {
    columns: [[...a.columns[0]], [...a.columns[1]]],
    visible: { ...a.visible },
    weights: { ...a.weights },
    split: a.split,
    maximized: null,
  };
}

export const DEFAULT_ARRANGEMENT: Arrangement = fromPreset('default');

/** Keeps a column share somewhere a column is still usable. */
export function clampSplit(split: number): number {
  return Math.min(0.88, Math.max(0.12, split));
}

/**
 * Brings a stored arrangement back to one that can be rendered.
 *
 * Saved layouts outlive the code that wrote them: a session from before a panel
 * existed has no place for it, and a hand-edited or damaged one can list a
 * panel twice. Anything that cannot be repaired piece by piece falls back to
 * the default columns, keeping whatever visibility and sizes were valid.
 */
export function sanitize(input: Partial<Arrangement> | undefined): Arrangement {
  const base = fromPreset('default');
  if (!input) return base;

  const columns = Array.isArray(input.columns) && input.columns.length === 2 ? input.columns : undefined;
  const listed = columns ? [...columns[0], ...columns[1]] : [];
  const exact =
    columns !== undefined &&
    columns.every(Array.isArray) &&
    listed.length === PANEL_IDS.length &&
    PANEL_IDS.every((id) => listed.includes(id));
  if (exact) base.columns = [[...columns[0]], [...columns[1]]];

  for (const id of PANEL_IDS) {
    const shown = input.visible?.[id];
    if (typeof shown === 'boolean') base.visible[id] = shown;
    const weight = input.weights?.[id];
    if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) base.weights[id] = weight;
  }
  if (typeof input.split === 'number' && Number.isFinite(input.split)) base.split = clampSplit(input.split);
  base.maximized =
    input.maximized && PANEL_IDS.includes(input.maximized) && base.visible[input.maximized]
      ? input.maximized
      : null;
  return base;
}

/** Which column a panel is in, and where. */
export function locate(arrangement: Arrangement, id: PanelId): { column: 0 | 1; index: number } {
  const left = arrangement.columns[0].indexOf(id);
  return left >= 0 ? { column: 0, index: left } : { column: 1, index: arrangement.columns[1].indexOf(id) };
}

/**
 * Moves a panel to `index` in `column`, where `index` counts the column as it
 * is *before* the move — the slot the drop indicator was drawn at.
 */
export function movePanel(arrangement: Arrangement, id: PanelId, column: 0 | 1, index: number): Arrangement {
  const from = locate(arrangement, id);
  const columns: [PanelId[], PanelId[]] = [[...arrangement.columns[0]], [...arrangement.columns[1]]];
  columns[from.column].splice(from.index, 1);
  // Taking the panel out of its own column shifts every slot below it up one.
  const at = from.column === column && from.index < index ? index - 1 : index;
  columns[column].splice(Math.max(0, Math.min(at, columns[column].length)), 0, id);
  return { ...arrangement, columns };
}

/** The panels of a column that are showing, in order. */
export function shown(arrangement: Arrangement, column: 0 | 1): PanelId[] {
  return arrangement.columns[column].filter((id) => arrangement.visible[id]);
}
