/**
 * Corner view gizmo — the orientation cube slicers and CAD tools put in the
 * viewport corner.
 *
 * It answers two questions at once: which way is the model facing, and how do I
 * get to the view I want. Clicking a face snaps to it; the cube turns with the
 * camera so the current orientation is always legible.
 *
 * It shares the main renderer rather than opening a second WebGL context —
 * browsers cap those at around 16 per page, and one is already spent on the
 * viewport. Rendering is a second pass into a scissored corner of the same
 * canvas.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { StandardView } from './controls.js';

/** Size of the gizmo's square region, in CSS pixels. */
export const GIZMO_SIZE = 104;
/** Gap from the viewport's bottom-right corner. */
const GIZMO_MARGIN = 12;
/** Room kept beneath the cube for the reset/fit buttons that sit under it. */
export const GIZMO_BOTTOM_RESERVE = 34;

interface Face {
  view: StandardView;
  label: string;
  normal: Vector3;
  /** Which world direction should read as "up" when this face is seen head-on. */
  up: Vector3;
  mesh: Mesh;
}

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Draws a face label.
 *
 * The inset border is what makes the cube read as six distinct, clickable
 * faces rather than a textured block.
 */
function faceTexture(label: string, highlighted: boolean): CanvasTexture {
  const size = 160;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const face = highlighted ? token('--bs-solid-500', '#efa84e') : token('--bs-surface-raised', '#1f1b18');
  // Amber is a light colour, so a highlighted face takes ink, not white.
  const ink = highlighted ? token('--bs-brand-contrast', '#1a1512') : token('--bs-text-muted', '#9a8f86');
  const edge = token('--bs-border-strong', '#3f3833');

  ctx.fillStyle = face;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, size - 6, size - 6);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '1px';

  ctx.fillStyle = ink;
  ctx.font = `700 ${label.length > 5 ? 30 : 36}px "Inter", system-ui, sans-serif`;
  // Centred, now that it is the only thing on the face.
  ctx.fillText(label, size / 2, size / 2);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

export class ViewGizmo {
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly faces: Face[] = [];
  private readonly raycaster = new Raycaster();
  private readonly root = new Object3D();
  private hovered?: Face;

  constructor(private readonly onSelect: (view: StandardView) => void) {
    // Orthographic, so the cube keeps a constant size and reads as a pure
    // orientation reference rather than another perspective object.
    this.camera = new OrthographicCamera(-1.02, 1.02, 1.02, -1.02, 0.1, 100);
    this.camera.up.set(0, 0, 1);

    this.scene.add(this.root);
    this.build();
  }

