/**
 * The drawing board: a full-screen dialog for making a 2D outline.
 *
 * SVG DOM rather than a canvas: crisp lines at any zoom, and the measurements
 * are ordinary DOM with an ordinary input inside, which matters because typing
 * a measurement is half the feature. Hit-testing is done in code, not through
 * the DOM, so what you can grab is what the geometry says you can.
 *
 * The board owns its own undo stack. The whole session is one edit to the
 * project — Done writes the SVG, Cancel writes nothing — and twenty presses
 * of Ctrl-Z to get back to before you opened it is not what anybody means by
 * undoing "the drawing".
 */

import { button, el, icon, openMenu, type MenuItem } from '../ui/dom.js';
import { showPrompt } from '../ui/dialogs.js';
import { setHint } from '../ui/tooltip.js';
import {
  cloneNode,
  digestSketch,
  emptySketch,
  groupKey,
  newGroupId,
  translateNode,
  type Anchor,
  type Point,
  type SketchDocument,
  type SketchNode,
} from './doc.js';
import { boundsOfRings, cutIslands, flattenSketch, pointInRing, sampleSegment, type Ring } from './flatten.js';
import {
  applyDimension,
  canClosePath,
  circleFrom,
  dimensionsOf,
  gripsOf,
  moveGrip,
  pathFrom,
  polyFrom,
  readoutFor,
  rectFrom,
  ringAt,
  smoothAnchor,
} from './nodes.js';
import {
  calibrateBackdrop,
  fitBackdrop,
  IMAGE_TYPES,
  loadBackdrop,
  moveBackdrop,
  pixelToBoard,
  releaseBackdrop,
  type Backdrop,
} from './reference.js';
import { inkMask } from './trace/ink.js';
import { vectorizeMask, type Mask } from './trace/vectorize.js';
import type { Clip } from './svg.js';
import { collectTargets, snapToTargets, targetsOf, type Guide, type Target } from './guides.js';
import { fitCamera, gridLines, panBy, snapPoint, toScreen, toWorld, zoomAt, type Camera, type Size } from './view.js';

export type TraceMode = 'subject' | 'ink';

/** Supplies the mask an automatic trace is cut from. See `trace/tracer.ts`. */
export interface TraceProvider {
  /** What the first use will download, e.g. "about 2.4 MB"; empty once it is here. */
  describe(): Promise<string>;
  /** Where the subject is, 0–255 per pixel, at whatever size the model works at. */
  subject(image: ImageData): Promise<Mask>;
}

export interface SketchEditorOptions {
  title: string;
  initial?: SketchDocument;
  /** Grid snap in millimetres; 0 for none. */
  snapStep?: number;
  /** Project images offered as a backdrop. */
  images: { path: string; data: Uint8Array }[];
  /** An image from disk, when none of the project's will do. */
  pickImage(): Promise<{ name: string; data: Uint8Array } | undefined>;
  trace?: TraceProvider;
  /** 2D booleans, for the eraser. Without it there is no eraser. */
  clip?: Clip;
}

type Tool = 'pick' | 'lines' | 'pen' | 'box' | 'circle' | 'eraser' | 'photo' | 'calibrate';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'pick', label: 'Pick', key: 'V', hint: 'Pick: select, move, and drag the corners of an outline' },
  { id: 'lines', label: 'Lines', key: 'L', hint: 'Lines: click each corner; click the first again or press Enter to finish' },
  { id: 'pen', label: 'Pen', key: 'P', hint: 'Pen: click for a corner, drag for a curve; click the first point to close' },
  { id: 'box', label: 'Box', key: 'R', hint: 'Box: drag corner to corner' },
  { id: 'circle', label: 'Circle', key: 'C', hint: 'Circle: drag out from the centre' },
  { id: 'eraser', label: 'Eraser', key: 'E', hint: 'Eraser: click a region to take it out of its shape or group; click it again to put it back' },
];

const HINTS: Record<Tool, string> = {
  pick: 'Click to select, Shift+click to add, drag on empty board to select several. ⌘G groups. Right-drag pans, wheel zooms.',
  lines: 'Click to place corners. Click the first point, or press Enter, to finish. Escape drops the run.',
  pen: 'Click for a corner, click-and-drag for a curve. Click the first point to close. Escape drops it.',
  box: 'Drag from one corner to the opposite one. Type a corner radius into R afterwards.',
  circle: 'Drag from the centre outwards.',
  eraser: 'Click a region — where two outlines overlap, say — and it is cut out. Click an erased region to restore it.',
  photo: 'Drag the picture to move it. Pick a drawing tool when it is placed.',
  calibrate: 'Click two points in the picture that you know the distance between.',
};

/** Pixels, not millimetres: a grip has to be grabbable at any zoom. */
const GRIP_PX = 11;
/** A corner lands on a corner within this; an edge lines up within less. */
const SNAP_POINT_PX = 7;
const SNAP_AXIS_PX = 4;

/** Grid steps on offer, in millimetres. */
const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
const GRID_KEY = 'betterscad.sketch.grid';

interface GridSettings {
  step: number;
  snap: boolean;
  /** Pull to the corners and centres of other outlines, with guide lines. */
  objects: boolean;
}

/** The grid is a preference, not part of any drawing, so it is remembered per browser. */
function loadGridSettings(fallback: GridSettings): GridSettings {
  try {
    const raw = localStorage.getItem(GRID_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<GridSettings>;
    return {
      step: GRID_STEPS.includes(parsed.step as number) ? (parsed.step as number) : fallback.step,
      snap: typeof parsed.snap === 'boolean' ? parsed.snap : fallback.snap,
      objects: typeof parsed.objects === 'boolean' ? parsed.objects : fallback.objects,
    };
  } catch {
    return fallback;
  }
}

function saveGridSettings(settings: GridSettings): void {
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(settings));
  } catch {
    // Private window or full storage: the setting lasts the session.
  }
}
const HISTORY_LIMIT = 100;

type Drag =
  | { kind: 'pan'; last: Point }
  | { kind: 'move'; nodes: number[]; origins: SketchNode[]; last: Point; moved: boolean; start: Point }
  | { kind: 'marquee'; start: Point; current: Point; additive: boolean }
  | { kind: 'grip'; node: number; grip: string; moved: boolean }
  | { kind: 'photo'; last: Point; moved: boolean }
  | { kind: 'shape'; start: Point }
  | { kind: 'pen'; anchor: Point; handle?: Point };

/**
 * Opens the board and resolves with the drawing when Done is pressed, or with
 * nothing on Cancel.
 */
export function showSketchEditor(options: SketchEditorOptions): Promise<SketchDocument | undefined> {
  return new Promise((resolve) => {
    const board = new SketchBoard(options, resolve);
    board.open();
  });
}

