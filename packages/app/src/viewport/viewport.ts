/**
 * The 3D preview viewport (spec features 5, 19).
 *
 * Rendering is on-demand rather than a continuous rAF loop: a CAD model is
 * static between interactions, and spinning the GPU at 60fps to redraw an
 * unchanged scene drains laptop batteries for nothing.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  type Intersection,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { MeshPayload } from '../render/protocol.js';
import { OrbitCamera, type CameraState, type StandardView } from './controls.js';
import { ViewGizmo } from './view-gizmo.js';

/**
 * How far the pointer may travel before a press on the view cube counts as a
 * drag rather than a click. Small enough that a deliberate click still snaps
 * with an unsteady hand, large enough that it is not triggered by one.
 */
const GIZMO_DRAG_SLOP = 4;

/**
 * How close, in screen pixels, the cursor has to be for a measurement point to
 * snap to a feature.
 *
 * Soft: past these radii the click measures exactly where it landed, so the
 * tool never refuses to give you the point you asked for. A corner reaches
 * further than an edge because it is the most useful target and the hardest to
 * hit dead-on.
 */
const SNAP_VERTEX_PX = 14;
const SNAP_EDGE_PX = 9;

/** Grid divisions drawn across the helper, matching `rebuildHelpers`. */
const GRID_DIVISIONS = 20;

/**
 * Above this angle between the two faces along an edge, the edge is a real edge
 * of the shape rather than a seam through a flat surface. 20° is deliberately
 * lower than the shading crease angle: a facet worth snapping to is not
 * necessarily one worth drawing a hard shadow across.
 */
const FEATURE_EDGE_COS = Math.cos((20 * Math.PI) / 180);

/** The ground, z = 0, which a click into empty space measures against. */
const GROUND_PLANE = new Plane(new Vector3(0, 0, 1), 0);

/** What a measured point ended up snapping to, if anything. */
export type SnapKind = 'vertex' | 'edge' | 'grid' | 'surface';

export interface Measurement {
  /** The clicked point, in model space. */
  point: Vector3;
  /** What the point was snapped to, so the reading can be trusted or not. */
  snap: SnapKind;
  /** Distance from the previous measurement, if there is one. */
  distance?: number;
  delta?: Vector3;
}

export interface ViewportCallbacks {
  onMeasure(measurement: Measurement | null): void;
  /**
   * Fired whenever the camera moves, by drag or by command.
   *
   * Without it the `$vp*` readout only refreshed while the pointer happened to
   * be moving over the canvas, so it went stale the moment a button or the view
   * cube changed the view — exactly when you would look at it.
   */
  onCamera?(): void;
}

