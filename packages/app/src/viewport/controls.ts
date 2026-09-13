/**
 * Orbit / pan / zoom camera controls (spec feature 5).
 *
 * Written directly rather than pulled from `three/examples`: the examples'
 * OrbitControls is not part of three's public API surface, and CAD navigation
 * wants specifics the generic version does not give — a target that follows the
 * model, zoom-to-cursor, and a clean way to snap to standard views.
 */

import { MathUtils, PerspectiveCamera, Spherical, Vector2, Vector3 } from 'three';

export interface ControlsOptions {
  onChange(): void;
}

const EPSILON = 1e-6;

export class OrbitCamera {
  readonly target = new Vector3();
  private readonly spherical = new Spherical(160, Math.PI / 3, Math.PI / 4);

  private pointers = new Map<number, Vector2>();
  private lastSingle = new Vector2();
  private lastPinchDistance = 0;
  private mode: 'none' | 'orbit' | 'pan' | 'zoom' = 'none';

  minDistance = 0.05;
  maxDistance = 100_000;
  rotateSpeed = 0.0045;
  panSpeed = 1;
  zoomSpeed = 0.0015;

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
    return this.spherical.radius;
  }

  /** Camera state in OpenSCAD's `$vp*` convention, for the script to read. */
  get viewportVariables(): { rotation: [number, number, number]; translation: [number, number, number]; distance: number } {
    // $vpr is [x, y, z] Euler degrees; the polar/azimuth pair maps onto x and z.
    const rx = MathUtils.radToDeg(this.spherical.phi);
    const rz = MathUtils.radToDeg(this.spherical.theta) - 90;
    return {
      rotation: [rx, 0, rz],
      translation: [this.target.x, this.target.y, this.target.z],
      distance: this.spherical.radius,
    };
  }

  apply(): void {
    this.spherical.radius = MathUtils.clamp(this.spherical.radius, this.minDistance, this.maxDistance);
    // Clamp just short of the poles; exactly at them the up vector is undefined
    // and the camera flips.
    this.spherical.phi = MathUtils.clamp(this.spherical.phi, EPSILON, Math.PI - EPSILON);
    this.spherical.makeSafe();

    const offset = new Vector3().setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.up.set(0, 0, 1); // Z-up, matching OpenSCAD
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.options.onChange();
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

    this.spherical.radius = distance * 1.12;
    this.camera.near = Math.max(distance / 5000, 0.01);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.apply();
  }

  /** Snaps to a named orthogonal view, keeping the current target and distance. */
  setStandardView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'): void {
    const angles: Record<string, [number, number]> = {
      // [theta (azimuth), phi (polar)] in radians
      front: [-Math.PI / 2, Math.PI / 2],
      back: [Math.PI / 2, Math.PI / 2],
      right: [0, Math.PI / 2],
      left: [Math.PI, Math.PI / 2],
      top: [-Math.PI / 2, EPSILON * 10],
      bottom: [-Math.PI / 2, Math.PI - EPSILON * 10],
      iso: [-Math.PI / 4, Math.PI / 3],
    };
    const [theta, phi] = angles[view];
    this.spherical.theta = theta;
    this.spherical.phi = phi;
    this.apply();
  }

  // -- input ----------------------------------------------------------------

  private onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent): void => {
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
        this.spherical.radius *= this.lastPinchDistance / Math.max(distance, 1);
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
      this.spherical.theta -= dx * this.rotateSpeed;
      this.spherical.phi -= dy * this.rotateSpeed;
      this.apply();
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
    event.preventDefault();
    // Line-mode deltas are ~1 per notch; normalise so both feel the same.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.spherical.radius *= Math.exp(delta * this.zoomSpeed);
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
      (2 * this.spherical.radius * Math.tan(MathUtils.degToRad(this.camera.fov) / 2)) / height;

    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);

    this.target
      .addScaledVector(right, -dx * worldPerPixel * this.panSpeed)
      .addScaledVector(up, dy * worldPerPixel * this.panSpeed);
    this.apply();
  }
}
