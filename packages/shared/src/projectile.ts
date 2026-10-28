// Paintballs are real projectiles: speed, gravity, optional drag, radius, lifetime.
// Each tick a ball moves along its exact ballistic arc, and the segment from the
// previous to the new position is traced against the world and the target hitboxes,
// so fast balls can't tunnel through thin walls.

import { type Vec3, clone, copy, lerp, scale, set, vec3 } from './math.ts';
import { emptyTrace, traceRay } from './world/collision.ts';
import type { CollisionWorld } from './world/types.ts';
import type { WeaponId, WeaponStats } from './weapons.ts';

export interface Projectile {
  id: number;
  /** shooter id; hitboxes with this id are ignored */
  owner: number;
  weapon: WeaponId;
  pos: Vec3;
  /** position at the start of the last step (render interpolates prevPos → pos) */
  prevPos: Vec3;
  vel: Vec3;
  /** u/s² */
  gravity: number;
  /** 1/s */
  drag: number;
  radius: number;
  /** seconds since spawn */
  age: number;
  lifetime: number;
  /** paint meter fill on a target hit */
  paint: number;
  splatRadius: number;
}

/** A target's axis-aligned hitbox: `mins`/`maxs` relative to `pos` (feet), like getHull. */
export interface HitBox {
  id: number;
  pos: Vec3;
  mins: Vec3;
  maxs: Vec3;
}

export interface ProjectileHit {
  kind: 'world' | 'target';
  /** the ball, already removed from the live list */
  projectile: Projectile;
  point: Vec3;
  /** outward surface normal at the hit */
  normal: Vec3;
  /** HitBox id for 'target' hits, -1 for 'world' */
  target: number;
  /** brush index for 'world' hits, -1 for 'target' */
  brush: number;
}

export function spawnProjectile(
  id: number,
  owner: number,
  weapon: WeaponId,
  stats: WeaponStats,
  origin: Vec3,
  dir: Vec3,
): Projectile {
  return {
    id,
    owner,
    weapon,
    pos: clone(origin),
    prevPos: clone(origin),
    vel: scale(vec3(), dir, stats.ballSpeed),
    gravity: stats.ballGravity,
    drag: stats.ballDrag,
    radius: stats.ballRadius,
    age: 0,
    lifetime: stats.ballLifetime,
    paint: stats.paintPerHit,
    splatRadius: stats.splatRadius,
  };
}

/**
 * Advance `pos`/`vel` by `t` seconds along the exact solution of
 * v' = -drag·v - g·ŷ, so the arc doesn't depend on the tick rate.
 */
export function ballisticStep(pos: Vec3, vel: Vec3, gravity: number, drag: number, t: number): void {
  if (drag <= 1e-9) {
    pos.x += vel.x * t;
    pos.y += vel.y * t - 0.5 * gravity * t * t;
    pos.z += vel.z * t;
    vel.y -= gravity * t;
    return;
  }
  const e = Math.exp(-drag * t);
  const k = (1 - e) / drag;
  // terminal velocity is -gravity/drag on y
  const vT = -gravity / drag;
  pos.x += vel.x * k;
  pos.y += vT * t + (vel.y - vT) * k;
  pos.z += vel.z * k;
  vel.x *= e;
  vel.y = vT + (vel.y - vT) * e;
  vel.z *= e;
}