/** Reads a CSS custom property, so the viewport follows the app theme. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export class Viewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  readonly controls: OrbitCamera;

  private readonly modelGroup = new Group();
  private readonly annotationGroup = new Group();
  /**
   * 2D outlines, kept apart from the model.
   *
   * A scene can hold both: `dimensionOf` calls a mixed one 3D because that is
   * what can be exported, but the flat parts are still geometry the author
   * wrote and still want looking at. Sharing `modelGroup` made the two setters
   * clear each other, so whichever ran second won.
   */
  private readonly contourGroup = new Group();
  private readonly helperGroup = new Group();
  private readonly measureGroup = new Group();

  private grid?: GridHelper;
  private axes?: LineSegments;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  private readonly gizmo: ViewGizmo;
  /** Live press on the view cube, until it resolves into a snap or an orbit. */
  private gizmoDrag?: { pointerId: number; view: StandardView; x: number; y: number; moved: boolean };
  /**
   * Set when a gesture belonged to the view cube, so the `click` that trails it
   * does not also land in the measurement tool. Cleared by any press that is
   * not on the cube, so it can never go stale in browsers that suppress the
   * compatibility click after `preventDefault()` on pointerdown.
   */
  private gizmoHandledClick = false;
  private needsRender = true;
  /** The viewport's gradient background, disposed when the theme changes. */
  private backdrop?: CanvasTexture;
  /** True with no document open: helpers and the view cube are not drawn. */
  private empty = false;
  private disposed = false;
  private resizeObserver?: ResizeObserver;

  private measurePoints: Vector3[] = [];
  /** What each measured point snapped to, parallel to `measurePoints`. */
  private measureSnaps: SnapKind[] = [];
  measuring = false;
  showGrid = true;
  showAxes = true;
  showEdges = false;

  private lastBounds: { min: Vector3; max: Vector3 } | null = null;
  /** The two halves of `lastBounds`, kept apart because they arrive apart. */
  private meshBounds: { min: Vector3; max: Vector3 } | null = null;
  private contourBounds: { min: Vector3; max: Vector3 } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ViewportCallbacks,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      // `preserveDrawingBuffer` is what makes screenshots and GIF export
      // possible (spec feature 20); without it the canvas reads back blank.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(45, 1, 0.1, 10_000);
    this.controls = new OrbitCamera(this.camera, this.renderer.domElement, {
      onChange: () => {
        this.invalidate();
        this.callbacks.onCamera?.();
      },
    });

    this.gizmo = new ViewGizmo((view) => this.setView(view));

    this.scene.add(
      this.modelGroup,
      this.annotationGroup,
      this.contourGroup,
      this.helperGroup,
      this.measureGroup,
    );
    this.setupLights();
    this.rebuildHelpers();
    this.applyTheme();

    this.renderer.domElement.addEventListener('click', this.onClick);
    // Capture phase, so a press on the gizmo never also starts an orbit drag.
    this.renderer.domElement.addEventListener('pointerdown', this.onGizmoPointerDown, true);
    this.renderer.domElement.addEventListener('pointermove', this.onGizmoPointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.onGizmoPointerUp, true);
    this.renderer.domElement.addEventListener('pointercancel', this.onGizmoPointerUp, true);
    this.renderer.domElement.addEventListener('pointerleave', this.onGizmoPointerLeave);
    this.observeResize();
    this.loop();
  }

  // -- lifecycle ------------------------------------------------------------

  private setupLights(): void {
    // Low ambient on purpose. Enough of it and every face receives the same
    // light, which is exactly the information a CAD preview exists to show —
    // the model turns into a flat silhouette of its own colour, and a chamfer
    // becomes indistinguishable from a painted line.
    this.scene.add(new AmbientLight(0xffffff, 0.55));

    // Three keys, deliberately not attached to the camera: fixed lighting makes
    // it far easier to judge a shape's form while orbiting around it.
    const key = new DirectionalLight(0xffffff, 2);
    key.position.set(1, 0.6, 1.4);
    const fill = new DirectionalLight(0xffffff, 0.55);
    fill.position.set(-1.2, -0.4, 0.6);
    const rim = new DirectionalLight(0xffffff, 0.45);
    rim.position.set(0, 1, -1);
    this.scene.add(key, fill, rim);
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate(): void {
    this.needsRender = true;
  }

  private loop = (): void => {
    if (this.disposed) return;
    // A running view transition needs a frame per step; `update` reports when
    // it still has work, which keeps the render-on-demand model intact.
    if (this.controls.update()) this.needsRender = true;

    if (this.needsRender) {
      this.needsRender = false;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      // CSS pixels: the renderer applies its own pixel ratio.
      this.renderer.setViewport(0, 0, width, height);
      this.renderer.render(this.scene, this.camera);
      if (!this.empty) this.gizmo.render(this.renderer, this.controls.orientation, width, height);
    }
    requestAnimationFrame(this.loop);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.domElement.removeEventListener('click', this.onClick);
    this.renderer.domElement.removeEventListener('pointerdown', this.onGizmoPointerDown, true);
    this.renderer.domElement.removeEventListener('pointermove', this.onGizmoPointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.onGizmoPointerUp, true);
    this.renderer.domElement.removeEventListener('pointercancel', this.onGizmoPointerUp, true);
    this.renderer.domElement.removeEventListener('pointerleave', this.onGizmoPointerLeave);
    this.gizmo.dispose();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);
    this.clearGroup(this.contourGroup);
    this.clearGroup(this.measureGroup);
    this.clearGroup(this.helperGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // -- theme ----------------------------------------------------------------

  /**
   * A radial wash instead of a flat fill.
   *
   * The model sits in the middle of the viewport, and a pool of slightly
   * lighter ground beneath it separates silhouette from background without a
   * border, a panel or an outline. Flat dark reads as a hole punched in the
   * app; this reads as a room.
   *
   * A texture rather than a real gradient mesh: it costs one 2D canvas at theme
   * changes and nothing per frame, and three stretches it to any aspect ratio
   * on its own.
   */
  private buildBackdrop(): CanvasTexture {
    const base = token('--bs-viewport-bg', '#0e0c0b');
    const lift = token('--bs-viewport-glow', '#241d19');

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    // Centred a little above the middle, where the model's mass usually sits.
    const gradient = ctx.createRadialGradient(size / 2, size * 0.46, 0, size / 2, size * 0.46, size * 0.62);
    gradient.addColorStop(0, lift);
    gradient.addColorStop(1, base);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.backdrop?.dispose();
    this.backdrop = texture;
    return texture;
  }

  applyTheme(): void {
    this.scene.background = this.buildBackdrop();
    this.rebuildHelpers();
    this.gizmo?.refreshTheme();
    this.invalidate();
  }

  // -- content --------------------------------------------------------------

  setModel(
    meshes: MeshPayload[],
    annotations: MeshPayload[],
    bounds: { min: [number, number, number]; max: [number, number, number] } | null,
  ): void {
    this.featureEdges = undefined;
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);

    for (const payload of meshes) this.modelGroup.add(this.buildMesh(payload));
    for (const payload of annotations) this.annotationGroup.add(this.buildMesh(payload));

    this.meshBounds = bounds
      ? { min: new Vector3(...bounds.min), max: new Vector3(...bounds.max) }
      : null;
    this.updateBounds();
  }

  /**
   * Empties the viewport without touching the camera.
   *
   * Used on a tab switch: leaving the previous model on screen while the next
   * one renders means watching the wrong part move to the new tab's camera.
   */
  clearModel(): void {
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);
    this.clearGroup(this.contourGroup);
    this.meshBounds = null;
    this.contourBounds = null;
    this.lastBounds = null;
    this.invalidate();
  }

  /** Draws a 2D result as flat outlines on the XY plane. */
  setContours(contours: { points: Float32Array; color: [number, number, number, number] }[]): void {
    this.clearGroup(this.contourGroup);

    const min = new Vector3(Infinity, Infinity, 0);
    const max = new Vector3(-Infinity, -Infinity, 0);

    for (const contour of contours) {
      const count = contour.points.length / 2;
      if (count < 2) continue;
      // Close the loop by repeating the first point.
      const positions = new Float32Array((count + 1) * 3);
      for (let i = 0; i <= count; i++) {
        const source = (i % count) * 2;
        const x = contour.points[source];
        const y = contour.points[source + 1];
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = 0;
        min.x = Math.min(min.x, x);
        min.y = Math.min(min.y, y);
        max.x = Math.max(max.x, x);
        max.y = Math.max(max.y, y);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const material = new LineBasicMaterial({
        color: new Color(contour.color[0], contour.color[1], contour.color[2]),
      });
      this.contourGroup.add(new Line(geometry, material));
    }

    this.contourBounds = Number.isFinite(min.x) ? { min, max } : null;
    this.updateBounds();
  }

  /**
   * The framed extent is whatever is on screen, meshes and outlines together.
   *
   * Each half reports its own, because they arrive in separate messages and
   * either can be empty. Fitting to only one of them would leave the other
   * hanging off the edge of a scene it is genuinely part of.
   */
  private updateBounds(): void {
    const halves = [this.meshBounds, this.contourBounds].filter(
      (b): b is { min: Vector3; max: Vector3 } => b !== null,
    );
    if (halves.length === 0) {
      this.lastBounds = null;
      this.invalidate();
      return;
    }
    const min = halves[0].min.clone();
    const max = halves[0].max.clone();
    for (const half of halves.slice(1)) {
      min.min(half.min);
      max.max(half.max);
    }
    this.lastBounds = { min, max };
    this.scaleHelpersTo(this.lastBounds);
    this.invalidate();
  }

  private buildMesh(payload: MeshPayload): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(payload.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(payload.normals, 3));
    geometry.setIndex(new BufferAttribute(payload.indices, 1));
    geometry.computeBoundingSphere();

    const [r, g, b, a] = payload.color;
    const highlight = payload.display === 'highlight';
    const transparent = payload.display === 'transparent';
    // Both are overlays laid over the model rather than part of it, so both
    // stay out of the depth buffer and draw last. `#` is the more assertive of
    // the two — it is answering "where is this?" — so it is the less sheer.
    const overlay = highlight || transparent;

    const material = new MeshStandardMaterial({
      color: highlight ? new Color(token('--bs-cut-300', '#5cd3e0')) : new Color(r, g, b),
      roughness: 0.62,
      metalness: 0.04,
      flatShading: false,
      // `%` and `#` geometry are references, so neither may occlude the model.
      transparent: overlay || a < 1,
      opacity: transparent ? 0.22 : highlight ? 0.45 : a,
      depthWrite: !overlay,
      // 2D-derived and imported meshes can have inconsistent winding; drawing
      // both sides avoids confusing black holes in the preview.
      side: DoubleSide,
    });

    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = overlay ? 1 : 0;
    return mesh;
  }

  private clearGroup(group: Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      const withGeometry = child as Partial<Mesh>;
      withGeometry.geometry?.dispose();
      const material = withGeometry.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    }
  }

  // -- helpers --------------------------------------------------------------

  private rebuildHelpers(): void {
    this.clearGroup(this.helperGroup);
    if (this.empty) return;
    const size = this.helperSize;

    if (this.showGrid) {
      const divisions = 20;
      const gridColor = new Color(token('--bs-viewport-grid', '#2b2522'));
      this.grid = new GridHelper(size * 2, divisions, gridColor, gridColor);
      // GridHelper is built on the XZ plane; OpenSCAD's ground plane is XY.
      this.grid.rotation.x = Math.PI / 2;
      const material = this.grid.material as LineBasicMaterial;
      material.transparent = true;
      material.opacity = 0.6;
      this.helperGroup.add(this.grid);
    }

    if (this.showAxes) {
      const length = size;
      const positions = new Float32Array([
        0, 0, 0, length, 0, 0,
        0, 0, 0, 0, length, 0,
        0, 0, 0, 0, 0, length,
      ]);
      const colors = new Float32Array(18);
      const axisColors = [
        new Color(token('--bs-viewport-axis-x', '#d64545')),
        new Color(token('--bs-viewport-axis-y', '#2f9e63')),
        new Color(token('--bs-viewport-axis-z', '#3b82f6')),
      ];
      for (let axis = 0; axis < 3; axis++) {
        for (let vertex = 0; vertex < 2; vertex++) {
          const offset = axis * 6 + vertex * 3;
          colors[offset] = axisColors[axis].r;
          colors[offset + 1] = axisColors[axis].g;
          colors[offset + 2] = axisColors[axis].b;
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('color', new BufferAttribute(colors, 3));
      this.axes = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true }));
      this.helperGroup.add(this.axes);
    }

    this.invalidate();
  }

  private helperSize = 50;
  /**
   * Model edges worth snapping to, as flat [ax,ay,az, bx,by,bz, …] world-space
   * segments. Built on first use and dropped when the model changes — measuring
   * is off by default, so a file nobody measures never pays for this.
   */
  private featureEdges?: Float32Array;

  /** Keeps the grid and axes proportionate to whatever is on screen. */
  private scaleHelpersTo(bounds: { min: Vector3; max: Vector3 }): void {
    const extent = new Vector3().subVectors(bounds.max, bounds.min);
    const largest = Math.max(extent.x, extent.y, extent.z, 1);
    // Snap to a power-of-ten-ish step so grid lines land on round numbers.
    const magnitude = Math.pow(10, Math.floor(Math.log10(largest)));
    const size = Math.max(magnitude * Math.ceil(largest / magnitude), 10);
    if (Math.abs(size - this.helperSize) < 1e-9) return;
    this.helperSize = size;
    this.rebuildHelpers();
  }

  setHelperVisibility(options: { grid?: boolean; axes?: boolean }): void {
    if (options.grid !== undefined) this.showGrid = options.grid;
    if (options.axes !== undefined) this.showAxes = options.axes;
    this.rebuildHelpers();
  }

  /**
   * With no document open, the viewport shows nothing at all.
   *
   * Not even the grid and the view cube: a lit, gridded stage with no model on
   * it looks like a render that failed, where an empty one plainly has nothing
   * in it. The user's own grid and axes preferences are untouched — this only
   * suppresses drawing them.
   */
  setEmpty(empty: boolean): void {
    if (this.empty === empty) return;
    this.empty = empty;
    this.rebuildHelpers();
    this.invalidate();
  }

  // -- framing --------------------------------------------------------------

  frameAll(): void {
    if (this.lastBounds) {
      this.controls.frame(this.lastBounds.min, this.lastBounds.max);
    } else {
      this.controls.frame(new Vector3(-25, -25, -25), new Vector3(25, 25, 25));
    }
  }

  setView(view: StandardView): void {
    this.controls.setStandardView(view);
  }

  get cameraState(): CameraState {
    return this.controls.snapshot();
  }

  restoreCamera(state: CameraState): void {
    this.controls.restore(state);
  }

  /**
   * The view a model gets the first time it is shown: isometric, fitted.
   *
   * Not animated — there is no previous view to explain the movement from, so a
   * transition would just be a lurch on open.
   */
  applyInitialView(): void {
    this.controls.setStandardView('iso', false);
    this.frameAll();
  }

  // -- gizmo input ----------------------------------------------------------

  private gizmoPick(event: PointerEvent): StandardView | undefined {
    if (this.empty) return undefined;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return this.gizmo.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    );
  }

  /**
   * Press on the cube: the start of either a snap or an orbit.
   *
   * Which one it is cannot be known yet, so the press is claimed and the
   * decision deferred to pointerup — under the slop threshold it was a click
   * and snaps, over it the cube was being dragged and has already orbited.
   * A cube that only snaps is a cube you cannot use to look at anything the
   * six named views do not already show.
   */
  private onGizmoPointerDown = (event: PointerEvent): void => {
    // One press at a time: a second finger landing on the cube would replace
    // the first one's state and strand its pointer capture.
    if (this.gizmoDrag || this.empty) return;
    const view = this.gizmoPick(event);
    if (!view) {
      this.gizmoHandledClick = false;
      return;
    }
    // Claim the press outright: the viewport's own orbit must not also start,
    // and the capture-phase stop is what prevents it.
    event.stopPropagation();
    event.preventDefault();

    this.gizmoDrag = { pointerId: event.pointerId, view, x: event.clientX, y: event.clientY, moved: false };
    // Captured so the drag survives leaving the cube — which it does almost
    // immediately, the gizmo being 104px across.
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private onGizmoPointerMove = (event: PointerEvent): void => {
    const drag = this.gizmoDrag;
    if (drag && event.pointerId === drag.pointerId) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;

      if (!drag.moved && Math.hypot(dx, dy) > GIZMO_DRAG_SLOP) {
        drag.moved = true;
        // Stop highlighting a face: past this point the cube is a handle, and
        // the faces spinning under the pointer are not targets.
        if (this.gizmo.setHovered(undefined)) this.invalidate();
      }
      if (drag.moved) this.controls.orbitBy(dx, dy);
      return;
    }

    const view = this.gizmoPick(event);
    // Suspending the controls also stops the wheel zooming while the pointer
    // is over the cube, which otherwise feels like the model jumped.
    this.controls.suspended = view !== undefined;
    this.renderer.domElement.style.cursor = view ? 'pointer' : this.measuring ? 'crosshair' : '';
    if (this.gizmo.setHovered(view)) this.invalidate();
  };

  private onGizmoPointerUp = (event: PointerEvent): void => {
    const drag = this.gizmoDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.gizmoDrag = undefined;
    this.gizmoHandledClick = true;

    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    // A press that never moved was a click on that face.
    if (!drag.moved) this.setView(drag.view);

    // The cube has turned under the pointer, so hover has to be re-read from
    // where the pointer actually ended up rather than left as it was.
    const view = this.gizmoPick(event);
    this.controls.suspended = view !== undefined;
    this.renderer.domElement.style.cursor = view ? 'pointer' : this.measuring ? 'crosshair' : '';
    if (this.gizmo.setHovered(view)) this.invalidate();
  };

  private onGizmoPointerLeave = (): void => {
    // Mid-drag the pointer is captured, so leaving the canvas is not the end of
    // anything; clearing state here would strand the drag.
    if (this.gizmoDrag) return;
    this.controls.suspended = false;
    if (this.gizmo.setHovered(undefined)) this.invalidate();
  };

  // -- measurement (spec feature 19) ----------------------------------------

  setMeasuring(active: boolean): void {
    this.measuring = active;
    if (!active) this.clearMeasurements();
    this.renderer.domElement.style.cursor = active ? 'crosshair' : '';
  }

  clearMeasurements(): void {
    this.measurePoints = [];
    this.measureSnaps = [];
    this.clearGroup(this.measureGroup);
    this.callbacks.onMeasure(null);
    this.invalidate();
  }

  private onClick = (event: MouseEvent): void => {
    // A gesture the cube already consumed — a snap, or an orbit that happened
    // to end over the model — must not also drop a measurement point.
    if (this.gizmoHandledClick) {
      this.gizmoHandledClick = false;
      return;
    }
    if (!this.measuring) return;
    // A click that landed on the gizmo has already been handled as a view change.
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    if (
      this.gizmo.pick(
        event.clientX - canvasRect.left,
        event.clientY - canvasRect.top,
        canvasRect.width,
        canvasRect.height,
      )
    ) {
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Outlines stay pickable: they used to live in `modelGroup`, and measuring
    // against a flat part is the whole point of drawing it.
    const hits = this.raycaster.intersectObjects(
      [...this.modelGroup.children, ...this.contourGroup.children],
      true,
    );
    const snapped = hits.length > 0 ? this.snap(hits[0]) : this.snapToGroundGrid();
    if (!snapped) return;

    this.measurePoints.push(snapped.point);
    this.measureSnaps.push(snapped.kind);
    if (this.measurePoints.length > 2) {
      this.measurePoints = [snapped.point];
      this.measureSnaps = [snapped.kind];
    }

    this.drawMeasurement();

    const [a, b] = this.measurePoints;
    this.callbacks.onMeasure(
      b
        ? {
            point: b,
            snap: this.measureSnaps[1],
            distance: a.distanceTo(b),
            delta: new Vector3().subVectors(b, a),
          }
        : { point: a, snap: this.measureSnaps[0] },
    );
  };

  /**
   * How far, in world units, a pixel covers at a given depth.
   *
   * Snap tolerances are quoted in pixels so they feel the same zoomed in or
   * out: a radius fixed in model units is either unusable up close or grabs
   * half the part from far away.
   */
  private worldPerPixel(depth: number): number {
    const height = this.renderer.domElement.clientHeight || 1;
    return (2 * depth * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
  }

  /**
   * Chooses what a click on the model actually measures.
   *
   * Ordered by how specific the feature is — a corner beats an edge beats the
   * bare surface — because the more specific one is nearly always what someone
   * aiming near it meant. Each has its own pixel radius: corners grab from
   * furthest away, being the most useful and the hardest to hit exactly.
   */
  private snap(hit: Intersection): { point: Vector3; kind: SnapKind } | undefined {
    const surface = hit.point.clone();
    const scale = this.worldPerPixel(hit.distance);
    const mesh = hit.object as Mesh;

    const vertex = this.nearestVertex(mesh, surface, hit.face);
    if (vertex && vertex.distanceTo(surface) < SNAP_VERTEX_PX * scale) {
      return { point: vertex, kind: 'vertex' };
    }

    const edge = this.nearestFeatureEdgePoint(surface, SNAP_EDGE_PX * scale);
    if (edge) return { point: edge, kind: 'edge' };

    return { point: surface, kind: 'surface' };
  }

  /**
   * A point on the ground plane when the ray misses the model.
   *
   * Measuring against the grid — an offset from the origin, a clearance — is
   * half of what the tool is for, and before this a click into empty space
   * simply did nothing.
   */
  private snapToGroundGrid(): { point: Vector3; kind: SnapKind } | undefined {
    const target = new Vector3();
    if (!this.raycaster.ray.intersectPlane(GROUND_PLANE, target)) return undefined;

    const step = this.gridStep();
    return {
      point: new Vector3(Math.round(target.x / step) * step, Math.round(target.y / step) * step, 0),
      kind: 'grid',
    };
  }

  /** The spacing of one grid square, matching what `rebuildHelpers` draws. */
  private gridStep(): number {
    return (this.helperSize * 2) / GRID_DIVISIONS;
  }

  private nearestVertex(mesh: Mesh, point: Vector3, face: Intersection['face']): Vector3 | undefined {
    if (!face) return undefined;
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) return undefined;

    let best: Vector3 | undefined;
    let bestDistance = Infinity;
    for (const index of [face.a, face.b, face.c]) {
      const vertex = new Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index),
      ).applyMatrix4(mesh.matrixWorld);
      const distance = vertex.distanceTo(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    return best;
  }

  /** The closest point on any feature edge, if one is within `radius`. */
  private nearestFeatureEdgePoint(point: Vector3, radius: number): Vector3 | undefined {
    const edges = this.ensureFeatureEdges();
    if (edges.length === 0) return undefined;

    const a = new Vector3();
    const b = new Vector3();
    const ab = new Vector3();
    const ap = new Vector3();
    const candidate = new Vector3();

    let best: Vector3 | undefined;
    let bestDistance = radius;

    for (let i = 0; i < edges.length; i += 6) {
      a.set(edges[i], edges[i + 1], edges[i + 2]);
      b.set(edges[i + 3], edges[i + 4], edges[i + 5]);
      ab.subVectors(b, a);
      const lengthSq = ab.lengthSq();
      if (lengthSq < 1e-12) continue;

      // Clamped projection: the nearest point on the segment, not on the
      // infinite line it lies along.
      ap.subVectors(point, a);
      const t = Math.min(1, Math.max(0, ap.dot(ab) / lengthSq));
      candidate.copy(a).addScaledVector(ab, t);

      const distance = candidate.distanceTo(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate.clone();
      }
    }
    return best;
  }

  /**
   * The model's real edges, built once per model.
   *
   * Every triangle edge is not an edge of the *shape*: a flat face is two
   * triangles with a diagonal through it, and snapping to that diagonal would
   * drop a point in the middle of a flat surface. So edges are kept only where
   * the two faces meeting along them actually turn — or where there is only one
   * face, which is a boundary.
   *
   * Positions are quantised into the key so the two triangles either side of an
   * edge agree on it despite float noise.
   */
  private ensureFeatureEdges(): Float32Array {
    if (this.featureEdges) return this.featureEdges;

    const edges = new Map<string, { a: Vector3; b: Vector3; normals: Vector3[] }>();
    const key = (p: Vector3): string =>
      `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;

    for (const child of this.modelGroup.children) {
      const mesh = child as Mesh;
      const positions = mesh.geometry?.getAttribute('position');
      const index = mesh.geometry?.getIndex();
      if (!positions || !index) continue;

      const corner = (i: number): Vector3 =>
        new Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)).applyMatrix4(
          mesh.matrixWorld,
        );

      for (let t = 0; t < index.count; t += 3) {
        const p = [corner(index.getX(t)), corner(index.getX(t + 1)), corner(index.getX(t + 2))];
        const normal = new Vector3()
          .subVectors(p[1], p[0])
          .cross(new Vector3().subVectors(p[2], p[0]))
          .normalize();

        for (let e = 0; e < 3; e++) {
          const a = p[e];
          const b = p[(e + 1) % 3];
          const ka = key(a);
          const kb = key(b);
          const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const existing = edges.get(id);
          if (existing) existing.normals.push(normal);
          else edges.set(id, { a, b, normals: [normal] });
        }
      }
    }

    const kept: number[] = [];
    for (const { a, b, normals } of edges.values()) {
      const isFeature =
        normals.length === 1 ||
        normals.some((n) => n.dot(normals[0]) < FEATURE_EDGE_COS);
      if (!isFeature) continue;
      kept.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }

    this.featureEdges = new Float32Array(kept);
    return this.featureEdges;
  }

  private drawMeasurement(): void {
    this.clearGroup(this.measureGroup);
    const markerRadius = this.controls.distance * 0.006;

    for (const point of this.measurePoints) {
      const marker = new Mesh(
        new SphereGeometry(markerRadius, 12, 8),
        new MeshStandardMaterial({
          color: new Color(token('--bs-cut-300', '#5cd3e0')),
          emissive: new Color(token('--bs-cut-300', '#5cd3e0')),
          emissiveIntensity: 0.6,
          depthTest: false,
        }),
      );
      marker.position.copy(point);
      marker.renderOrder = 10;
      this.measureGroup.add(marker);
    }

    if (this.measurePoints.length === 2) {
      const geometry = new BufferGeometry().setFromPoints(this.measurePoints);
      const line = new Line(
        geometry,
        new LineBasicMaterial({
          color: new Color(token('--bs-cut-300', '#5cd3e0')),
          depthTest: false,
        }),
      );
      line.renderOrder = 10;
      this.measureGroup.add(line);
    }
    this.invalidate();
  }

  // -- capture (spec feature 20) --------------------------------------------

  /** Renders synchronously and returns the canvas contents as a PNG blob. */
  async capture(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => {
      this.renderer.domElement.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
}
