// Brush shapes -> render faces. Must describe the same solid as compileBrush in
// shared/src/world/collision.ts (brushGeometry.test.ts checks every face against
// the compiled planes). No three.js here so it stays unit-testable.

import { type BrushShape, type Vec3, vec3 } from '@splat/shared';

export interface BrushFace {
  /** outward unit normal */
  normal: Vec3;
  /** 3 or 4 vertices, counter-clockwise seen from outside */
  verts: Vec3[];
}

function face(normal: Vec3, verts: Vec3[]): BrushFace {
  const [a, b, c] = verts as [Vec3, Vec3, Vec3];
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * normal.x + cy * normal.y + cz * normal.z < 0) verts.reverse();
  return { normal, verts };
}

function sorted(shape: BrushShape): { min: Vec3; max: Vec3 } {
  const a = shape.min, b = shape.max;
  return {
    min: vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
    max: vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
  };
}

function boxFaces(min: Vec3, max: Vec3): BrushFace[] {
  const { x: x0, y: y0, z: z0 } = min;
  const { x: x1, y: y1, z: z1 } = max;
  return [
    face(vec3(1, 0, 0), [vec3(x1, y0, z0), vec3(x1, y1, z0), vec3(x1, y1, z1), vec3(x1, y0, z1)]),
    face(vec3(-1, 0, 0), [vec3(x0, y0, z0), vec3(x0, y1, z0), vec3(x0, y1, z1), vec3(x0, y0, z1)]),
    face(vec3(0, 1, 0), [vec3(x0, y1, z0), vec3(x1, y1, z0), vec3(x1, y1, z1), vec3(x0, y1, z1)]),
    face(vec3(0, -1, 0), [vec3(x0, y0, z0), vec3(x1, y0, z0), vec3(x1, y0, z1), vec3(x0, y0, z1)]),
    face(vec3(0, 0, 1), [vec3(x0, y0, z1), vec3(x1, y0, z1), vec3(x1, y1, z1), vec3(x0, y1, z1)]),
    face(vec3(0, 0, -1), [vec3(x0, y0, z0), vec3(x1, y0, z0), vec3(x1, y1, z0), vec3(x0, y1, z0)]),
  ];
}

/**
 * A ramp is a wedge: flat bottom, a full-height face at the high edge, a sloped
 * top, and two triangular sides. The low edge has zero height.
 */
function rampFaces(min: Vec3, max: Vec3, up: '+x' | '-x' | '+z' | '-z'): BrushFace[] {
  const a = up[1] as 'x' | 'z';
  const b = a === 'x' ? 'z' : 'x';
  const sign = up[0] === '+' ? 1 : -1;
  const lo = sign > 0 ? min[a] : max[a];
  const hi = sign > 0 ? max[a] : min[a];
  const b0 = min[b], b1 = max[b];
  const y0 = min.y, y1 = max.y;
  const P = (av: number, bv: number, y: number): Vec3 => {
    const p = vec3(0, y, 0);
    p[a] = av;
    p[b] = bv;
    return p;
  };
  const axisN = (comp: 'x' | 'z', s: number): Vec3 => {
    const n = vec3();
    n[comp] = s;
    return n;
  };

  const len = max[a] - min[a];
  const h = y1 - y0;
  const inv = 1 / Math.hypot(len, h);
  const slopeN = vec3(0, len * inv, 0);
  slopeN[a] = -sign * h * inv;

  return [
    face(slopeN, [P(lo, b0, y0), P(lo, b1, y0), P(hi, b1, y1), P(hi, b0, y1)]),
    face(axisN(a, sign), [P(hi, b0, y0), P(hi, b1, y0), P(hi, b1, y1), P(hi, b0, y1)]),
    face(vec3(0, -1, 0), [P(lo, b0, y0), P(hi, b0, y0), P(hi, b1, y0), P(lo, b1, y0)]),
    face(axisN(b, -1), [P(lo, b0, y0), P(hi, b0, y0), P(hi, b0, y1)]),
    face(axisN(b, 1), [P(lo, b1, y0), P(hi, b1, y0), P(hi, b1, y1)]),
  ];
}

export function brushFaces(shape: BrushShape): BrushFace[] {
  const { min, max } = sorted(shape);
  return shape.kind === 'ramp' ? rampFaces(min, max, shape.up) : boxFaces(min, max);
}

/**
 * Per-face brightness so edges read without real lighting: top brightest, each
 * side a different shade, bottoms dark. Weighted by squared normal components so
 * slopes blend between top and side.
 */
export function faceShade(n: Vec3): number {
  const sx = n.x >= 0 ? 0.84 : 0.72;
  const sy = n.y >= 0 ? 1.0 : 0.55;
  const sz = n.z >= 0 ? 0.93 : 0.78;
  return n.x * n.x * sx + n.y * n.y * sy + n.z * n.z * sz;
}
