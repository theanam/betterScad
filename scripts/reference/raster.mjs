/**
 * A software renderer for the reference images.
 *
 * The app draws its preview with WebGL, which needs a browser; these images are
 * generated from a Node script so that regenerating them is `npm run reference`
 * and not "open the app and take sixty screenshots by hand". So the shading the
 * viewport gets from three.js is reproduced here in about three hundred lines:
 * the same iso view, the same three-light rig, the same crease-aware normals,
 * and the same amber.
 *
 * Output is RGBA with a transparent background, because these images are shown
 * on a light page and a dark one — in the app's Help view, in the README, and on
 * GitHub — and a baked-in backdrop would be wrong in half of those.
 */

/** Viewport lighting, straight from `viewport.ts`. */
const LIGHTS = [
  { dir: [1, 0.6, 1.4], intensity: 2 },
  { dir: [-1.2, -0.4, 0.6], intensity: 0.55 },
  { dir: [0, 1, -1], intensity: 0.45 },
].map((light) => {
  const [x, y, z] = light.dir;
  const len = Math.hypot(x, y, z);
  // Divided by pi to match three's physical lighting, where a direct light's
  // diffuse term carries the Lambert BRDF's 1/pi.
  return { dir: [x / len, y / len, z / len], intensity: light.intensity / Math.PI };
});

const AMBIENT = 0.55 / Math.PI;

/** `MeshStandardMaterial({ roughness: 0.62, metalness: 0.04 })`, approximated. */
const SPECULAR_POWER = 2 / 0.62 ** 4 - 2;
const SPECULAR_STRENGTH = 0.055;

/** Matches `--bs-cut-300`: the colour the app gives `#`-highlighted geometry. */
export const HIGHLIGHT_COLOR = srgbToLinear([0x5c / 255, 0xd3 / 255, 0xe0 / 255]);

/**
 * `%`-role geometry: the translucent reference the viewport makes it.
 *
 * Heavier than the app's 0.25, because these images are transparent and land on
 * a light page as often as a dark one. At the app's weight a pale ghost simply
 * disappears against white.
 */
const ANNOTATION_ALPHA = 0.5;

/**
 * The ghost's own albedo, replacing the engine's near-white default.
 *
 * Darker, so that half-opacity over a white page is still a shape; and very
 * slightly cool, so it cannot be mistaken for badly-lit amber.
 */
const ANNOTATION_ALBEDO = [0.3, 0.32, 0.34];

function srgbToLinear(rgb) {
  return rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** The app's default iso pose: azimuth -45 degrees, polar 60, both from +Z. */
export const ISO_VIEW = { azimuth: -Math.PI / 4, polar: Math.PI / 3 };
export const TOP_VIEW = { azimuth: -Math.PI / 2, polar: 1e-3 };
export const FRONT_VIEW = { azimuth: -Math.PI / 2, polar: Math.PI / 2 };
/**
 * Looking down from the front, for anything with a right way up.
 *
 * The iso view turns a shape 45 degrees about Z, which is what makes a box read
 * as a box — and what makes a word unreadable. This keeps the camera square to
 * the model so text stays legible, and still comes in high enough to show its
 * thickness.
 */
export const PLAN_VIEW = { azimuth: -Math.PI / 2, polar: Math.PI * 0.26 };

const FOV = 45;

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * A perspective camera looking at `target` from `distance` away, in the app's
 * Z-up orbit convention.
 */
function cameraAt(target, distance, width, height, view) {
  const aspect = width / height;
  const fov = (FOV * Math.PI) / 180;
  const sinPolar = Math.sin(view.polar);
  const eye = [
    target[0] + distance * sinPolar * Math.cos(view.azimuth),
    target[1] + distance * sinPolar * Math.sin(view.azimuth),
    target[2] + distance * Math.cos(view.polar),
  ];

  // Z-up, matching OpenSCAD and the app's camera.
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);

  const near = Math.max(distance / 5000, 0.01);
  const far = distance * 100;
  const f = 1 / Math.tan(fov / 2);

  /** World point to clip space, as [x, y, z, w]. */
  const project = (p) => {
    const d = sub(p, eye);
    const vx = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
    const vy = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    // Right-handed view space looks down -Z, so depth is the negated forward
    // distance and everything in front of the camera has positive w.
    const vz = -(d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]);
    return [
      (f / aspect) * vx,
      f * vy,
      ((far + near) / (near - far)) * vz + (2 * far * near) / (near - far),
      -vz,
    ];
  };

  /** World point to pixels. */
  const toScreen = (p) => {
    const clip = project(p);
    return [
      ((clip[0] / clip[3]) * 0.5 + 0.5) * width,
      (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * height,
    ];
  };

  return { project, toScreen, eye, target, distance, right, up };
}