class SketchBoard {
  private doc: SketchDocument;
  /** Bumped on every change to `doc`; what the caches below are keyed by. */
  private docVersion = 0;
  private flatCache: { version: number; rings: Ring[] } | undefined;
  private targetCache: { version: number; exclude: string; targets: Target[] } | undefined;
  /** What the static layers were last built for; see `render`. */
  private staticKey = '';
  private past: SketchDocument[] = [];
  private future: SketchDocument[] = [];
  private tool: Tool = 'pick';
  /** Indices of the selected outlines. A group is always wholly in or out. */
  private selection = new Set<number>();
  private camera: Camera = { cx: 0, cy: 0, scale: 4 };
  private size: Size = { w: 800, h: 600 };
  /** Grid spacing in millimetres; also the snap step while snapping is on. */
  private gridStep: number;
  private snap: boolean;
  private snapObjects: boolean;
  /** The alignments the point under the pointer currently has. */
  private guides: Guide[] = [];
  private free = false;
  private cursor: Point | undefined;
  private drag: Drag | undefined;
  /** Points of the line run, or anchors of the pen path, in progress. */
  private linePoints: Point[] = [];
  private penAnchors: Anchor[] = [];
  private backdrop: Backdrop | undefined;
  private calibration: Point[] = [];
  private tracing = false;
  /** Trace the light marks, or what surrounds the subject, instead. */
  private invertTrace = false;
  /** A message worth more than the size readout, until the next action. */
  private notice: string | undefined;
  private rings: Ring[] = [];
  private result: SketchDocument | undefined;

  private readonly dialog: HTMLDialogElement;
  private readonly svg: SVGSVGElement;
  private readonly staticLayer: SVGGElement;
  private readonly dynamicLayer: SVGGElement;
  private readonly labels: HTMLElement;
  /** Readouts beside the pointer: rebuilt with the dynamic layer. */
  private readonly readouts: HTMLElement;
  private readonly footerNote: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly photoStrip: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly groupButton: HTMLButtonElement;
  private readonly ungroupButton: HTMLButtonElement;
  private readonly doneButton: HTMLButtonElement;
  private readonly fitButton: HTMLButtonElement;
  private resizeObserver: ResizeObserver | undefined;

  constructor(
    private readonly options: SketchEditorOptions,
    private readonly resolve: (doc: SketchDocument | undefined) => void,
  ) {
    this.doc = options.initial ? { version: 1, nodes: options.initial.nodes.map(cloneNode) } : emptySketch();
    this.docVersion = 0;
    const grid = loadGridSettings({ step: options.snapStep ?? 0.5, snap: true, objects: true });
    this.gridStep = grid.step;
    this.snap = grid.snap;
    this.snapObjects = grid.objects;

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'sketch__svg');
    this.staticLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.dynamicLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.svg.append(this.staticLayer, this.dynamicLayer);
    this.labels = el('div', { class: 'sketch__labels' });
    this.readouts = el('div', { class: 'sketch__labels' });
    this.hint = el('div', { class: 'sketch__hint' });
    this.footerNote = el('span', { class: 'sketch__note' });
    this.photoStrip = el('div', { class: 'sketch__photo', hidden: true });

    const tools = el('div', { class: 'sketch__tools', role: 'toolbar', 'aria-label': 'Drawing tools' });
    for (const tool of TOOLS) {
      if (tool.id === 'eraser' && !options.clip) continue;
      const node = button({ iconName: tool.id, title: tool.label, shortcut: tool.key, hint: `${tool.hint} (${tool.key})`, onClick: () => this.setTool(tool.id) });
      this.toolButtons.set(tool.id, node);
      tools.appendChild(node);
    }

    this.undoButton = button({ iconName: 'undo', title: 'Undo', shortcut: 'Mod+Z', onClick: () => this.undo() });
    this.redoButton = button({ iconName: 'redo', title: 'Redo', shortcut: 'Mod+Shift+Z', onClick: () => this.redo() });
    this.deleteButton = button({ iconName: 'trash', title: 'Delete the selected outline', shortcut: 'Del', onClick: () => this.removeSelected() });
    this.fitButton = button({ iconName: 'frame', title: 'Fit the drawing in view', onClick: () => this.fitView() });
    const photoButton = button({ iconName: 'image', title: 'Picture to draw over…', onClick: () => this.openPhotoMenu(photoButton) });
    const traceButton = options.trace
      ? button({ iconName: 'trace', title: 'Trace the picture automatically…', onClick: () => this.openTraceMenu(traceButton!) })
      : undefined;
    const gridButton = button({ iconName: 'grid', title: 'Grid and snap…', onClick: () => this.openGridMenu(gridButton) });
    this.groupButton = button({ iconName: 'group', title: 'Group the selected outlines', shortcut: 'Mod+G', onClick: () => this.groupSelection() });
    this.ungroupButton = button({ iconName: 'ungroup', title: 'Ungroup', shortcut: 'Mod+Shift+G', onClick: () => this.ungroupSelection() });

    const board = el('div', { class: 'sketch__board' }, [this.svg as unknown as HTMLElement, this.labels, this.readouts, this.hint]);
    this.doneButton = button({ label: 'Done', variant: 'primary', onClick: () => this.finish() });

    this.dialog = el('dialog', { class: 'dialog--wide dialog--board' }, [
      el('div', { class: 'dialog__header sketch__header' }, [
        el('span', { class: 'sketch__title', text: options.title }),
        tools,
        el('span', { class: 'toolbar__spacer' }),
        this.undoButton,
        this.redoButton,
        this.deleteButton,
        el('span', { class: 'sketch__sep' }),
        this.groupButton,
        this.ungroupButton,
        el('span', { class: 'sketch__sep' }),
        photoButton,
        traceButton ?? null,
        el('span', { class: 'sketch__sep' }),
        gridButton,
        this.fitButton,
      ]),
      this.photoStrip,
      el('div', { class: 'dialog__body dialog__body--flush sketch' }, [board]),
      el('div', { class: 'dialog__footer sketch__footer' }, [
        this.footerNote,
        el('span', { class: 'toolbar__spacer' }),
        button({ label: 'Cancel', variant: 'ghost', onClick: () => this.cancel() }),
        this.doneButton,
      ]),
    ]) as HTMLDialogElement;

