// Box/point tracing against convex brushes, after Quake 3's CM_TraceThroughBrush:
// each brush plane is pushed out by the moving box's extents (a Minkowski sum),
// then the segment is clipped against the expanded planes. A zero-size box is a
// plain ray cast, which is what projectiles use.

import { type Vec3, vec3, dot, lerp, copy, set } from '../math.ts';
import type { BrushShape, CollisionWorld, CompiledBrush, MapDef, Plane, TraceResult } from './types.ts';

/** Stop this far short of a surface so the next trace doesn't start inside it. */
export const SURFACE_CLIP_EPSILON = 0.03125;

function axialPlanes(min: Vec3, max: Vec3): Plane[] {
  return [
    { n: vec3(1, 0, 0), d: max.x },
    { n: vec3(-1, 0, 0), d: -min.x },
    { n: vec3(0, 1, 0), d: max.y },
    { n: vec3(0, -1, 0), d: -min.y },
    { n: vec3(0, 0, 1), d: max.z },
    { n: vec3(0, 0, -1), d: -min.z },
  ];
}

/** Outward normal of a ramp's sloped face. */
function rampPlane(min: Vec3, max: Vec3, up: '+x' | '-x' | '+z' | '-z'): Plane {
  const h = max.y - min.y;
  const axis = up[1] as 'x' | 'z';
  const sign = up[0] === '+' ? 1 : -1;
  const len = max[axis] - min[axis];
  const inv = 1 / Math.hypot(len, h);
  const n = vec3(0, len * inv, 0);
  n[axis] = -sign * h * inv;
  const low = vec3(0, min.y, 0);
  low[axis] = sign > 0 ? min[axis] : max[axis];
  return { n, d: dot(n, low) };
}

export function compileBrush(shape: BrushShape): CompiledBrush {
  const min = vec3(Math.min(shape.min.x, shape.max.x), Math.min(shape.min.y, shape.max.y), Math.min(shape.min.z, shape.max.z));
  const max = vec3(Math.max(shape.min.x, shape.max.x), Math.max(shape.min.y, shape.max.y), Math.max(shape.min.z, shape.max.z));
  // The axial planes double as bevel planes for the ramp, which keeps box traces
  // from snagging on its edges.
  const planes = axialPlanes(min, max);
  if (shape.kind === 'ramp') planes.push(rampPlane(min, max, shape.up));
  return { planes, min, max };
}

export function buildCollisionWorld(map: Pick<MapDef, 'brushes'>): CollisionWorld {
  return { brushes: map.brushes.map((b) => compileBrush(b.shape)) };
}

export function emptyTrace(): TraceResult {
  return { fraction: 1, endPos: vec3(), normal: vec3(), startSolid: false, allSolid: false, brush: -1 };
}

const ofs = vec3();

function traceBrush(
  brush: CompiledBrush,
  index: number,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  tr: TraceResult,
): void {
  let enterFrac = -1;
  let leavFrac = 1;
  let clip: Plane | null = null;
  let getOut = false;
  let startOut = false;

  for (const p of brush.planes) {
    ofs.x = p.n.x < 0 ? maxs.x : mins.x;
    ofs.y = p.n.y < 0 ? maxs.y : mins.y;
    ofs.z = p.n.z < 0 ? maxs.z : mins.z;
    const dist = p.d - dot(ofs, p.n);
    const d1 = dot(start, p.n) - dist;
    const d2 = dot(end, p.n) - dist;

    if (d2 > 0) getOut = true;
    if (d1 > 0) startOut = true;

    // Entirely in front of this face: the segment misses the brush.
    if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return;
    // Entirely behind this face: it doesn't constrain the segment.
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      const f = Math.max(0, (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2));
      if (f > enterFrac) {
        enterFrac = f;
        clip = p;
      }
    } else {
      const f = Math.min(1, (d1 + SURFACE_CLIP_EPSILON) / (d1 - d2));
      if (f < leavFrac) leavFrac = f;
    }
  }

  if (!startOut) {
    tr.startSolid = true;
    tr.brush = index;
    if (!getOut) {
      tr.allSolid = true;
      tr.fraction = 0;
    }
    return;
  }

  if (enterFrac < leavFrac && enterFrac > -1 && enterFrac < tr.fraction && clip) {
    tr.fraction = Math.max(0, enterFrac);
    copy(tr.normal, clip.n);
    tr.brush = index;
  }
}

/**
 * Sweep an axis-aligned box (mins/maxs relative to the origin) from start to end.
 * Pass mins = maxs = zero for a ray.
 */
export function traceBox(
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
  out: TraceResult = emptyTrace(),
): TraceResult {
  out.fraction = 1;
  out.startSolid = false;
  out.allSolid = false;
  out.brush = -1;
  set(out.normal, 0, 0, 0);

  // Broadphase: swept bounds of the box, padded by the clip epsilon.
  const e = SURFACE_CLIP_EPSILON * 2;
  const loX = Math.min(start.x, end.x) + mins.x - e;
  const loY = Math.min(start.y, end.y) + mins.y - e;
  const loZ = Math.min(start.z, end.z) + mins.z - e;
  const hiX = Math.max(start.x, end.x) + maxs.x + e;
  const hiY = Math.max(start.y, end.y) + maxs.y + e;
  const hiZ = Math.max(start.z, end.z) + maxs.z + e;

  const brushes = world.brushes;
  for (let i = 0; i < brushes.length; i++) {
    const b = brushes[i]!;
    if (b.min.x > hiX || b.max.x < loX || b.min.y > hiY || b.max.y < loY || b.min.z > hiZ || b.max.z < loZ) continue;
    traceBrush(b, i, start, end, mins, maxs, out);
    if (out.allSolid) break;
  }

  if (out.fraction === 1) copy(out.endPos, end);
  else lerp(out.endPos, start, end, out.fraction);
  return out;
}

const ZERO = vec3();
const testTrace = emptyTrace();

/**
 * True if a box (mins/maxs relative to `pos`) placed at `pos` overlaps solid.
 * Touching a face counts as overlapping, but positions left by traceBox stop
 * SURFACE_CLIP_EPSILON short of every surface, so they test clear.
 */
export function testBox(world: CollisionWorld, pos: Vec3, mins: Vec3, maxs: Vec3): boolean {
  return traceBox(world, pos, pos, mins, maxs, testTrace).startSolid;
}

export function traceRay(world: CollisionWorld, start: Vec3, end: Vec3, out?: TraceResult): TraceResult {
  return traceBox(world, start, end, ZERO, ZERO, out);
}