  private build(): void {
    // A slightly inset core, so the six label planes read as faces of a solid.
    const core = new Mesh(
      new BoxGeometry(0.98, 0.98, 0.98),
      new MeshBasicMaterial({ color: token('--bs-surface-sunken', '#0a0908') }),
    );
    this.root.add(core);

    const definitions: {
      view: StandardView;
      label: string;
      normal: [number, number, number];
      up: [number, number, number];
    }[] = [
      { view: 'right', label: 'RIGHT', normal: [1, 0, 0], up: [0, 0, 1] },
      { view: 'left', label: 'LEFT', normal: [-1, 0, 0], up: [0, 0, 1] },
      { view: 'back', label: 'BACK', normal: [0, 1, 0], up: [0, 0, 1] },
      { view: 'front', label: 'FRONT', normal: [0, -1, 0], up: [0, 0, 1] },
      // Seen from above or below there is no world "up", so +Y and -Y are used
      // to keep the label the right way round as you arrive from an orbit.
      { view: 'top', label: 'TOP', normal: [0, 0, 1], up: [0, 1, 0] },
      { view: 'bottom', label: 'BOTTOM', normal: [0, 0, -1], up: [0, -1, 0] },
    ];

    for (const def of definitions) {
      const normal = new Vector3(...def.normal);
      const up = new Vector3(...def.up);
      // Right-handed basis with local +Z along the face normal and local +Y
      // along `up`, so the texture's orientation is fully determined.
      const right = new Vector3().crossVectors(up, normal);

      const mesh = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ map: faceTexture(def.label, false), transparent: false }),
      );
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(right, up, normal);
      mesh.matrix.setPosition(normal.clone().multiplyScalar(0.5));
      mesh.updateMatrixWorld(true);

      this.root.add(mesh);
      this.faces.push({ view: def.view, label: def.label, normal, up, mesh });
    }
  }

  /** Rebuilds the label textures after a theme change. */
  refreshTheme(): void {
    const core = this.root.children[0] as Mesh;
    (core.material as MeshBasicMaterial).color.set(token('--bs-surface-sunken', '#0a0908'));
    for (const face of this.faces) {
      const material = face.mesh.material as MeshBasicMaterial;
      material.map?.dispose();
      material.map = faceTexture(face.label, face === this.hovered);
      material.needsUpdate = true;
    }
  }

  /** The gizmo's rect within the canvas, in CSS pixels, measured from the top-left. */
  rect(width: number, height: number): { x: number; y: number; size: number } {
    return {
      x: width - GIZMO_SIZE - GIZMO_MARGIN,
      y: height - GIZMO_SIZE - GIZMO_MARGIN - GIZMO_BOTTOM_RESERVE,
      size: GIZMO_SIZE,
    };
  }

  private contains(px: number, py: number, width: number, height: number): boolean {
    const r = this.rect(width, height);
    return px >= r.x && px <= r.x + r.size && py >= r.y && py <= r.y + r.size;
  }

  /**
   * Which face is under the pointer, if any.
   *
   * `px`/`py` are CSS pixels relative to the canvas's top-left.
   */
  pick(px: number, py: number, width: number, height: number): StandardView | undefined {
    if (!this.contains(px, py, width, height)) return undefined;
    const r = this.rect(width, height);
    // Normalised device coordinates within the gizmo's own square viewport.
    const ndc = new Vector2(
      ((px - r.x) / r.size) * 2 - 1,
      -(((py - r.y) / r.size) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.faces.map((f) => f.mesh),
      false,
    );
    if (hits.length === 0) return undefined;
    return this.faces.find((f) => f.mesh === hits[0].object)?.view;
  }

  /** Highlights a face. Returns true when the highlight changed. */
  setHovered(view: StandardView | undefined): boolean {
    const next = view ? this.faces.find((f) => f.view === view) : undefined;
    if (next === this.hovered) return false;

    for (const face of [this.hovered, next]) {
      if (!face) continue;
      const material = face.mesh.material as MeshBasicMaterial;
      material.map?.dispose();
      material.map = faceTexture(face.label, face === next);
      material.needsUpdate = true;
    }
    this.hovered = next;
    return true;
  }

  select(view: StandardView): void {
    this.onSelect(view);
  }

  /**
   * Draws the gizmo into the corner of the main canvas.
   *
   * `orientation` is the unit vector from the camera target toward the camera,
   * so the cube shows the same side of the model the viewport does.
   */
  render(renderer: WebGLRenderer, orientation: Vector3, width: number, height: number): void {
    const r = this.rect(width, height);
    this.camera.position.copy(orientation).multiplyScalar(4);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    // `setScissor`/`setViewport` take CSS pixels and apply the renderer's pixel
    // ratio themselves — pre-multiplying here would square it, which is
    // invisible at ratio 1 and puts the gizmo off-screen at ratio 2.
    // The origin is the bottom-left of the viewport, hence the flipped Y.
    const x = r.x;
    const y = height - r.y - r.size;
    const size = r.size;

    renderer.setScissorTest(true);
    renderer.setScissor(x, y, size, size);
    renderer.setViewport(x, y, size, size);

    // `render` clears the colour buffer by default, which would stamp an opaque
    // black square over the viewport. Only the depth buffer needs clearing, so
    // the cube floats over the scene the way it does in a slicer.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
  }

  dispose(): void {
    for (const face of this.faces) {
      face.mesh.geometry.dispose();
      const material = face.mesh.material as MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    const core = this.root.children[0] as Mesh;
    core.geometry.dispose();
    (core.material as MeshBasicMaterial).dispose();
  }
}