    this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.svg.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.cursor = undefined;
        this.render();
      }
    });
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this.dialog.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.dialog.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') {
        this.free = false;
        this.render();
      }
    });
    // Escape is the one key that must not close this: there is unsaved drawing
    // behind it. Cancel is a button, deliberately.
    this.dialog.addEventListener('cancel', (e) => e.preventDefault());
    this.dialog.addEventListener('close', () => {
      this.resizeObserver?.disconnect();
      releaseBackdrop(this.backdrop);
      this.dialog.remove();
      this.resolve(this.result);
    });
  }

  open(): void {
    document.body.appendChild(this.dialog);
    this.dialog.showModal();
    this.resizeObserver = new ResizeObserver(() => {
      const rect = this.svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.size = { w: rect.width, h: rect.height };
        this.render();
      }
    });
    this.resizeObserver.observe(this.svg);
    const rect = this.svg.getBoundingClientRect();
    this.size = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
    this.fitView();
    this.setTool('pick');
  }

  // -- state ----------------------------------------------------------------

  private setDoc(next: SketchDocument): void {
    this.doc = next;
    this.docVersion++;
  }

  /** The drawing as rings, computed once per version of it. */
  private flat(): Ring[] {
    if (!this.flatCache || this.flatCache.version !== this.docVersion) {
      this.flatCache = { version: this.docVersion, rings: flattenSketch(this.doc).rings };
    }
    return this.flatCache.rings;
  }

  private targets(exclude: ReadonlySet<number> | undefined): Target[] {
    const key = exclude ? [...exclude].sort((a, b) => a - b).join(',') : '';
    const c = this.targetCache;
    if (!c || c.version !== this.docVersion || c.exclude !== key) {
      this.targetCache = { version: this.docVersion, exclude: key, targets: collectTargets(this.doc.nodes, exclude) };
    }
    return this.targetCache!.targets;
  }

  /** The one selected outline, when exactly one is. */
  private single(): number | undefined {
    return this.selection.size === 1 ? [...this.selection][0] : undefined;
  }

  /** Every index in the same group as `index`, itself included; loose outlines stand alone. */
  private groupOf(index: number): number[] {
    const node = this.doc.nodes[index];
    if (!node?.group) return [index];
    return this.doc.nodes.map((n, i) => (n.group === node.group ? i : -1)).filter((i) => i >= 0);
  }

  private select(indices: Iterable<number>): void {
    this.selection = new Set(indices);
  }

  private commit(next: SketchDocument): void {
    if (digestSketch(next) === digestSketch(this.doc)) return;
    this.notice = undefined;
    this.past.push(this.doc);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.setDoc(next);
    this.render();
  }

  private replaceNode(index: number, node: SketchNode): void {
    this.commit({ version: 1, nodes: this.doc.nodes.map((n, i) => (i === index ? node : n)) });
  }

  private addNode(node: SketchNode): void {
    this.commit({ version: 1, nodes: [...this.doc.nodes, node] });
    this.select([this.doc.nodes.length - 1]);
    this.render();
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.doc);
    this.setDoc(previous);
    this.dropLostSelection();
    this.render();
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.doc);
    this.setDoc(next);
    this.dropLostSelection();
    this.render();
  }

  /** A selection is an index, and undo can take the outline out from under it. */
  private dropLostSelection(): void {
    this.selection = new Set([...this.selection].filter((i) => i < this.doc.nodes.length));
  }

  private removeSelected(): void {
    if (this.selection.size === 0) return;
    const gone = this.selection;
    this.selection = new Set();
    this.commit({ version: 1, nodes: this.doc.nodes.filter((_, i) => !gone.has(i)) });
  }

  /** The selected outlines become one group; their erased regions come along. */
  private groupSelection(): void {
    if (this.selection.size < 2) return;
    const id = newGroupId(this.doc);
    const chosen = this.selection;
    this.commit({ version: 1, nodes: this.doc.nodes.map((n, i) => (chosen.has(i) ? { ...n, group: id } : n)) });
    this.select(chosen);
    this.render();
  }

  /**
   * The selected groups come apart. Their erased regions go: a cut belongs
   * to the group it was made in, and means nothing once that is gone.
   */
  private ungroupSelection(): void {
    const groups = new Set([...this.selection].map((i) => this.doc.nodes[i]?.group).filter((g): g is string => !!g));
    if (groups.size === 0) return;
    const keep = this.doc.nodes.map((n, i) => ({ n, i })).filter(({ n }) => !(n.group && groups.has(n.group) && n.cut));
    const nodes = keep.map(({ n }) => (n.group && groups.has(n.group) ? { ...n, group: undefined } : n));
    const selected = keep.map(({ i }, newIndex) => (this.selection.has(i) ? newIndex : -1)).filter((i) => i >= 0);
    this.commit({ version: 1, nodes });
    this.select(selected);
    this.render();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.notice = undefined;
    this.linePoints = [];
    this.penAnchors = [];
    this.calibration = [];
    this.drag = undefined;
    for (const [id, node] of this.toolButtons) node.classList.toggle('btn--active', id === tool);
    this.hint.textContent = HINTS[tool];
    this.render();
  }

  private fitView(): void {
    let bounds = boundsOfRings(this.flat());
    if (this.backdrop) {
      const b = this.backdrop;
      bounds = bounds
        ? { minX: Math.min(bounds.minX, b.x), minY: Math.min(bounds.minY, b.y), maxX: Math.max(bounds.maxX, b.x + b.w), maxY: Math.max(bounds.maxY, b.y + b.h) }
        : { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
    }
    this.camera = fitCamera(this.size, bounds);
    this.render();
  }

  private finish(): void {
    this.result = { version: 1, nodes: this.doc.nodes.map(cloneNode) };
    this.dialog.close();
  }

  private cancel(): void {
    this.result = undefined;
    this.dialog.close();
  }

  // -- pointer --------------------------------------------------------------

  private screenPoint(e: PointerEvent | WheelEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private worldPoint(e: PointerEvent, snap = true): Point {
    const p = toWorld(this.camera, this.size, this.screenPoint(e));
    return snap && this.snap && !this.free && !e.altKey ? snapPoint(p, this.gridStep) : p;
  }

  private saveGrid(): void {
    saveGridSettings({ step: this.gridStep, snap: this.snap, objects: this.snapObjects });
  }

  /**
   * The point under the pointer, snapped: to the grid if that is on, and
   * then to the drawing — a corner, a centre, an edge of some other outline
   * within a few pixels wins over the grid, because it is what the eye is
   * lining up with. Alt turns all of it off while held.
   */
  private snappedPoint(e: PointerEvent, exclude?: ReadonlySet<number>): Point {
    const raw = this.worldPoint(e, false);
    this.guides = [];
    // The eraser picks a region, not a point: nothing to line up.
    if (this.free || e.altKey || this.tool === 'eraser') return raw;
    let p = this.snap ? snapPoint(raw, this.gridStep) : raw;
    if (this.snapObjects) {
      const result = snapToTargets([raw], this.targets(exclude), this.snapTolerance(), this.pointTolerance());
      if (result.guides.length > 0) {
        p = [result.guides.some((g) => g.axis === 'x') ? raw[0] + result.dx : p[0], result.guides.some((g) => g.axis === 'y') ? raw[1] + result.dy : p[1]];
        this.guides = result.guides;
      }
    }
    return p;
  }

  /**
   * How close, in millimetres at this zoom, counts as lined up. Narrow on
   * purpose: a wide band catches the pointer on every edge it passes, and
   * that reads as the tool dragging its feet.
   */
  private snapTolerance(): number {
    return SNAP_AXIS_PX / this.camera.scale;
  }

  private pointTolerance(): number {
    return SNAP_POINT_PX / this.camera.scale;
  }

  /**
   * A node carried by (dx, dy) from where the drag began, then snapped by
   * its own key points: to the grid, and to the other outlines' key points
   * when one is closer.
   */
  private movedBy(origins: SketchNode[], indices: number[], dx: number, dy: number, e: PointerEvent): SketchNode[] {
    this.guides = [];
    let shift: Point = [dx, dy];
    const carried = (): SketchNode[] => origins.map((o) => translateNode(o, shift[0], shift[1]));
    if (this.free || e.altKey) return carried();
    const keysOf = (nodes: SketchNode[]): Point[] => nodes.flatMap((n, k) => (n.cut ? [] : targetsOf(n, indices[k]).map((t) => t.at)));
    const keys = keysOf(carried());
    const anchor = keys[0] ?? [0, 0];
    if (this.snap) {
      // The first key point (a corner, or a centre) lands on the grid.
      const snapped = snapPoint(anchor, this.gridStep);
      shift = [shift[0] + snapped[0] - anchor[0], shift[1] + snapped[1] - anchor[1]];
    }
    if (this.snapObjects) {
      const result = snapToTargets(keysOf(carried()), this.targets(new Set(indices)), this.snapTolerance(), this.pointTolerance());
      if (result.guides.length > 0) {
        shift = [shift[0] + result.dx, shift[1] + result.dy];
        this.guides = result.guides;
      }
    }
    return carried();
  }

  /**
   * The eraser. The region under the click is the cell of the arrangement:
   * inside every outline of the group that contains the point, outside every
   * one that does not. The kernel computes it, and it becomes an erased
   * region of that group. Clicking an erased region restores it.
   */
  private async erase(p: Point): Promise<void> {
    const clip = this.options.clip;
    if (!clip) return;
    const hit = ringAt(this.rings, p, 0);
    if (!hit) return;
    const rings = this.rings.filter((r) => r.group === hit.group);
    const erased = rings.filter((r) => r.status === 'cut' && pointInRing(p, r.points));
    if (erased.length > 0) {
      // Inside a cut: the innermost one is what the click means.
      const innermost = erased.reduce((a, b) => (Math.abs(b.area) < Math.abs(a.area) ? b : a));
      this.selection = new Set();
      this.commit({ version: 1, nodes: this.doc.nodes.filter((_, i) => i !== innermost.node) });
      return;
    }
    const material = rings.filter((r) => r.status === 'solid' || r.status === 'hole');
    const inside = material.filter((r) => pointInRing(p, r.points)).map((r) => [r.points]);
    if (inside.length === 0) return;
    const outside = material.filter((r) => !pointInRing(p, r.points)).map((r) => [r.points]);
    outside.push(...cutIslands(rings.filter((r) => r.status === 'cut')).map((i) => [i.outer.points, ...i.holes.map((h) => h.points)]));
    this.notice = 'Cutting…';
    this.render();
    try {
      const polygons = await clip('region', inside, outside);
      const group = this.doc.nodes[hit.node]?.group;
      const cuts: SketchNode[] = polygons
        .filter((poly) => poly.length >= 3)
        .map((poly) => ({ kind: 'poly', points: poly.map(([x, y]) => [x, y] as Point), closed: true, cut: true, ...(group ? { group } : {}) }));
      if (cuts.length === 0) {
        this.notice = 'Nothing to erase there.';
        return;
      }
      this.selection = new Set();
      this.commit({ version: 1, nodes: [...this.doc.nodes, ...cuts] });
      this.notice = 'Erased. Click the region again to restore it.';
    } catch (err) {
      this.notice = `Could not erase: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.render();
    }
  }

  private openGridMenu(anchor: HTMLElement): void {
    openMenu(anchor, [
      {
        kind: 'toggle',
        label: 'Snap to grid',
        description: 'Points land on the grid. Hold Alt to draw off it for a moment.',
        value: this.snap,
        onChange: (value) => {
          this.snap = value;
          this.saveGrid();
          this.render();
        },
      },
      {
        kind: 'toggle',
        label: 'Snap to outlines',
        description: 'Pull to the corners, centres and edges of what is already drawn, with guide lines.',
        value: this.snapObjects,
        onChange: (value) => {
          this.snapObjects = value;
          this.saveGrid();
          this.render();
        },
      },
      {
        kind: 'choice',
        label: 'Grid step',
        description: 'How far apart the grid lines are, and what snapping lands on.',
        value: String(this.gridStep),
        options: GRID_STEPS.map((step) => ({ value: String(step), label: `${step} mm` })),
        onChange: (value) => {
          this.gridStep = Number(value);
          this.saveGrid();
          this.render();
        },
      },
    ]);
  }

  private gripPx(): number {
    return GRIP_PX / this.camera.scale;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', last: this.screenPoint(e) };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.svg.setPointerCapture(e.pointerId);
    const raw = this.worldPoint(e, false);
    const p = this.snappedPoint(e, this.tool === 'pick' ? this.selection : undefined);

    switch (this.tool) {
      case 'pick': {
        // A grip of the one selected outline comes first: it sits on top.
        const one = this.single();
        if (one !== undefined) {
          const grip = gripsOf(this.doc.nodes[one]).find((g) => Math.hypot(g.at[0] - raw[0], g.at[1] - raw[1]) <= this.gripPx());
          if (grip) {
            this.past.push(this.doc);
            this.future = [];
            this.drag = { kind: 'grip', node: one, grip: grip.id, moved: false };
            return;
          }
        }
        const hit = ringAt(this.rings, raw, Math.max(1.2, 8 / this.camera.scale));
        if (hit) {
          const members = this.groupOf(hit.node);
          if (e.shiftKey) {
            // Shift toggles the whole group in or out of the selection.
            const next = new Set(this.selection);
            if (next.has(hit.node)) for (const i of members) next.delete(i);
            else for (const i of members) next.add(i);
            this.selection = next;
          } else if (!this.selection.has(hit.node)) {
            this.select(members);
          }
          if (this.selection.has(hit.node)) {
            const nodes = [...this.selection];
            this.past.push(this.doc);
            this.future = [];
            // The shapes snap, not the cursor: their own corners and centres
            // are what pull to the grid and to their neighbours as they move.
            this.drag = { kind: 'move', nodes, origins: nodes.map((i) => cloneNode(this.doc.nodes[i])), last: raw, moved: false, start: raw };
          }
        } else {
          if (!e.shiftKey) this.selection = new Set();
          this.drag = { kind: 'marquee', start: raw, current: raw, additive: e.shiftKey };
        }
        this.render();
        return;
      }
      case 'eraser':
        void this.erase(raw);
        return;
      case 'lines': {
        const first = this.linePoints[0];
        if (first && this.linePoints.length > 2 && this.nearScreen(first, raw)) {
          this.finishLines();
          return;
        }
        this.linePoints.push(p);
        this.render();
        return;
      }
      case 'pen': {
        const first = this.penAnchors[0];
        if (first && canClosePath(this.penAnchors) && this.nearScreen([first.x, first.y], raw)) {
          this.finishPen(true);
          return;
        }
        this.drag = { kind: 'pen', anchor: p };
        this.render();
        return;
      }
      case 'box':
      case 'circle':
        this.drag = { kind: 'shape', start: p };
        return;
      case 'photo':
        if (this.backdrop) this.drag = { kind: 'photo', last: raw, moved: false };
        return;
      case 'calibrate':
        this.calibration.push(raw);
        if (this.calibration.length === 2) void this.askDistance();
        this.render();
        return;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    const raw = this.worldPoint(e, false);
    this.cursor = this.snappedPoint(
      e,
      drag?.kind === 'move' ? new Set(drag.nodes) : drag?.kind === 'grip' ? new Set([drag.node]) : this.tool === 'pick' ? this.selection : undefined,
    );
    if (!drag) {
      this.render();
      return;
    }
    switch (drag.kind) {
      case 'pan': {
        const now = this.screenPoint(e);
        this.camera = panBy(this.camera, now[0] - drag.last[0], now[1] - drag.last[1]);
        drag.last = now;
        break;
      }
      case 'move': {
        if (raw[0] !== drag.last[0] || raw[1] !== drag.last[1]) {
          const moved = this.movedBy(drag.origins, drag.nodes, raw[0] - drag.start[0], raw[1] - drag.start[1], e);
          drag.moved = true;
          drag.last = raw;
          this.setDoc({ version: 1, nodes: this.doc.nodes.map((n, i) => (drag.nodes.includes(i) ? moved[drag.nodes.indexOf(i)] : n)) });
        }
        break;
      }
      case 'marquee':
        drag.current = raw;
        break;
      case 'grip': {
        drag.moved = true;
        this.setDoc({ version: 1, nodes: this.doc.nodes.map((n, i) => (i === drag.node ? moveGrip(n, drag.grip, this.cursor!) : n)) });
        break;
      }
      case 'photo': {
        if (this.backdrop) {
          this.backdrop = moveBackdrop(this.backdrop, raw[0] - drag.last[0], raw[1] - drag.last[1]);
          drag.last = raw;
          drag.moved = true;
          this.updatePhotoStrip();
        }
        break;
      }
      case 'pen': {
        // Handles are not snapped; the anchor was.
        const h: Point = [raw[0] - drag.anchor[0], raw[1] - drag.anchor[1]];
        drag.handle = Math.hypot(h[0], h[1]) * this.camera.scale > 4 ? h : undefined;
        break;
      }
      case 'shape':
        break;
    }
    this.render();
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    const p = this.snappedPoint(e, drag.kind === 'move' ? new Set(drag.nodes) : drag.kind === 'grip' ? new Set([drag.node]) : undefined);
    this.guides = [];
    switch (drag.kind) {
      case 'move':
      case 'grip':
        // A press that turned out not to be a drag leaves no undo entry.
        if (!drag.moved) this.past.pop();
        else this.setDoc({ version: 1, nodes: this.doc.nodes.map(cloneNode) });
        break;
      case 'marquee': {
        // Outlines wholly inside the box; a touched group comes whole.
        const [x1, x2] = [Math.min(drag.start[0], drag.current[0]), Math.max(drag.start[0], drag.current[0])];
        const [y1, y2] = [Math.min(drag.start[1], drag.current[1]), Math.max(drag.start[1], drag.current[1])];
        const picked = new Set(drag.additive ? this.selection : []);
        for (const ring of this.rings) {
          if (ring.points.length === 0) continue;
          const b = boundsOfRings([ring])!;
          if (b.minX >= x1 && b.maxX <= x2 && b.minY >= y1 && b.maxY <= y2) for (const i of this.groupOf(ring.node)) picked.add(i);
        }
        this.selection = picked;
        break;
      }
      case 'shape': {
        const node = this.tool === 'box' ? rectFrom(drag.start, p) : circleFrom(drag.start, p);
        if (node) {
          this.addNode(node);
          this.setTool('pick');
          this.select([this.doc.nodes.length - 1]);
        }
        break;
      }
      case 'pen':
        this.penAnchors.push(smoothAnchor(drag.anchor, drag.handle));
        break;
      default:
        break;
    }
    this.render();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera = zoomAt(this.camera, this.size, this.screenPoint(e), factor);
    this.render();
  }

  /** Whether two board points are within a grip's radius on screen. */
  private nearScreen(a: Point, b: Point): boolean {
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= this.gripPx();
  }

  private finishLines(): void {
    const node = polyFrom(this.linePoints);
    this.linePoints = [];
    if (node) this.addNode(node);
    this.render();
  }

  private finishPen(closed: boolean): void {
    const node = pathFrom(this.penAnchors, closed && canClosePath(this.penAnchors));
    this.penAnchors = [];
    if (node) this.addNode(node);
    this.render();
  }

  // -- keyboard -------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Alt') {
      this.free = true;
      this.render();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      if (e.shiftKey) this.ungroupSelection();
      else this.groupSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.select(this.doc.nodes.map((_, i) => i));
      this.render();
      return;
    }
    if (mod) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.escape();
        return;
      case 'Enter':
        if (this.tool === 'lines' && this.linePoints.length >= 2) this.finishLines();
        else if (this.tool === 'pen' && this.penAnchors.length >= 2) this.finishPen(true);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        this.removeSelected();
        return;
    }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
    if (tool) this.setTool(tool.id);
  }

  /** One step back at a time: the shape in progress, then the tool, then the selection. */
  private escape(): void {
    if (this.linePoints.length > 0 || this.penAnchors.length > 0 || this.calibration.length > 0) {
      this.linePoints = [];
      this.penAnchors = [];
      this.calibration = [];
      this.render();
      return;
    }
    if (this.tool !== 'pick') {
      this.setTool('pick');
      return;
    }
    if (this.selection.size > 0) {
      this.selection = new Set();
      this.render();
    }
  }

  // -- backdrop -------------------------------------------------------------

  private openPhotoMenu(anchor: HTMLElement): void {
    const images = this.options.images.filter((f) => IMAGE_TYPES.test(f.path));
    // A menu with one thing on it is a step for nothing: with no picture in
    // the project and none on the board, the button is the file picker.
    if (images.length === 0 && !this.backdrop) {
      void this.pickBackdrop();
      return;
    }
    const items: MenuItem[] = images.map((file) => ({
      label: file.path,
      description: 'From the Files panel',
      onSelect: () => void this.setBackdrop(file.data, file.path),
    }));
    items.push({
      label: 'Load a picture…',
      description: 'From your disk; it is not added to the project',
      onSelect: () => void this.pickBackdrop(),
    });
    if (this.backdrop) {
      items.push({ label: 'Remove the picture', description: 'The drawing stays', onSelect: () => this.clearBackdrop() });
    }
    openMenu(anchor, items);
  }

  private async pickBackdrop(): Promise<void> {
    const picked = await this.options.pickImage();
    if (picked) await this.setBackdrop(picked.data, picked.name);
  }

  private async setBackdrop(data: Uint8Array, name: string): Promise<void> {
    try {
      const { image, url } = await loadBackdrop(data, name);
      releaseBackdrop(this.backdrop);
      this.backdrop = { image, url, name, opacity: 0.55, ...fitBackdrop(image, this.camera, this.size) };
      this.setTool('photo');
      this.updatePhotoStrip();
    } catch (err) {
      this.notice = err instanceof Error ? err.message : String(err);
      this.render();
    }
  }

  private clearBackdrop(): void {
    releaseBackdrop(this.backdrop);
    this.backdrop = undefined;
    if (this.tool === 'photo' || this.tool === 'calibrate') this.setTool('pick');
    this.updatePhotoStrip();
    this.render();
  }

  private updatePhotoStrip(): void {
    const strip = this.photoStrip;
    strip.replaceChildren();
    const b = this.backdrop;
    strip.hidden = !b;
    if (!b) return;
    const moveButton = button({ label: 'Move', hint: 'Drag the picture around the board', onClick: () => this.setTool(this.tool === 'photo' ? 'pick' : 'photo') });
    moveButton.classList.toggle('btn--active', this.tool === 'photo');
    const scaleButton = button({
      label: 'Set scale…',
      hint: 'Click two points in the picture and type the real distance between them',
      onClick: () => this.setTool(this.tool === 'calibrate' ? 'pick' : 'calibrate'),
    });
    scaleButton.classList.toggle('btn--active', this.tool === 'calibrate');
    const fade = el('input', { type: 'range', min: '0.08', max: '1', step: '0.01', value: String(b.opacity), 'aria-label': 'Picture fade' }) as HTMLInputElement;
    fade.addEventListener('input', () => {
      if (this.backdrop) this.backdrop.opacity = Number(fade.value);
      this.render();
    });
    strip.append(
      icon('image', 13),
      el('span', { class: 'sketch__photoname', text: b.name }),
      el('span', { class: 'sketch__photosize', text: `${b.w.toFixed(1)} × ${b.h.toFixed(1)} mm` }),
      moveButton,
      scaleButton,
      el('label', { class: 'sketch__fade' }, [el('span', { text: 'Fade' }), fade]),
      el('span', { class: 'toolbar__spacer' }),
      button({ label: 'Remove', variant: 'ghost', onClick: () => this.clearBackdrop() }),
    );
  }

  private async askDistance(): Promise<void> {
    const [p1, p2] = this.calibration;
    const current = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const answer = await showPrompt('Set the picture’s scale', 'How far apart are those two points, in millimetres?', current.toFixed(1), {
      confirmLabel: 'Set scale',
      hint: 'The picture is resized so that the two points are this far apart. The first point stays where it is.',
    });
    this.calibration = [];
    const distance = Number(answer);
    if (this.backdrop && answer && Number.isFinite(distance) && distance > 0) {
      this.backdrop = calibrateBackdrop(this.backdrop, p1, p2, distance);
      this.updatePhotoStrip();
    }
    this.setTool('pick');
    this.fitView();
  }

  // -- automatic tracing ----------------------------------------------------

  private openTraceMenu(anchor: HTMLElement): void {
    if (!this.backdrop) {
      this.notice = 'Load a picture first: tracing works on the picture behind the drawing.';
      this.render();
      return;
    }
    const trace = this.options.trace;
    if (!trace) return;
    void (async () => {
      const cost = await trace.describe();
      openMenu(anchor, [
        {
          label: 'Trace the subject',
          description: cost ? `Finds the main object in the picture and outlines it. Downloads ${cost} the first time.` : 'Finds the main object in the picture and outlines it.',
          onSelect: () => void this.runTrace('subject'),
        },
        {
          label: 'Trace dark lines',
          description: 'Outlines the dark marks on a light background: a scan, a sketch, a logo.',
          onSelect: () => void this.runTrace('ink'),
        },
        {
          kind: 'toggle',
          label: 'Invert',
          description: 'Trace the light marks instead, or what is around the subject rather than the subject.',
          value: this.invertTrace,
          onChange: (value) => {
            this.invertTrace = value;
          },
        },
      ]);
    })();
  }

  private async runTrace(mode: TraceMode): Promise<void> {
    const b = this.backdrop;
    const trace = this.options.trace;
    if (!b || !trace || this.tracing) return;
    this.tracing = true;
    this.notice = mode === 'subject' ? 'Finding the subject…' : this.invertTrace ? 'Tracing the light marks…' : 'Tracing the dark marks…';
    this.footerNote.textContent = this.notice;
    try {
      const mask = mode === 'subject' ? await trace.subject(imageDataOf(b.image, 320)) : inkMask(imageDataOf(b.image, 1024));
      if (this.invertTrace) {
        // White on black, or the stencil around the subject: the same mask
        // the other way up.
        for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - mask.data[i];
      }
      const nodes = vectorizeMask(mask, {
        toBoard: (px, py) => pixelToBoard(b, (px / mask.width) * b.image.naturalWidth, (py / mask.height) * b.image.naturalHeight),
        simplify: 1.2,
        minArea: 12,
      });
      if (nodes.length === 0) {
        this.notice = 'Nothing to trace was found in the picture.';
        return;
      }
      this.commit({ version: 1, nodes: [...this.doc.nodes, ...nodes] });
      this.selection = new Set();
      this.setTool('pick');
      this.notice = `Traced ${nodes.length} outline${nodes.length === 1 ? '' : 's'}; each can be moved, resized or deleted`;
    } catch (err) {
      this.notice = `Tracing failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.tracing = false;
      this.render();
    }
  }

  // -- rendering ------------------------------------------------------------

  /**
   * Two layers. The static one — grid, picture, fills, outlines, labels —
   * costs real work and changes only when the drawing, the camera or the
   * selection does, so it is rebuilt only then. The dynamic one — guides, the
   * shape in progress, grips, readouts — is a few elements and is rebuilt on
   * every pointer move. Rebuilding everything on every move is what made the
   * board feel like it was dragging its feet.
   */
  private render(): void {
    const rings = this.flat();
    this.rings = rings;
    const S = (p: Point): Point => toScreen(this.camera, this.size, p);
    const b = this.backdrop;
    const key = [
      this.docVersion,
      [...this.selection].join(','),
      this.camera.cx,
      this.camera.cy,
      this.camera.scale,
      this.size.w,
      this.size.h,
      this.gridStep,
      this.tool,
      b ? `${b.url}|${b.x}|${b.y}|${b.w}|${b.h}|${b.opacity}` : '',
    ].join('/');

    if (key !== this.staticKey) {
      this.staticKey = key;
      this.svg.setAttribute('viewBox', `0 0 ${this.size.w} ${this.size.h}`);
      this.staticLayer.replaceChildren();
      this.renderGrid(S);
      this.renderBackdrop(S);
      // Material first, as one even-odd fill per island, so what is on
      // screen is what gets built; then every outline's own stroke.
      const fills = this.group('sketch__fills', this.staticLayer);
      for (const ring of rings) {
        if (ring.status !== 'solid') continue;
        const holes = rings.filter((r) => r.status === 'hole' && r.depth === ring.depth + 1);
        const d = [ringPath(ring, S), ...holes.map((h) => ringPath(h, S))].join(' ');
        fills.appendChild(this.path(d, 'sketch__fill', { 'fill-rule': 'evenodd' }));
      }
      // Erased regions are painted in the board's own colour over the fills,
      // nested among themselves so a cut inside a cut shows as material.
      const cutLayer = this.group('sketch__cuts', this.staticLayer);
      for (const group of new Set(rings.filter((r) => r.status === 'cut').map((r) => r.group))) {
        for (const island of cutIslands(rings.filter((r) => r.group === group && r.status === 'cut'))) {
          const d = [ringPath(island.outer, S), ...island.holes.map((h) => ringPath(h, S))].join(' ');
          cutLayer.appendChild(this.path(d, 'sketch__cut', { 'fill-rule': 'evenodd' }));
        }
      }
      const outlines = this.group('sketch__outlines', this.staticLayer);
      for (const ring of rings) {
        const classes = ['sketch__ring', `sketch__ring--${ring.status}`];
        if (this.selection.has(ring.node)) classes.push('sketch__ring--selected');
        outlines.appendChild(this.path(ringPath(ring, S, ring.status !== 'open'), classes.join(' ')));
      }
      this.renderLabels(S);
    }

    this.dynamicLayer.replaceChildren();
    this.readouts.replaceChildren();
    this.renderCalibration(S);
    this.renderGuides(S);
    this.renderDraft(S);
    this.renderGrips(S);
    this.renderFooter(rings);
    this.undoButton.disabled = this.past.length === 0;
    this.redoButton.disabled = this.future.length === 0;
    this.deleteButton.disabled = this.selection.size === 0;
    this.groupButton.disabled = this.selection.size < 2;
    this.ungroupButton.disabled = ![...this.selection].some((i) => this.doc.nodes[i]?.group);
    this.doneButton.disabled = this.tracing;
  }

  private renderGrid(S: (p: Point) => Point): void {
    const grid = gridLines(this.camera, this.size, this.gridStep);
    const g = this.group('sketch__grid', this.staticLayer);
    const line = (a: Point, b: Point, cls: string): void => {
      const [x1, y1] = S(a);
      const [x2, y2] = S(b);
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      node.setAttribute('x1', x1.toFixed(1));
      node.setAttribute('y1', y1.toFixed(1));
      node.setAttribute('x2', x2.toFixed(1));
      node.setAttribute('y2', y2.toFixed(1));
      node.setAttribute('class', cls);
      g.appendChild(node);
    };
    const [left, top] = toWorld(this.camera, this.size, [0, 0]);
    const [right, bottom] = toWorld(this.camera, this.size, [this.size.w, this.size.h]);
    for (const x of grid.fineX) line([x, bottom], [x, top], 'sketch__gridline');
    for (const y of grid.fineY) line([left, y], [right, y], 'sketch__gridline');
    for (const x of grid.coarseX) line([x, bottom], [x, top], 'sketch__gridline sketch__gridline--coarse');
    for (const y of grid.coarseY) line([left, y], [right, y], 'sketch__gridline sketch__gridline--coarse');
    line([left, 0], [right, 0], 'sketch__axis sketch__axis--x');
    line([0, bottom], [0, top], 'sketch__axis sketch__axis--y');
  }

  /** Guide lines across the board for whatever the pointer is lined up with. */
  private renderGuides(S: (p: Point) => Point): void {
    if (this.guides.length === 0) return;
    const g = this.group('sketch__guides');
    for (const guide of this.guides) {
      const [x, y] = S(guide.target);
      const d = guide.axis === 'x' ? `M${x.toFixed(1)},0 V${this.size.h}` : `M0,${y.toFixed(1)} H${this.size.w}`;
      g.appendChild(this.path(d, 'sketch__guide'));
      g.appendChild(this.dot([x, y], 'sketch__guidedot'));
    }
  }

  private renderBackdrop(S: (p: Point) => Point): void {
    const b = this.backdrop;
    if (!b) return;
    const [x, y] = S([b.x, b.y + b.h]);
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    image.setAttribute('href', b.url);
    image.setAttribute('x', x.toFixed(2));
    image.setAttribute('y', y.toFixed(2));
    image.setAttribute('width', (b.w * this.camera.scale).toFixed(2));
    image.setAttribute('height', (b.h * this.camera.scale).toFixed(2));
    image.setAttribute('preserveAspectRatio', 'none');
    image.setAttribute('opacity', String(b.opacity));
    image.setAttribute('class', this.tool === 'photo' ? 'sketch__image sketch__image--moving' : 'sketch__image');
    this.staticLayer.appendChild(image);
  }

  private renderCalibration(S: (p: Point) => Point): void {
    if (this.calibration.length === 0) return;
    const g = this.group('sketch__calibration');
    for (const p of this.calibration) g.appendChild(this.dot(S(p), 'sketch__calib'));
    if (this.calibration.length === 1 && this.cursor) {
      g.appendChild(this.path(`M${S(this.calibration[0]).join(',')} L${S(this.cursor).join(',')}`, 'sketch__calibline'));
    }
  }

  private renderDraft(S: (p: Point) => Point): void {
    const g = this.group('sketch__draft');
    const drag = this.drag;
    const cursor = this.cursor;

    if (this.tool === 'lines' && this.linePoints.length > 0) {
      const pts = cursor ? [...this.linePoints, cursor] : this.linePoints;
      g.appendChild(this.path(pts.map((p, i) => `${i ? 'L' : 'M'}${S(p).join(',')}`).join(' '), 'sketch__draftline'));
      g.appendChild(this.dot(S(this.linePoints[0]), 'sketch__first'));
      if (cursor) this.renderReadout(readoutFor(this.linePoints, cursor), S);
    }

    if (this.tool === 'pen' && (this.penAnchors.length > 0 || drag?.kind === 'pen')) {
      const anchors = [...this.penAnchors];
      if (drag?.kind === 'pen') anchors.push(smoothAnchor(drag.anchor, drag.handle));
      else if (cursor) anchors.push({ x: cursor[0], y: cursor[1] });
      if (anchors.length >= 2) {
        const pts: Point[] = [[anchors[0].x, anchors[0].y]];
        for (let i = 0; i + 1 < anchors.length; i++) pts.push(...sampleSegment(anchors[i], anchors[i + 1]));
        g.appendChild(this.path(pts.map((p, i) => `${i ? 'L' : 'M'}${S(p).join(',')}`).join(' '), 'sketch__draftline'));
      }
      if (this.penAnchors[0]) g.appendChild(this.dot(S([this.penAnchors[0].x, this.penAnchors[0].y]), 'sketch__first'));
      for (const a of this.penAnchors) g.appendChild(this.dot(S([a.x, a.y]), 'sketch__anchor'));
      if (drag?.kind === 'pen' && drag.handle) {
        // Both sides of the handle, through the anchor: a curve whose controls
        // you cannot see is a curve you are guessing at.
        const a = drag.anchor;
        const h = drag.handle;
        g.appendChild(this.path(`M${S([a[0] - h[0], a[1] - h[1]]).join(',')} L${S([a[0] + h[0], a[1] + h[1]]).join(',')}`, 'sketch__handle'));
        g.appendChild(this.dot(S([a[0] + h[0], a[1] + h[1]]), 'sketch__handledot'));
        g.appendChild(this.dot(S([a[0] - h[0], a[1] - h[1]]), 'sketch__handledot'));
      }
      if (cursor && this.penAnchors.length > 0 && drag?.kind !== 'pen') {
        const last = this.penAnchors[this.penAnchors.length - 1];
        const readout = readoutFor(this.penAnchors.map((a) => [a.x, a.y] as Point), cursor);
        // The straight line between two anchors is not the corner you can see
        // when either end is curved, so the angle is left off then.
        if (readout && (last.out || last.in)) delete readout.angle;
        this.renderReadout(readout, S);
      }
    }

    if (drag?.kind === 'marquee') {
      const a = S(drag.start);
      const b = S(drag.current);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', Math.min(a[0], b[0]).toFixed(1));
      rect.setAttribute('y', Math.min(a[1], b[1]).toFixed(1));
      rect.setAttribute('width', Math.abs(b[0] - a[0]).toFixed(1));
      rect.setAttribute('height', Math.abs(b[1] - a[1]).toFixed(1));
      rect.setAttribute('class', 'sketch__marquee');
      g.appendChild(rect);
    }

    if (drag?.kind === 'shape' && cursor) {
      const node = this.tool === 'box' ? rectFrom(drag.start, cursor) : circleFrom(drag.start, cursor);
      if (node) {
        const ring = flattenSketch({ version: 1, nodes: [node] }).rings[0];
        g.appendChild(this.path(ringPath(ring, S), 'sketch__draftline'));
        const label =
          node.kind === 'rect' ? `${node.w.toFixed(1)} × ${node.h.toFixed(1)}` : `Ø ${(node.r * 2).toFixed(1)}`;
        this.renderReadout({ length: 0, at: cursor }, S, label);
      }
    }
  }

  private renderReadout(readout: ReturnType<typeof readoutFor>, S: (p: Point) => Point, text?: string): void {
    if (!readout) return;
    const [x, y] = S(readout.at);
    const label = text ?? (readout.angle !== undefined ? `${readout.length.toFixed(1)} mm · ${readout.angle}°` : `${readout.length.toFixed(1)} mm`);
    const node = el('div', { class: 'sketch__readout', text: label });
    node.style.left = `${x + 12}px`;
    node.style.top = `${y - 12}px`;
    this.readouts.appendChild(node);
  }

  private renderGrips(S: (p: Point) => Point): void {
    const one = this.single();
    if (one === undefined || this.tool !== 'pick') return;
    const node = this.doc.nodes[one];
    if (!node) return;
    const g = this.group('sketch__grips');
    for (const grip of gripsOf(node)) g.appendChild(this.dot(S(grip.at), 'sketch__grip'));
    if (node.kind === 'path') {
      // Handles are drawn so a curve's shape can be read, though only anchors move.
      for (const a of node.anchors) {
        for (const h of [a.in, a.out]) {
          if (!h) continue;
          g.appendChild(this.path(`M${S([a.x, a.y]).join(',')} L${S([a.x + h[0], a.y + h[1]]).join(',')}`, 'sketch__handle'));
        }
      }
    }
  }

  private renderLabels(S: (p: Point) => Point): void {
    this.labels.replaceChildren();
    // A busy drawing labels only what is selected; otherwise every outline is
    // labelled, because a few numbers beside a few shapes is the whole idea.
    const indices = this.doc.nodes.length > 9 ? [...this.selection] : this.doc.nodes.map((_, i) => i);
    for (const index of indices) {
      const node = this.doc.nodes[index];
      const selected = this.selection.has(index);
      for (const dim of dimensionsOf(node)) {
        if (dim.id === 'r' && dim.value === 0 && !selected) continue;
        const [x, y] = S(dim.at);
        const label = el('button', {
          class: selected ? 'sketch__dim sketch__dim--selected' : 'sketch__dim',
          type: 'button',
          text: `${dim.label ? `${dim.label} ` : ''}${dim.value.toFixed(dim.value % 1 === 0 ? 0 : 2)}`,
        }) as HTMLButtonElement;
        label.style.left = `${x + dim.away[0] * 22}px`;
        label.style.top = `${y - dim.away[1] * 22}px`;
        setHint(label, 'Click to type a measurement');
        // The label sits over the board, and a press on it is not a press on
        // what is behind it.
        label.addEventListener('pointerdown', (e) => e.stopPropagation());
        label.addEventListener('click', (e) => {
          e.stopPropagation();
          this.editDimension(label, index, dim.id, dim.value);
        });
        this.labels.appendChild(label);
      }
    }
  }

  private editDimension(label: HTMLElement, index: number, id: string, value: number): void {
    const input = el('input', { class: 'sketch__diminput', type: 'text', value: String(value), 'aria-label': 'Measurement in millimetres' }) as HTMLInputElement;
    input.style.left = label.style.left;
    input.style.top = label.style.top;
    const done = (apply: boolean): void => {
      input.remove();
      // The label the field replaced has to come back whatever happens.
      this.staticKey = '';
      if (apply) {
        const next = Number(input.value.replace(',', '.'));
        const node = this.doc.nodes[index];
        if (node && Number.isFinite(next)) this.replaceNode(index, applyDimension(node, id, next));
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => done(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  private renderFooter(rings: Ring[]): void {
    if (this.tracing) return;
    const material = rings.filter((r) => r.status === 'solid' || r.status === 'hole');
    const bounds = boundsOfRings(material);
    const parts: string[] = [];
    if (bounds) parts.push(`${(bounds.maxX - bounds.minX).toFixed(1)} × ${(bounds.maxY - bounds.minY).toFixed(1)} mm`);
    else parts.push('Nothing drawn yet');
    if (this.selection.size > 1) parts.push(`${this.selection.size} selected`);
    const open = rings.filter((r) => r.status === 'open').length;
    const crossing = rings.filter((r) => r.status === 'crossing').length;
    const tiny = rings.filter((r) => r.status === 'tiny').length;
    if (open) parts.push(`${open} open line${open === 1 ? '' : 's'} left out`);
    if (crossing) parts.push(`${crossing} crossing outline${crossing === 1 ? '' : 's'} left out`);
    if (tiny) parts.push(`${tiny} too small`);
    const snapping = [this.snap ? `grid ${this.gridStep} mm` : '', this.snapObjects ? 'outlines' : ''].filter(Boolean).join(' + ');
    parts.push(this.free ? 'Snap off while Alt is held' : snapping ? `Snap to ${snapping} · hold Alt to free` : `Grid ${this.gridStep} mm · snap off`);
    this.footerNote.textContent = this.notice ? `${this.notice} · ${parts[0]}` : parts.join(' · ');
  }

  // -- SVG helpers ----------------------------------------------------------

  private group(cls: string, parent: SVGElement = this.dynamicLayer): SVGGElement {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', cls);
    parent.appendChild(g);
    return g;
  }

  private path(d: string, cls: string, attrs: Record<string, string> = {}): SVGPathElement {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('d', d);
    node.setAttribute('class', cls);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  private dot([x, y]: Point, cls: string): SVGCircleElement {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    node.setAttribute('cx', x.toFixed(1));
    node.setAttribute('cy', y.toFixed(1));
    node.setAttribute('r', cls === 'sketch__grip' ? '5' : '4');
    node.setAttribute('class', cls);
    return node;
  }
}

function ringPath(ring: Ring, S: (p: Point) => Point, close = true): string {
  if (ring.points.length === 0) return '';
  const d = ring.points.map((p, i) => `${i ? 'L' : 'M'}${S(p).map((v) => v.toFixed(1)).join(',')}`).join(' ');
  return close ? `${d} Z` : d;
}

/** The picture scaled to fit a square of `side`, as pixels. */
function imageDataOf(image: HTMLImageElement, side: number): ImageData {
  const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas available.');
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
