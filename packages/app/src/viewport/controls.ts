/**
 * Orbit / pan / zoom camera controls (spec feature 5).
 *
 * Written directly rather than pulled from `three/examples`: the examples'
 * OrbitControls is not part of three's public API surface, and CAD navigation
 * wants specifics the generic version does not give — a target that follows the
 * model, standard-view snapping, and a turntable whose axis is the model's own
 * up axis.
 *
 * **Z-up spherical.** Angles are computed here rather than with `THREE.Spherical`,
 * whose polar axis is +Y. OpenSCAD models are Z-up and the camera's up vector is
 * +Z, so a Y-polar parameterisation puts the orbit's poles on the horizon and,
 * worse, puts the degenerate "up is parallel to the view direction" point on the
 * orbit's equator — right where you drag through to look at the back of a model.
 */

import { MathUtils, PerspectiveCamera, Vector2, Vector3 } from 'three';

export interface ControlsOptions {
  onChange(): void;
}

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/**
 * A camera pose, in a form that survives JSON.
 *
 * Stored per document so each tab keeps the view it was left at: a camera that
 * fits one model is usually nonsense for the next, which is what makes
 * switching tabs without this feel broken.
 */
export interface CameraState {
  azimuth: number;
  polar: number;
  radius: number;
  target: [number, number, number];
}

/** Kept just inside the poles: exactly at one, `lookAt` has no defined roll. */
const POLAR_LIMIT = 1e-3;

/**
 * Camera positions for the named views, as (azimuth, polar) in radians.
 *
 * Azimuth is measured around +Z from the +X axis; polar from +Z. So `front`
 * places the camera on −Y looking toward +Y, which is what "front" means for a
 * Z-up model, and matches OpenSCAD's own `$vpr` for each view.
 */
const STANDARD_VIEWS: Record<StandardView, [number, number]> = {
  right: [0, Math.PI / 2],
  left: [Math.PI, Math.PI / 2],
  front: [-Math.PI / 2, Math.PI / 2],
  back: [Math.PI / 2, Math.PI / 2],
  top: [-Math.PI / 2, POLAR_LIMIT],
  bottom: [-Math.PI / 2, Math.PI - POLAR_LIMIT],
  iso: [-Math.PI / 4, Math.PI / 3],
};

export class OrbitCamera {
  readonly target = new Vector3();

  /** Azimuth around +Z, measured from +X. */
  private azimuth = -Math.PI / 4;
  /** Polar angle from +Z. */
  private polar = Math.PI / 3;
  private radius = 160;

  private pointers = new Map<number, Vector2>();
  private lastSingle = new Vector2();
  private lastPinchDistance = 0;
  private mode: 'none' | 'orbit' | 'pan' | 'zoom' = 'none';

  private animation?: { from: [number, number]; to: [number, number]; start: number; duration: number };

  minDistance = 0.05;
  maxDistance = 100_000;
  rotateSpeed = 0.0045;
  panSpeed = 1;
  zoomSpeed = 0.0015;

  /** Set while a gizmo owns the pointer, so the viewport does not also orbit. */
  suspended = false;

  constructor(
    readonly camera: PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly options: ControlsOptions,
  ) {
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.onContextMenu);
    this.apply();
  }

  dispose(): void {
    const el = this.element;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
  }

  // -- state ----------------------------------------------------------------

  get distance(): number {
    return this.radius;
  }

  /** Unit vector from the target toward the camera; drives the view gizmo. */
  get orientation(): Vector3 {
    return this.offsetFor(this.azimuth, this.polar).normalize();
  }

