/**
 * DXF importer for 2D profiles (spec feature 2: `import()` of DXF).
 *
 * DXF is a tagged format: pairs of (group code, value) lines. Only the entity
 * types that describe a 2D outline are read — LINE, LWPOLYLINE, POLYLINE/VERTEX,
 * CIRCLE, ARC and SPLINE control polygons. Anything else is skipped, which is
 * what OpenSCAD does too.
 */

export type Point2 = [number, number];
export type Contour2 = Point2[];

export interface DxfImportResult {
  /** Closed contours, in file units. */
  contours: Contour2[];
  /** Layer names present in the file, for `import(layer = ...)` and UI. */
  layers: string[];
  issues: { message: string }[];
}

interface Pair {
  code: number;
  value: string;
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

interface Segment {
  a: Point2;
  b: Point2;
  layer: string;
}

export function importDXF(text: string, options: { layer?: string; segments?: number } = {}): DxfImportResult {
  const pairs = tokenize(text);
  const issues: { message: string }[] = [];
  const layers = new Set<string>();
  const segments: Segment[] = [];
  const closedContours: { contour: Contour2; layer: string }[] = [];
  const arcSteps = Math.max(8, Math.min(256, options.segments ?? 32));

  let i = 0;
  // Skip to ENTITIES; files without that section are still worth scanning.
  const entitiesStart = pairs.findIndex((p) => p.code === 2 && p.value.trim() === 'ENTITIES');
  if (entitiesStart >= 0) i = entitiesStart + 1;

  while (i < pairs.length) {
    const pair = pairs[i];
    if (pair.code !== 0) {
      i++;
      continue;
    }
    const type = pair.value.trim();
    if (type === 'ENDSEC' && entitiesStart >= 0) break;

    // Gather this entity's pairs, up to the next `0` code.
    const entity: Pair[] = [];
    i++;
    while (i < pairs.length && pairs[i].code !== 0) entity.push(pairs[i++]);

    const num = (code: number, fallback = 0): number => {
      const found = entity.find((p) => p.code === code);
      return found ? (Number.parseFloat(found.value) || 0) : fallback;
    };
    const str = (code: number, fallback = ''): string => {
      const found = entity.find((p) => p.code === code);
      return found ? found.value.trim() : fallback;
    };

    const layer = str(8, '0');
    layers.add(layer);
    const wanted = options.layer === undefined || options.layer === '' || options.layer === layer;

    switch (type) {
      case 'LINE': {
        if (wanted) segments.push({ a: [num(10), num(20)], b: [num(11), num(21)], layer });
        break;
      }

      case 'LWPOLYLINE': {
        const xs = entity.filter((p) => p.code === 10).map((p) => Number.parseFloat(p.value) || 0);
        const ys = entity.filter((p) => p.code === 20).map((p) => Number.parseFloat(p.value) || 0);
        const points: Contour2 = xs.map((x, k) => [x, ys[k] ?? 0] as Point2);
        const closed = (num(70, 0) & 1) === 1;
        if (wanted && points.length >= 2) {
          if (closed && points.length >= 3) closedContours.push({ contour: points, layer });
          else {
            for (let k = 0; k + 1 < points.length; k++) {
              segments.push({ a: points[k], b: points[k + 1], layer });
            }
          }
        }
        break;
      }

      case 'POLYLINE': {
        // Vertices follow as separate VERTEX entities until SEQEND.
        const closed = (num(70, 0) & 1) === 1;
        const points: Contour2 = [];
        while (i < pairs.length) {
          const marker = pairs[i];
          if (marker.code !== 0) {
            i++;
            continue;
          }
          const sub = marker.value.trim();
          if (sub === 'SEQEND') {
            i++;
            while (i < pairs.length && pairs[i].code !== 0) i++;
            break;
          }
          if (sub !== 'VERTEX') break;
          i++;
          const vertex: Pair[] = [];
          while (i < pairs.length && pairs[i].code !== 0) vertex.push(pairs[i++]);
          const vx = vertex.find((p) => p.code === 10);
          const vy = vertex.find((p) => p.code === 20);
          points.push([vx ? Number.parseFloat(vx.value) || 0 : 0, vy ? Number.parseFloat(vy.value) || 0 : 0]);
        }
        if (wanted && points.length >= 2) {
          if (closed && points.length >= 3) closedContours.push({ contour: points, layer });
          else {
            for (let k = 0; k + 1 < points.length; k++) {
              segments.push({ a: points[k], b: points[k + 1], layer });
            }
          }
        }
        break;
      }

      case 'CIRCLE': {
        if (wanted) {
          const [cx, cy, r] = [num(10), num(20), num(40)];
          const contour: Contour2 = [];
          for (let k = 0; k < arcSteps; k++) {
            const angle = (k / arcSteps) * Math.PI * 2;
            contour.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
          }
          closedContours.push({ contour, layer });
        }
        break;
      }

      case 'ARC': {
        if (wanted) {
          const [cx, cy, r] = [num(10), num(20), num(40)];
          const startDeg = num(50);
          let endDeg = num(51);
          // DXF arcs always run counter-clockwise from start to end.
          while (endDeg <= startDeg) endDeg += 360;
          const steps = Math.max(2, Math.ceil((arcSteps * (endDeg - startDeg)) / 360));
          let prev: Point2 | undefined;
          for (let k = 0; k <= steps; k++) {
            const deg = startDeg + ((endDeg - startDeg) * k) / steps;
            const rad = (deg * Math.PI) / 180;
            const point: Point2 = [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
            if (prev) segments.push({ a: prev, b: point, layer });
            prev = point;
          }
        }
        break;
      }

      case 'SPLINE': {
        // Approximated by its control polygon; adequate for outline import and
        // what most CAD exporters already flatten anyway.
        if (wanted) {
          const xs = entity.filter((p) => p.code === 10).map((p) => Number.parseFloat(p.value) || 0);
          const ys = entity.filter((p) => p.code === 20).map((p) => Number.parseFloat(p.value) || 0);
          for (let k = 0; k + 1 < xs.length; k++) {
            segments.push({ a: [xs[k], ys[k] ?? 0], b: [xs[k + 1], ys[k + 1] ?? 0], layer });
          }
          if (xs.length > 2) {
            issues.push({
              message: 'DXF SPLINE entities are approximated by their control polygon.',
            });
          }
        }
        break;
      }

      default:
        break;
    }
  }

  const chained = chainSegments(segments);
  return {
    contours: [...closedContours.map((c) => c.contour), ...chained.contours],
    layers: [...layers].sort(),
    issues: [...issues, ...chained.issues],
  };
}

/**
 * Joins loose line segments end-to-end into closed loops.
 *
 * DXF stores an outline as unordered segments, so this walk is what turns a
 * drawing into something that can be extruded. Endpoints are matched on a
 * quantised grid because exporters rarely write bit-identical coordinates.
 */
function chainSegments(segments: Segment[]): { contours: Contour2[]; issues: { message: string }[] } {
  const issues: { message: string }[] = [];
  if (segments.length === 0) return { contours: [], issues };

  const epsilon = 1e-6;
  const key = (p: Point2): string => `${Math.round(p[0] / epsilon)},${Math.round(p[1] / epsilon)}`;

  const adjacency = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const end of [segment.a, segment.b]) {
      const k = key(end);
      const list = adjacency.get(k);
      if (list) list.push(index);
      else adjacency.set(k, [index]);
    }
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const contours: Contour2[] = [];
  let openCount = 0;

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const contour: Contour2 = [segments[start].a, segments[start].b];
    let head = segments[start].b;

    for (;;) {
      const candidates = adjacency.get(key(head)) ?? [];
      const nextIndex = candidates.find((c) => !used[c]);
      if (nextIndex === undefined) break;
      used[nextIndex] = true;
      const segment = segments[nextIndex];
      const sameStart = key(segment.a) === key(head);
      head = sameStart ? segment.b : segment.a;
      contour.push(head);
      if (key(head) === key(contour[0])) break; // closed the loop
    }

    if (contour.length >= 3) {
      if (key(contour[contour.length - 1]) === key(contour[0])) contour.pop();
      contours.push(contour);
    } else {
      openCount++;
    }
  }

  if (openCount > 0) {
    issues.push({
      message: `${openCount} DXF path${openCount === 1 ? '' : 's'} could not be closed and were ignored.`,
    });
  }
  return { contours, issues };
}