/** Fraction of the frame the model is allowed to occupy. */
const FRAME_FILL = 0.84;

/**
 * How much of the frame the model fills, for a given `zoom`.
 *
 * Above 1 pushes the camera in and below 1 pulls it back, which is the way the
 * catalogue documents it and the way the word reads. Capped just short of the
 * frame so a pushed-in model still cannot run off the edge.
 */
function frameFill(zoom) {
  return Math.min(0.98, FRAME_FILL * (zoom || 1));
}

/**
 * A camera framed on what the model actually covers on screen, not on its
 * bounding sphere.
 *
 * The app frames the bounding sphere, which is the right call for a camera you
 * are about to orbit — it can never clip whichever way you turn. These images
 * never move, so they can afford the tighter fit, and the difference is large:
 * a long flat arrangement framed by its sphere sits in the middle of the image
 * at half the size, with the wasted space contributing nothing.
 *
 * Solved by iteration rather than algebra: under perspective, moving the camera
 * changes the silhouette it is being fitted to. Three rounds is well past
 * convergence for every example here.
 */
function frameCamera(vertices, width, height, view, zoom) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const positions of vertices) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        if (positions[i + axis] < min[axis]) min[axis] = positions[i + axis];
        if (positions[i + axis] > max[axis]) max[axis] = positions[i + axis];
      }
    }
  }
  if (!Number.isFinite(min[0])) return undefined;

  let target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size = sub(max, min);
  const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-3);
  const fov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(fov / 2) * (width / height));
  let distance = radius / Math.sin(Math.min(fov, hFov) / 2);

  let camera = cameraAt(target, distance, width, height, view);
  for (let pass = 0; pass < 3; pass++) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const positions of vertices) {
      for (let i = 0; i < positions.length; i += 3) {
        const [x, y] = camera.toScreen([positions[i], positions[i + 1], positions[i + 2]]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const fill = frameFill(zoom);
    distance *= Math.max((maxX - minX) / (width * fill), (maxY - minY) / (height * fill));

    // Re-centre by sliding the target across the camera's own screen plane, so
    // the model ends up in the middle of the frame however lopsided it is.
    const spanY = 2 * distance * Math.tan(fov / 2);
    const perPixel = spanY / height;
    const dx = ((minX + maxX) / 2 - width / 2) * perPixel;
    const dy = ((minY + maxY) / 2 - height / 2) * perPixel;
    target = [
      target[0] + camera.right[0] * dx - camera.up[0] * dy,
      target[1] + camera.right[1] * dx - camera.up[1] * dy,
      target[2] + camera.right[2] * dx - camera.up[2] * dy,
    ];
    camera = cameraAt(target, distance, width, height, view);
  }
  return camera;
}

// ---------------------------------------------------------------------------
// Normals
// ---------------------------------------------------------------------------

/** Faces meeting at less than 30 degrees are smoothed; sharper is a crease. */
const CREASE_COS = Math.cos((30 * Math.PI) / 180);

/**
 * Per-corner normals, smoothed within a surface and split across creases.
 *
 * The same rule the render worker applies (`toPayload`), minus the vertex
 * de-duplication: nothing here is uploaded to a GPU, so corners can simply
 * carry their own normals.
 */
function cornerNormals(positions, triangles) {
  const faceCount = triangles.length / 3;
  const vertexCount = positions.length / 3;
  const weighted = new Float32Array(faceCount * 3);
  const unit = new Float32Array(faceCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const ia = triangles[f * 3] * 3;
    const ib = triangles[f * 3 + 1] * 3;
    const ic = triangles[f * 3 + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    weighted[f * 3] = nx;
    weighted[f * 3 + 1] = ny;
    weighted[f * 3 + 2] = nz;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      unit[f * 3] = nx / len;
      unit[f * 3 + 1] = ny / len;
      unit[f * 3 + 2] = nz / len;
    }
  }

  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < triangles.length; i++) offsets[triangles[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const adjacency = new Uint32Array(triangles.length);
  const cursor = offsets.slice(0, vertexCount);
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) adjacency[cursor[triangles[f * 3 + k]]++] = f;
  }

  const normals = new Float32Array(triangles.length * 3);
  for (let f = 0; f < faceCount; f++) {
    const fx = unit[f * 3];
    const fy = unit[f * 3 + 1];
    const fz = unit[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = triangles[f * 3 + k];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let j = offsets[v]; j < offsets[v + 1]; j++) {
        const g = adjacency[j];
        if (fx * unit[g * 3] + fy * unit[g * 3 + 1] + fz * unit[g * 3 + 2] < CREASE_COS) continue;
        nx += weighted[g * 3];
        ny += weighted[g * 3 + 1];
        nz += weighted[g * 3 + 2];
      }
      const len = Math.hypot(nx, ny, nz);
      const at = (f * 3 + k) * 3;
      normals[at] = len > 0 ? nx / len : fx;
      normals[at + 1] = len > 0 ? ny / len : fy;
      normals[at + 2] = len > 0 ? nz / len : fz;
    }
  }
  return normals;
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

