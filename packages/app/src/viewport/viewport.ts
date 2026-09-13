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
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { MeshPayload } from '../render/protocol.js';
import { OrbitCamera, type StandardView } from './controls.js';
import { ViewGizmo } from './view-gizmo.js';

export interface Measurement {
  /** The clicked point, in model space. */
  point: Vector3;
  /** Distance from the previous measurement, if there is one. */
  distance?: number;
  delta?: Vector3;
}

export interface ViewportCallbacks {
  onMeasure(measurement: Measurement | null): void;
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
  private readonly helperGroup = new Group();
  private readonly measureGroup = new Group();

  private grid?: GridHelper;
  private axes?: LineSegments;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  private readonly gizmo: ViewGizmo;
  private needsRender = true;
  private disposed = false;
  private resizeObserver?: ResizeObserver;

  private measurePoints: Vector3[] = [];
  measuring = false;
  showGrid = true;
  showAxes = true;
  showEdges = false;

  private lastBounds: { min: Vector3; max: Vector3 } | null = null;

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
      onChange: () => this.invalidate(),
    });

    this.gizmo = new ViewGizmo((view) => this.setView(view));

    this.scene.add(this.modelGroup, this.annotationGroup, this.helperGroup, this.measureGroup);
    this.setupLights();
    this.rebuildHelpers();
    this.applyTheme();

    this.renderer.domElement.addEventListener('click', this.onClick);
    // Capture phase, so a press on the gizmo never also starts an orbit drag.
    this.renderer.domElement.addEventListener('pointerdown', this.onGizmoPointerDown, true);
    this.renderer.domElement.addEventListener('pointermove', this.onGizmoPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onGizmoPointerLeave);
    this.observeResize();
    this.loop();
  }

  // -- lifecycle ------------------------------------------------------------

  private setupLights(): void {
    this.scene.add(new AmbientLight(0xffffff, 1.6));

    // Three keys, deliberately not attached to the camera: fixed lighting makes
    // it far easier to judge a shape's form while orbiting around it.
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(1, 0.6, 1.4);
    const fill = new DirectionalLight(0xffffff, 0.9);
    fill.position.set(-1.2, -0.4, 0.6);
    const rim = new DirectionalLight(0xffffff, 0.6);
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
      this.gizmo.render(this.renderer, this.controls.orientation, width, height);
    }
    requestAnimationFrame(this.loop);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.domElement.removeEventListener('click', this.onClick);
    this.renderer.domElement.removeEventListener('pointerdown', this.onGizmoPointerDown, true);
    this.renderer.domElement.removeEventListener('pointermove', this.onGizmoPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onGizmoPointerLeave);
    this.gizmo.dispose();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);
    this.clearGroup(this.measureGroup);
    this.clearGroup(this.helperGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // -- theme ----------------------------------------------------------------

  applyTheme(): void {
    this.scene.background = new Color(token('--bs-viewport-bg', '#12181f'));
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
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);

    for (const payload of meshes) this.modelGroup.add(this.buildMesh(payload));
    for (const payload of annotations) this.annotationGroup.add(this.buildMesh(payload));

    this.lastBounds = bounds
      ? { min: new Vector3(...bounds.min), max: new Vector3(...bounds.max) }
      : null;

    if (this.lastBounds) this.scaleHelpersTo(this.lastBounds);
    this.invalidate();
  }

  /** Draws a 2D result as flat outlines on the XY plane. */
  setContours(contours: { points: Float32Array; color: [number, number, number, number] }[]): void {
    this.clearGroup(this.modelGroup);
    this.clearGroup(this.annotationGroup);

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
      this.modelGroup.add(new Line(geometry, material));
    }

    this.lastBounds = Number.isFinite(min.x) ? { min, max } : null;
    if (this.lastBounds) this.scaleHelpersTo(this.lastBounds);
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

    const material = new MeshStandardMaterial({
      color: highlight ? new Color(token('--bs-cut-300', '#5fe3f7')) : new Color(r, g, b),
      roughness: 0.62,
      metalness: 0.04,
      flatShading: false,
      // `%`-role geometry is a reference, so it must not occlude the model.
      transparent: transparent || a < 1,
      opacity: transparent ? 0.22 : a,
      depthWrite: !transparent,
      // 2D-derived and imported meshes can have inconsistent winding; drawing
      // both sides avoids confusing black holes in the preview.
      side: DoubleSide,
    });

    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = transparent ? 1 : 0;
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
    const size = this.helperSize;

    if (this.showGrid) {
      const divisions = 20;
      const gridColor = new Color(token('--bs-viewport-grid', '#232d38'));
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

  // -- gizmo input ----------------------------------------------------------

  private gizmoPick(event: PointerEvent): StandardView | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return this.gizmo.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    );
  }

  private onGizmoPointerDown = (event: PointerEvent): void => {
    const view = this.gizmoPick(event);
    if (!view) return;
    // Claim the press outright: orbiting from inside the cube would be a
    // surprise, and the capture-phase stop is what prevents it.
    event.stopPropagation();
    event.preventDefault();
    this.setView(view);
  };

  private onGizmoPointerMove = (event: PointerEvent): void => {
    const view = this.gizmoPick(event);
    // Suspending the controls also stops the wheel zooming while the pointer
    // is over the cube, which otherwise feels like the model jumped.
    this.controls.suspended = view !== undefined;
    this.renderer.domElement.style.cursor = view ? 'pointer' : this.measuring ? 'crosshair' : '';
    if (this.gizmo.setHovered(view)) this.invalidate();
  };

  private onGizmoPointerLeave = (): void => {
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
    this.clearGroup(this.measureGroup);
    this.callbacks.onMeasure(null);
    this.invalidate();
  }

  private onClick = (event: MouseEvent): void => {
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

    const hits = this.raycaster.intersectObjects(this.modelGroup.children, true);
    if (hits.length === 0) return;

    // Snap to the nearest vertex of the hit triangle when the cursor is close
    // to one; picking exact corners is what measurement is usually for.
    const hit = hits[0];
    const point = this.snapToVertex(hit.object as Mesh, hit.point, hit.face?.a, hit.face?.b, hit.face?.c);

    this.measurePoints.push(point);
    if (this.measurePoints.length > 2) this.measurePoints = [point];

    this.drawMeasurement();

    const [a, b] = this.measurePoints;
    this.callbacks.onMeasure(
      b
        ? { point: b, distance: a.distanceTo(b), delta: new Vector3().subVectors(b, a) }
        : { point: a },
    );
  };

  private snapToVertex(
    mesh: Mesh,
    point: Vector3,
    a?: number,
    b?: number,
    c?: number,
  ): Vector3 {
    if (a === undefined || b === undefined || c === undefined) return point.clone();
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) return point.clone();

    // Snap radius scales with zoom, so it stays roughly constant on screen.
    const threshold = this.controls.distance * 0.02;
    let best = point.clone();
    let bestDistance = threshold;

    for (const index of [a, b, c]) {
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

  private drawMeasurement(): void {
    this.clearGroup(this.measureGroup);
    const markerRadius = this.controls.distance * 0.006;

    for (const point of this.measurePoints) {
      const marker = new Mesh(
        new SphereGeometry(markerRadius, 12, 8),
        new MeshStandardMaterial({
          color: new Color(token('--bs-cut-300', '#5fe3f7')),
          emissive: new Color(token('--bs-cut-300', '#5fe3f7')),
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
          color: new Color(token('--bs-cut-300', '#5fe3f7')),
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