/**
   * The three world axes as they lie on screen, for the HUD's orientation
   * indicator.
   *
   * Orthographic on purpose — each unit axis projected onto the camera's own
   * right and up vectors, with nothing else. A perspective projection would
   * make an axis near the centre of the frame longer than one at the edge, and
   * an indicator whose arms change length as you pan is reporting something
   * other than direction.
   *
   * `y` already points down, which is the direction screens and SVG count in.
   * `towards` is how far the axis leans out of the screen, and is only used to
   * decide which arm draws over which.
   */
  get screenAxes(): { label: 'X' | 'Y' | 'Z'; x: number; y: number; towards: number }[] {
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    // Column 2 of a three camera's world matrix points *out* of the screen.
    const towards = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 2);

    const axes: { label: 'X' | 'Y' | 'Z'; v: Vector3 }[] = [
      { label: 'X', v: new Vector3(1, 0, 0) },
      { label: 'Y', v: new Vector3(0, 1, 0) },
      { label: 'Z', v: new Vector3(0, 0, 1) },
    ];
    return axes.map(({ label, v }) => ({
      label,
      x: v.dot(right),
      y: -v.dot(up),
      towards: v.dot(towards),
    }));
  }

  /**
   * Camera state in OpenSCAD's `$vp*` convention.
   *
   * With a Z-up orbit this is exact rather than approximate: `$vpr` is
   * `[polar, 0, azimuth + 90]` in degrees, which reproduces OpenSCAD's own
   * values — `[90, 0, 0]` for front, `[0, 0, 0]` for top, `[90, 0, 90]` for right.
   */
  get viewportVariables(): {
    rotation: [number, number, number];
    translation: [number, number, number];
    distance: number;
  } {
    return {
      rotation: [MathUtils.radToDeg(this.polar), 0, MathUtils.radToDeg(this.azimuth) + 90],
      translation: [this.target.x, this.target.y, this.target.z],
      distance: this.radius,
    };
  }

  private offsetFor(azimuth: number, polar: number): Vector3 {
    const sinPolar = Math.sin(polar);
    return new Vector3(
      this.radius * sinPolar * Math.cos(azimuth),
      this.radius * sinPolar * Math.sin(azimuth),
      this.radius * Math.cos(polar),
    );
  }

  apply(): void {
    this.radius = MathUtils.clamp(this.radius, this.minDistance, this.maxDistance);
    this.polar = MathUtils.clamp(this.polar, POLAR_LIMIT, Math.PI - POLAR_LIMIT);

    this.camera.up.set(0, 0, 1); // Z-up, matching OpenSCAD
    this.camera.position.copy(this.target).add(this.offsetFor(this.azimuth, this.polar));
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.options.onChange();
  }

  snapshot(): CameraState {
    return {
      azimuth: this.azimuth,
      polar: this.polar,
      radius: this.radius,
      target: [this.target.x, this.target.y, this.target.z],
    };
  }

  /**
   * Restores a pose. Clip planes are derived from the distance rather than
   * stored, so a restored view cannot inherit a near plane that no longer suits
   * the model it is looking at.
   */
  restore(state: CameraState): void {
    if (!Number.isFinite(state.radius) || state.radius <= 0) return;
    this.animation = undefined;
    this.azimuth = state.azimuth;
    this.polar = state.polar;
    this.radius = state.radius;
    this.target.set(...state.target);
    this.updateClipPlanes();
    this.apply();
  }

  private updateClipPlanes(): void {
    this.camera.near = Math.max(this.radius / 5000, 0.01);
    this.camera.far = this.radius * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Frames a bounding box, leaving a comfortable margin. */
  frame(min: Vector3, max: Vector3): void {
    const center = new Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new Vector3().subVectors(max, min);
    const radius = Math.max(size.length() / 2, 1);

    this.target.copy(center);
    const fov = MathUtils.degToRad(this.camera.fov);
    // Account for the horizontal field of view too, so wide models still fit.
    const horizontalFov = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    const distance = radius / Math.sin(Math.min(fov, horizontalFov) / 2);

    this.radius = distance * 1.12;
    this.updateClipPlanes();
    this.apply();
  }

  /**
   * Snaps to a named view, animated by default.
   *
   * The animation matters for orientation: jumping discontinuously between
   * views leaves you guessing which way the model turned, which is the whole
   * problem a view gizmo exists to solve.
   */
  setStandardView(view: StandardView, animate = true): void {
    const [azimuth, polar] = STANDARD_VIEWS[view];
    // Take the shortest way round, so snapping never spins the long way.
    const target = this.azimuth + shortestAngle(this.azimuth, azimuth);
    if (!animate) {
      this.azimuth = target;
      this.polar = polar;
      this.animation = undefined;
      this.apply();
      return;
    }
    this.animation = {
      from: [this.azimuth, this.polar],
      to: [target, polar],
      start: performance.now(),
      duration: 280,
    };
  }

  /**
   * Orbits by a screen-space drag, in pixels.
   *
   * Public so the view gizmo can drive the same orbit the viewport does: a cube
   * you can only click is a worse cube, and duplicating the angle maths behind
   * it is how the two drift apart.
   */
  orbitBy(dx: number, dy: number): void {
    // A drag always wins over a running transition; without this, grabbing the
    // cube mid-snap fights the animation for the next few frames.
    this.animation = undefined;
    // Dragging right turns the model right; dragging down lifts the eye, as in
    // every orbit control people will already have used.
    this.azimuth -= dx * this.rotateSpeed;
    this.polar -= dy * this.rotateSpeed;
    this.apply();
  }

  /** Advances a running view transition. Returns true while more frames are needed. */
  update(): boolean {
    if (!this.animation) return false;
    const { from, to, start, duration } = this.animation;
    const t = Math.min(1, (performance.now() - start) / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    this.azimuth = from[0] + (to[0] - from[0]) * eased;
    this.polar = from[1] + (to[1] - from[1]) * eased;
    if (t >= 1) this.animation = undefined;
    this.apply();
    return this.animation !== undefined;
  }

  // -- input ----------------------------------------------------------------

  private onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (this.suspended) return;
    this.animation = undefined; // a drag always wins over a running transition
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));

    if (this.pointers.size === 1) {
      this.lastSingle.set(event.clientX, event.clientY);
      // Middle/right drag pans, as in every other CAD tool; shift-drag too, for
      // trackpads with no middle button.
      this.mode = event.button === 0 && !event.shiftKey ? 'orbit' : 'pan';
    } else if (this.pointers.size === 2) {
      this.mode = 'zoom';
      this.lastPinchDistance = this.pinchDistance();
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, new Vector2(event.clientX, event.clientY));

    if (this.mode === 'zoom' && this.pointers.size === 2) {
      const distance = this.pinchDistance();
      if (this.lastPinchDistance > 0) {
        this.radius *= this.lastPinchDistance / Math.max(distance, 1);
      }
      this.lastPinchDistance = distance;
      this.apply();
      return;
    }

    if (this.pointers.size !== 1) return;
    const dx = event.clientX - this.lastSingle.x;
    const dy = event.clientY - this.lastSingle.y;
    this.lastSingle.set(event.clientX, event.clientY);

    if (this.mode === 'orbit') {
      this.orbitBy(dx, dy);
    } else if (this.mode === 'pan') {
      this.panBy(dx, dy);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    if (this.pointers.size === 0) this.mode = 'none';
    else if (this.pointers.size === 1) {
      const [remaining] = [...this.pointers.values()];
      this.lastSingle.copy(remaining);
      this.mode = 'orbit';
    }
  };

  private onWheel = (event: WheelEvent): void => {
    if (this.suspended) return;
    event.preventDefault();
    // Line-mode deltas are ~1 per notch; normalise so both feel the same.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.radius *= Math.exp(delta * this.zoomSpeed);
    this.apply();
  };

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? a.distanceTo(b) : 0;
  }

  /**
   * Pans the target in the camera's screen plane.
   *
   * Scaled by the distance and field of view so a drag moves the model by the
   * same number of pixels regardless of zoom level.
   */
  private panBy(dx: number, dy: number): void {
    const height = this.element.clientHeight || 1;
    const worldPerPixel =
      (2 * this.radius * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)) / height;

    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);

    this.target
      .addScaledVector(right, -dx * worldPerPixel * this.panSpeed)
      .addScaledVector(up, dy * worldPerPixel * this.panSpeed);
    this.apply();
  }
}

/** Signed angle from `a` to `b`, wrapped into (-PI, PI]. */
function shortestAngle(a: number, b: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}