function shade(normal, toEye, albedo) {
  let diffuse = AMBIENT;
  let specular = 0;
  for (const light of LIGHTS) {
    const ndotl = normal[0] * light.dir[0] + normal[1] * light.dir[1] + normal[2] * light.dir[2];
    if (ndotl <= 0) continue;
    diffuse += ndotl * light.intensity;
    const half = normalize([
      light.dir[0] + toEye[0],
      light.dir[1] + toEye[1],
      light.dir[2] + toEye[2],
    ]);
    const ndoth = Math.max(0, normal[0] * half[0] + normal[1] * half[1] + normal[2] * half[2]);
    specular += light.intensity * SPECULAR_STRENGTH * ndoth ** SPECULAR_POWER;
  }
  return [
    albedo[0] * diffuse + specular,
    albedo[1] * diffuse + specular,
    albedo[2] * diffuse + specular,
  ];
}

/**
 * One rendering target: linear-light colour, coverage, and a depth buffer.
 *
 * Kept in linear light and converted to sRGB once at the end, so that
 * supersampling averages light rather than gamma-encoded bytes — the difference
 * is visible on every silhouette.
 */
function makeTarget(width, height) {
  return {
    width,
    height,
    color: new Float32Array(width * height * 3),
    alpha: new Float32Array(width * height),
    depth: new Float32Array(width * height).fill(Infinity),
  };
}

/** Source-over, with both sides premultiplied. */
function blend(target, index, rgb, alpha) {
  const inverse = 1 - alpha;
  target.color[index * 3] = rgb[0] * alpha + target.color[index * 3] * inverse;
  target.color[index * 3 + 1] = rgb[1] * alpha + target.color[index * 3 + 1] * inverse;
  target.color[index * 3 + 2] = rgb[2] * alpha + target.color[index * 3 + 2] * inverse;
  target.alpha[index] = alpha + target.alpha[index] * inverse;
}

/**
 * Draws one triangle, Gouraud-shaded, with a z-buffer.
 *
 * `opaque` writes depth; a translucent pass tests against it but does not, so
 * the `%` reference geometry never hides the model it is there to compare with.
 */