/** Closed-form ball position after `t` seconds (for tests and trajectory previews). */
export function ballisticPosition(out: Vec3, origin: Vec3, vel0: Vec3, gravity: number, drag: number, t: number): Vec3 {
  copy(out, origin);
  const v = clone(vel0);
  ballisticStep(out, v, gravity, drag, t);
  return out;
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * Segment start→end against an AABB (slab test). Returns the entry fraction in
 * [0, 1] and writes the entry face normal, or returns -1 on a miss. A segment that
 * starts inside the box hits at 0 with the normal facing back along the segment.
 */
export function segmentVsBox(start: Vec3, end: Vec3, min: Vec3, max: Vec3, outNormal: Vec3): number {
  let tEnter = 0;
  let tExit = 1;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const a = AXES[i]!;
    const s = start[a];
    const d = end[a] - s;
    if (Math.abs(d) < 1e-12) {
      if (s < min[a] || s > max[a]) return -1;
      continue;
    }
    const inv = 1 / d;
    let tNear = (min[a] - s) * inv;
    let tFar = (max[a] - s) * inv;
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
    }
    if (tNear > tEnter) {
      tEnter = tNear;
      axis = i;
      // moving +axis enters through the min face, whose normal points -axis
      sign = d > 0 ? -1 : 1;
    }
    if (tFar < tExit) tExit = tFar;
    if (tEnter > tExit) return -1;
  }
  if (axis < 0) {
    // started inside: face back along the segment's dominant axis
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    if (ax >= ay && ax >= az) set(outNormal, dx > 0 ? -1 : 1, 0, 0);
    else if (ay >= az) set(outNormal, 0, dy > 0 ? -1 : 1, 0);
    else set(outNormal, 0, 0, dz > 0 ? -1 : 1);
    return 0;
  }
  set(outNormal, 0, 0, 0);
  outNormal[AXES[axis]!] = sign;
  return tEnter;
}

const trace = emptyTrace();
const boxMin = vec3();
const boxMax = vec3();
const boxNormal = vec3();
const bestNormal = vec3();

/**
 * Move one ball one tick. Returns the hit if it struck the world or a target this
 * tick (the ball is then dead), else null. The caller retires balls whose
 * `age >= lifetime`.
 */
export function stepProjectile(p: Projectile, world: CollisionWorld, targets: readonly HitBox[], dt: number): ProjectileHit | null {
  copy(p.prevPos, p.pos);
  ballisticStep(p.pos, p.vel, p.gravity, p.drag, dt);
  p.age += dt;

  traceRay(world, p.prevPos, p.pos, trace);
  const worldHit = trace.startSolid || trace.fraction < 1;
  let bestT = worldHit ? (trace.startSolid ? 0 : trace.fraction) : Infinity;
  let bestTarget = -1;

  const r = p.radius;
  for (const box of targets) {
    if (box.id === p.owner) continue;
    set(boxMin, box.pos.x + box.mins.x - r, box.pos.y + box.mins.y - r, box.pos.z + box.mins.z - r);
    set(boxMax, box.pos.x + box.maxs.x + r, box.pos.y + box.maxs.y + r, box.pos.z + box.maxs.z + r);
    const t = segmentVsBox(p.prevPos, p.pos, boxMin, boxMax, boxNormal);
    if (t >= 0 && t <= bestT) {
      bestT = t;
      bestTarget = box.id;
      copy(bestNormal, boxNormal);
    }
  }

  if (bestTarget >= 0) {
    const point = lerp(vec3(), p.prevPos, p.pos, bestT);
    copy(p.pos, point);
    return { kind: 'target', projectile: p, point, normal: clone(bestNormal), target: bestTarget, brush: -1 };
  }

  if (worldHit) {
    const normal = vec3();
    let point: Vec3;
    if (trace.startSolid) {
      // spawned inside a brush (e.g. eye clipped into a wall): splat where it is
      point = clone(p.prevPos);
      const len = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
      set(normal, -p.vel.x / len, -p.vel.y / len, -p.vel.z / len);
    } else {
      point = clone(trace.endPos);
      copy(normal, trace.normal);
    }
    copy(p.pos, point);
    return { kind: 'world', projectile: p, point, normal, target: -1, brush: trace.brush };
  }

  return null;
}

/**
 * Step every live ball, append hits to `outHits`, and remove balls that hit
 * something or outlived their lifetime. Order of survivors is preserved.
 */
export function stepProjectiles(
  balls: Projectile[],
  world: CollisionWorld,
  targets: readonly HitBox[],
  dt: number,
  outHits: ProjectileHit[],
): void {
  let w = 0;
  for (let i = 0; i < balls.length; i++) {
    const p = balls[i]!;
    const hit = stepProjectile(p, world, targets, dt);
    if (hit) {
      outHits.push(hit);
      continue;
    }
    if (p.age >= p.lifetime) continue;
    balls[w++] = p;
  }
  balls.length = w;
}