function triangle(target, camera, corners, normals, albedo, alpha, opaque) {
  const clip = corners.map(camera.project);
  // No near-plane clipping: everything here is framed to fit, so a vertex
  // behind the camera means the framing is wrong rather than that the triangle
  // needs splitting.
  if (clip.some((c) => c[3] <= 1e-6)) return;

  const screen = clip.map((c) => [
    ((c[0] / c[3]) * 0.5 + 0.5) * target.width,
    (1 - ((c[1] / c[3]) * 0.5 + 0.5)) * target.height,
    c[2] / c[3],
    1 / c[3],
  ]);

  const area =
    (screen[1][0] - screen[0][0]) * (screen[2][1] - screen[0][1]) -
    (screen[1][1] - screen[0][1]) * (screen[2][0] - screen[0][0]);
  // Both windings are drawn: 2D-derived and imported meshes reach here with
  // inconsistent winding, and the viewport renders those double-sided too.
  if (Math.abs(area) < 1e-12) return;

  const minX = Math.max(0, Math.floor(Math.min(screen[0][0], screen[1][0], screen[2][0])));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(screen[0][0], screen[1][0], screen[2][0])));
  const minY = Math.max(0, Math.floor(Math.min(screen[0][1], screen[1][1], screen[2][1])));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(screen[0][1], screen[1][1], screen[2][1])));

  const eye = camera.eye;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let w0 =
        ((screen[1][0] - screen[0][0]) * (py - screen[0][1]) -
          (screen[1][1] - screen[0][1]) * (px - screen[0][0])) / area;
      let w1 =
        ((screen[2][0] - screen[1][0]) * (py - screen[1][1]) -
          (screen[2][1] - screen[1][1]) * (px - screen[1][0])) / area;
      let w2 = 1 - w0 - w1;
      // w0 is the weight opposite vertex 0, which is the barycentric of vertex 2.
      const b2 = w0;
      const b0 = w1;
      const b1 = w2;
      if (b0 < 0 || b1 < 0 || b2 < 0) continue;

      const index = y * target.width + x;
      const depth = b0 * screen[0][2] + b1 * screen[1][2] + b2 * screen[2][2];
      if (depth >= target.depth[index]) continue;

      // Perspective-correct interpolation of the surface attributes.
      const iw = b0 * screen[0][3] + b1 * screen[1][3] + b2 * screen[2][3];
      const c0 = (b0 * screen[0][3]) / iw;
      const c1 = (b1 * screen[1][3]) / iw;
      const c2 = (b2 * screen[2][3]) / iw;

      let nx = c0 * normals[0][0] + c1 * normals[1][0] + c2 * normals[2][0];
      let ny = c0 * normals[0][1] + c1 * normals[1][1] + c2 * normals[2][1];
      let nz = c0 * normals[0][2] + c1 * normals[1][2] + c2 * normals[2][2];
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;

      const wx = c0 * corners[0][0] + c1 * corners[1][0] + c2 * corners[2][0];
      const wy = c0 * corners[0][1] + c1 * corners[1][1] + c2 * corners[2][1];
      const wz = c0 * corners[0][2] + c1 * corners[1][2] + c2 * corners[2][2];
      const toEye = normalize([eye[0] - wx, eye[1] - wy, eye[2] - wz]);

      // Double-sided: a normal pointing away from the camera is a back face,
      // and it is lit as if it faced us rather than going black.
      const facing = nx * toEye[0] + ny * toEye[1] + nz * toEye[2] < 0 ? -1 : 1;
      const rgb = shade([nx * facing, ny * facing, nz * facing], toEye, albedo);

      if (opaque) {
        target.depth[index] = depth;
        target.color[index * 3] = rgb[0];
        target.color[index * 3 + 1] = rgb[1];
        target.color[index * 3 + 2] = rgb[2];
        target.alpha[index] = 1;
      } else {
        blend(target, index, rgb, alpha);
      }
    }
  }
}

function drawMesh(target, camera, mesh, albedo, alpha, opaque) {
  const { positions, triangles } = mesh;
  const normals = cornerNormals(positions, triangles);
  const faceCount = triangles.length / 3;

  for (let f = 0; f < faceCount; f++) {
    const corners = [];
    const cornerNormal = [];
    for (let k = 0; k < 3; k++) {
      const v = triangles[f * 3 + k] * 3;
      corners.push([positions[v], positions[v + 1], positions[v + 2]]);
      const n = (f * 3 + k) * 3;
      cornerNormal.push([normals[n], normals[n + 1], normals[n + 2]]);
    }
    triangle(target, camera, corners, cornerNormal, albedo, alpha, opaque);
  }
}

// ---------------------------------------------------------------------------
// 2D geometry
// ---------------------------------------------------------------------------

/**
 * Flat fill for a 2D result, seen from straight above.
 *
 * A 2D shape has no thickness to catch the light, so it is drawn as a filled
 * silhouette with an outline rather than shaded — which is also how you would
 * draw it on paper, and makes "this one is flat" the first thing the image says.
 */
function drawContours(target, project, contours, albedo, scale) {
  const edges = [];
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = project(contour[i]);
      const b = project(contour[(i + 1) % contour.length]);
      if (a[1] !== b[1]) edges.push([a, b]);
    }
  }
  if (edges.length === 0) return;

  // Non-zero winding, so that a hole punched by a reversed contour reads as a
  // hole and two overlapping outlines do not cancel.
  for (let y = 0; y < target.height; y++) {
    const py = y + 0.5;
    const crossings = [];
    for (const [a, b] of edges) {
      if (py < Math.min(a[1], b[1]) || py >= Math.max(a[1], b[1])) continue;
      const t = (py - a[1]) / (b[1] - a[1]);
      crossings.push({ x: a[0] + t * (b[0] - a[0]), dir: b[1] > a[1] ? 1 : -1 });
    }
    if (crossings.length === 0) continue;
    crossings.sort((p, q) => p.x - q.x);

    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].dir;
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(crossings[i].x - 0.5));
      const to = Math.min(target.width - 1, Math.floor(crossings[i + 1].x - 0.5));
      for (let x = from; x <= to; x++) {
        const index = y * target.width + x;
        target.color[index * 3] = albedo[0];
        target.color[index * 3 + 1] = albedo[1];
        target.color[index * 3 + 2] = albedo[2];
        target.alpha[index] = 1;
      }
    }
  }

  // The outline: the same colour darkened, so the shape keeps a defined edge
  // against a light page as well as a dark one.
  const outline = albedo.map((c) => c * 0.45);
  const halfWidth = 1.1 * scale;
  for (const [a, b] of edges.concat(
    contours.flatMap((contour) =>
      contour.map((point, i) => [project(point), project(contour[(i + 1) % contour.length])]),
    ),
  )) {
    strokeLine(target, a, b, outline, halfWidth);
  }
}

function strokeLine(target, a, b, rgb, halfWidth) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - halfWidth - 1));
  const maxX = Math.min(target.width - 1, Math.ceil(Math.max(a[0], b[0]) + halfWidth + 1));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - halfWidth - 1));
  const maxY = Math.min(target.height - 1, Math.ceil(Math.max(a[1], b[1]) + halfWidth + 1));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy || 1;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - a[0];
      const py = y + 0.5 - a[1];
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSq));
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance > halfWidth) continue;
      const index = y * target.width + x;
      target.color[index * 3] = rgb[0];
      target.color[index * 3 + 1] = rgb[1];
      target.color[index * 3 + 2] = rgb[2];
      target.alpha[index] = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Supersampling factor. Everything is drawn at this scale and boxed down. */
const SUPERSAMPLE = 3;

function resolve(target, width, height) {
  const out = new Uint8Array(width * height * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const index = (y * SUPERSAMPLE + sy) * target.width + x * SUPERSAMPLE + sx;
          r += target.color[index * 3];
          g += target.color[index * 3 + 1];
          b += target.color[index * 3 + 2];
          a += target.alpha[index];
        }
      }
      a /= samples;
      const at = (y * width + x) * 4;
      if (a > 0) {
        // Un-premultiply before encoding, so a partly-covered edge pixel keeps
        // the colour of the surface rather than fading towards black.
        out[at] = Math.round(Math.min(1, linearToSrgb(r / samples / a)) * 255);
        out[at + 1] = Math.round(Math.min(1, linearToSrgb(g / samples / a)) * 255);
        out[at + 2] = Math.round(Math.min(1, linearToSrgb(b / samples / a)) * 255);
      }
      out[at + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return out;
}

/**
 * Renders a `BuildResult` to an RGBA image.
 *
 * @returns `{ rgba, width, height }`, or `undefined` when the result is empty.
 */
export function renderGeometry(geometry, options = {}) {
  const width = options.width ?? 560;
  const height = options.height ?? 400;
  const target = makeTarget(width * SUPERSAMPLE, height * SUPERSAMPLE);
  const zoom = options.zoom ?? 1;

  if (geometry.dimension === 2) {
    if (!drawFlat(target, geometry, zoom)) return undefined;
    return { rgba: resolve(target, width, height), width, height };
  }

  const solids = geometry.parts.filter((part) => part.mesh.triangles.length > 0);
  const ghosts = geometry.annotations.filter((part) => part.mesh.triangles.length > 0);
  if (solids.length === 0 && ghosts.length === 0) return undefined;

  const camera = frameCamera(
    [...solids, ...ghosts].map((part) => part.mesh.positions),
    target.width,
    target.height,
    options.view ?? ISO_VIEW,
    zoom,
  );
  if (!camera) return undefined;

  for (const part of solids) {
    const albedo = part.display === 'highlight' ? HIGHLIGHT_COLOR : part.color.slice(0, 3);
    const alpha = part.display === 'transparent' ? ANNOTATION_ALPHA : part.color[3];
    drawMesh(target, camera, part.mesh, albedo, alpha, alpha >= 1);
  }

  // `%` geometry is drawn into a buffer of its own and composited in one go.
  // Blending its triangles straight onto the image would stack every layer of
  // the shape — near wall, far wall, and the seams between them — into a
  // crumpled-tissue look; one pass with its own depth buffer keeps it to the
  // single nearest surface, which is what makes it read as a ghost of the
  // model rather than as more model.
  if (ghosts.length > 0) {
    const layer = makeTarget(target.width, target.height);
    for (const part of ghosts) {
      drawMesh(layer, camera, part.mesh, ANNOTATION_ALBEDO, 1, true);
    }
    for (let i = 0; i < layer.alpha.length; i++) {
      if (layer.alpha[i] === 0 || layer.depth[i] >= target.depth[i]) continue;
      blend(
        target,
        i,
        [layer.color[i * 3], layer.color[i * 3 + 1], layer.color[i * 3 + 2]],
        ANNOTATION_ALPHA * layer.alpha[i],
      );
    }
  }

  return { rgba: resolve(target, width, height), width, height };
}

/**
 * The 2D case: fitted to the shape's own rectangle and drawn straight on.
 *
 * Fitted rather than framed by a camera, because a flat shape seen in
 * perspective is a flat shape drawn wrong — the far edge of a square would be
 * shorter than the near one.
 */
function drawFlat(target, geometry, zoom) {
  const points = geometry.contours2d.flatMap((entry) => entry.contours.flat());
  if (points.length === 0) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const fill = frameFill(zoom);
  const scale = Math.min(
    (target.width * fill) / Math.max(maxX - minX, 1e-6),
    (target.height * fill) / Math.max(maxY - minY, 1e-6),
  );
  const project = ([x, y]) => [
    target.width / 2 + (x - (minX + maxX) / 2) * scale,
    // Y is up in OpenSCAD and down in an image.
    target.height / 2 - (y - (minY + maxY) / 2) * scale,
  ];

  for (const entry of geometry.contours2d) {
    // Used as linear light, which is how three reads the same components for
    // the contour lines in the app — so a 2D shape comes out the same amber as
    // a 3D one rather than a more saturated orange.
    drawContours(target, project, entry.contours, entry.color.slice(0, 3), SUPERSAMPLE);
  }
  return true;
}
