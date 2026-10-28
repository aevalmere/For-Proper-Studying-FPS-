// Paintballs are real projectiles: speed, gravity, optional drag, radius, lifetime.
// Each tick a ball moves along its exact ballistic arc, and the chord from the
// previous to the new position is traced against the world and the target hitboxes,
// so fast balls can't tunnel through thin walls or targets.
//
// What you see is what you hit:
// - Targets are vertical capsules (HitCapsule), drawn as the same capsule, so the
//   silhouette and the hit volume match from every side and from above. (The
//   movement hull stays an AABB; that is only for walking into walls.)
// - Against targets a ball is a sphere of its drawn radius, plus `hitRadiusBonus`
//   (0 by default) if hits should be a little generous. A capsule grown by a sphere
//   is still a capsule, so the swept test is one exact segment-vs-capsule check.
// - Against the world a ball is its center point (a ray), like a hitscan bullet: it
//   never snags on a corner the crosshair can see past, and its splat lands where
//   the aim path meets the wall.
//
// Hot-path rules: no allocation per tick. Hits are written into caller-owned objects
// and spent balls can be recycled through spawnProjectile's `out` argument.

import { type Vec3, copy, lerp, scale, set, vec3 } from './math.ts';
import { emptyTrace, traceRay } from './world/collision.ts';
import type { CollisionWorld } from './world/types.ts';
import type { MovementConfig } from './movement/config.ts';
import type { PlayerState } from './movement/pmove.ts';
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
  /** drawn radius, u; also the radius used against targets */
  radius: number;
  /** extra radius against targets only, u (0 = hits match the drawn ball) */
  hitRadiusBonus: number;
  /** seconds since spawn */
  age: number;
  lifetime: number;
  /** paint meter fill on a target hit */
  paint: number;
  splatRadius: number;
}

/**
 * A target's hit volume: a vertical capsule standing on `pos` (the feet, like
 * PlayerState.pos). Its axis runs from `radius` to `height - radius` above the feet;
 * if `height < 2 * radius` it shrinks to a sphere of radius `height / 2`.
 *
 * `prevPos` is where it stood at the start of the tick. Balls are swept against the
 * target's motion over the tick, so a hit happens where the interpolated ball and
 * target visibly meet, not against wherever the target ends the tick.
 */
export interface HitCapsule {
  id: number;
  pos: Vec3;
  prevPos: Vec3;
  radius: number;
  /** total height from the feet, u (stand or duck height) */
  height: number;
}

/**
 * A target that moved farther than this in one tick teleported (respawn): treat it
 * as standing still rather than sweeping balls across the jump. 64 u/tick = 4096 u/s.
 */
export const HITBOX_TELEPORT_DIST = 64;

/**
 * Body zone a hit landed in. There is one zone (no headshot bonus in a classroom
 * game); the field exists so zones can be added without changing the hit format.
 */
export type HitZone = 'none' | 'body';

export interface ProjectileHit {
  kind: 'world' | 'target';
  /** the ball, already removed from the live list */
  projectile: Projectile;
  /** contact point on the struck surface (the ball's center at contact is `projectile.pos`) */
  point: Vec3;
  /** outward surface normal at the hit */
  normal: Vec3;
  /** HitCapsule id for 'target' hits, -1 for 'world' */
  target: number;
  /** brush index for 'world' hits, -1 for 'target' */
  brush: number;
  /** 'body' for target hits, 'none' for world hits */
  zone: HitZone;
}

export function createHitCapsule(id: number, pos: Vec3, radius: number, height: number): HitCapsule {
  return { id, pos: vec3(pos.x, pos.y, pos.z), prevPos: vec3(pos.x, pos.y, pos.z), radius, height };
}

/**
 * Hit volume for a player-sized body: radius is half the hull width, height is the
 * stand or duck hull height, so a ducked player is a shorter target. Writes `out`;
 * the old `pos` becomes `prevPos`, so call it once per tick after the player moves.
 */
export function playerHitCapsule(out: HitCapsule, s: PlayerState, cfg: MovementConfig): HitCapsule {
  copy(out.prevPos, out.pos);
  copy(out.pos, s.pos);
  out.radius = cfg.hullWidth * 0.5;
  out.height = s.ducked ? cfg.duckHeight : cfg.standHeight;
  return out;
}

export function createProjectileHit(): ProjectileHit {
  return {
    kind: 'world',
    projectile: null as unknown as Projectile,
    point: vec3(),
    normal: vec3(),
    target: -1,
    brush: -1,
    zone: 'none',
  };
}

/**
 * New ball at `origin` heading along unit `dir`. Pass a spent ball as `out` to
 * recycle it instead of allocating.
 */
export function spawnProjectile(
  id: number,
  owner: number,
  weapon: WeaponId,
  stats: WeaponStats,
  origin: Vec3,
  dir: Vec3,
  out?: Projectile,
): Projectile {
  const p: Projectile = out ?? {
    id: 0,
    owner: 0,
    weapon,
    pos: vec3(),
    prevPos: vec3(),
    vel: vec3(),
    gravity: 0,
    drag: 0,
    radius: 0,
    hitRadiusBonus: 0,
    age: 0,
    lifetime: 0,
    paint: 0,
    splatRadius: 0,
  };
  p.id = id;
  p.owner = owner;
  p.weapon = weapon;
  copy(p.pos, origin);
  copy(p.prevPos, origin);
  scale(p.vel, dir, stats.ballSpeed);
  p.gravity = stats.ballGravity;
  p.drag = stats.ballDrag;
  p.radius = stats.ballRadius;
  p.hitRadiusBonus = stats.hitRadiusBonus;
  p.age = 0;
  p.lifetime = stats.ballLifetime;
  p.paint = stats.paintPerHit;
  p.splatRadius = stats.splatRadius;
  return p;
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

const posVel = vec3();

/** Closed-form ball position after `t` seconds (for tests and trajectory previews). */
export function ballisticPosition(out: Vec3, origin: Vec3, vel0: Vec3, gravity: number, drag: number, t: number): Vec3 {
  copy(out, origin);
  copy(posVel, vel0);
  ballisticStep(out, posVel, gravity, drag, t);
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

/** Below this squared length a direction counts as zero. */
const TINY = 1e-12;
/**
 * Relative slack on the tangent test, so a ball that grazes at exactly
 * capsule radius + ball radius counts as a hit despite rounding.
 */
const GRAZE_EPS = 1e-9;

/**
 * Entry fraction of the segment o + d·t (o relative to the sphere center) into a
 * sphere of squared radius rr, or -1. Assumes o starts outside the sphere.
 */
function sphereEntry(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, rr: number): number {
  const a = dx * dx + dy * dy + dz * dz;
  if (a < TINY) return -1;
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - rr;
  const disc = b * b - a * c;
  if (disc < -GRAZE_EPS * b * b) return -1;
  const t = (-b - Math.sqrt(Math.max(0, disc))) / a;
  return t >= 0 && t <= 1 ? t : -1;
}

/**
 * First contact of a sphere of radius `r` moving start→end with a vertical capsule.
 * Returns the fraction in [0, 1] along the segment, or -1 on a miss, and writes the
 * capsule's outward normal at the contact. Touching counts. A sphere that starts
 * overlapping hits at 0, with the normal pointing from the capsule axis to the start.
 *
 * Exact for any approach direction: the capsule grown by `r` is the capsule of
 * radius `cap.radius + r`, so this is the segment against that capsule (side
 * cylinder first, then the end spheres). Pure arithmetic, no allocation.
 */
export function sweptSphereVsCapsule(start: Vec3, end: Vec3, r: number, cap: HitCapsule, outNormal: Vec3): number {
  const core = Math.max(0, Math.min(cap.radius, cap.height * 0.5));
  const R = core + Math.max(0, r);
  const cx = cap.pos.x;
  const cz = cap.pos.z;
  const y0 = cap.pos.y + core;
  const y1 = cap.pos.y + cap.height - core;

  // broadphase: the segment's bounds against the grown capsule's bounds
  if (Math.min(start.x, end.x) > cx + R || Math.max(start.x, end.x) < cx - R) return -1;
  if (Math.min(start.z, end.z) > cz + R || Math.max(start.z, end.z) < cz - R) return -1;
  if (Math.min(start.y, end.y) > y1 + R || Math.max(start.y, end.y) < y0 - R) return -1;

  const ox = start.x - cx;
  const oz = start.z - cz;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const rr = R * R;

  // started overlapping: distance from the start to the axis segment
  const ay = start.y < y0 ? y0 : start.y > y1 ? y1 : start.y;
  const sy = start.y - ay;
  const d2 = ox * ox + sy * sy + oz * oz;
  if (d2 <= rr) {
    if (d2 > TINY) {
      const inv = 1 / Math.sqrt(d2);
      set(outNormal, ox * inv, sy * inv, oz * inv);
    } else {
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 0) set(outNormal, -dx / len, -dy / len, -dz / len);
      else set(outNormal, 0, 1, 0);
    }
    return 0;
  }

  // side: the infinite vertical cylinder of radius R, entered within the axis band
  const a = dx * dx + dz * dz;
  const c = ox * ox + oz * oz - rr;
  if (a < TINY) {
    // moving straight up or down: only the end caps can be reached, from inside the cylinder
    if (c > 0) return -1;
  } else if (c > 0) {
    const b = ox * dx + oz * dz;
    const disc = b * b - a * c;
    if (disc < -GRAZE_EPS * b * b) return -1;
    const t = (-b - Math.sqrt(Math.max(0, disc))) / a;
    // both roots share a sign here: behind the start means moving away
    if (t < 0 || t > 1) return -1;
    const y = start.y + dy * t;
    if (y >= y0 && y <= y1) {
      set(outNormal, (ox + dx * t) / R, 0, (oz + dz * t) / R);
      return t;
    }
    // entered the cylinder above or below the band: the matching cap is hit first
  }

  // caps: the end spheres (only the outer hemisphere can be reached first)
  const tTop = sphereEntry(ox, start.y - y1, oz, dx, dy, dz, rr);
  const tBot = y1 > y0 ? sphereEntry(ox, start.y - y0, oz, dx, dy, dz, rr) : -1;
  let t = tTop;
  let centerY = y1;
  if (tBot >= 0 && (t < 0 || tBot < t)) {
    t = tBot;
    centerY = y0;
  }
  if (t < 0) return -1;
  set(outNormal, (ox + dx * t) / R, (start.y + dy * t - centerY) / R, (oz + dz * t) / R);
  return t;
}

const trace = emptyTrace();
const capNormal = vec3();
const bestNormal = vec3();
const relStart = vec3();

/**
 * Move one ball one tick. If it struck the world or a target this tick, writes the
 * hit into `out` (allocated only when a hit happens and none was given), leaves the
 * ball at its contact position, and returns the hit; otherwise returns null. The
 * caller retires balls whose `age >= lifetime`.
 */
export function stepProjectile(
  p: Projectile,
  world: CollisionWorld,
  targets: readonly HitCapsule[],
  dt: number,
  out?: ProjectileHit,
): ProjectileHit | null {
  copy(p.prevPos, p.pos);
  ballisticStep(p.pos, p.vel, p.gravity, p.drag, dt);
  p.age += dt;

  traceRay(world, p.prevPos, p.pos, trace);
  const worldHit = trace.startSolid || trace.fraction < 1;
  let bestT = worldHit ? (trace.startSolid ? 0 : trace.fraction) : 2;
  let bestTarget = -1;

  const r = p.radius + p.hitRadiusBonus;
  for (let i = 0; i < targets.length; i++) {
    const cap = targets[i]!;
    if (cap.id === p.owner) continue;
    // In the target's end-of-tick frame the ball starts offset by the target's own
    // move this tick; the contact fraction is the same in both frames.
    let mx = cap.pos.x - cap.prevPos.x;
    let my = cap.pos.y - cap.prevPos.y;
    let mz = cap.pos.z - cap.prevPos.z;
    if (mx * mx + my * my + mz * mz > HITBOX_TELEPORT_DIST * HITBOX_TELEPORT_DIST) mx = my = mz = 0;
    set(relStart, p.prevPos.x + mx, p.prevPos.y + my, p.prevPos.z + mz);
    const t = sweptSphereVsCapsule(relStart, p.pos, r, cap, capNormal);
    // a target exactly at the wall contact still wins
    if (t >= 0 && t <= bestT) {
      bestT = t;
      bestTarget = cap.id;
      copy(bestNormal, capNormal);
    }
  }

  if (bestTarget < 0 && !worldHit) return null;
  const hit = out ?? createProjectileHit();
  hit.projectile = p;

  if (bestTarget >= 0) {
    lerp(p.pos, p.prevPos, p.pos, bestT);
    hit.kind = 'target';
    hit.target = bestTarget;
    hit.brush = -1;
    hit.zone = 'body';
    copy(hit.normal, bestNormal);
    // the ball's center is r off the surface along the normal
    hit.point.x = p.pos.x - bestNormal.x * r;
    hit.point.y = p.pos.y - bestNormal.y * r;
    hit.point.z = p.pos.z - bestNormal.z * r;
    return hit;
  }

  hit.kind = 'world';
  hit.target = -1;
  hit.brush = trace.brush;
  hit.zone = 'none';
  if (trace.startSolid) {
    // spawned inside a brush (e.g. eye clipped into a wall): splat where it is
    copy(p.pos, p.prevPos);
    const len = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    set(hit.normal, -p.vel.x / len, -p.vel.y / len, -p.vel.z / len);
  } else {
    copy(p.pos, trace.endPos);
    copy(hit.normal, trace.normal);
  }
  copy(hit.point, p.pos);
  return hit;
}

/**
 * Step every live ball and remove the ones that hit something or outlived their
 * lifetime (survivors keep their order).
 *
 * Hits are written into `outHits[0..n)`, reusing the objects already in the array
 * (it grows as needed), and `n` is returned. Entries past `n` are spares from
 * earlier ticks: loop to `n`, or reset `outHits.length = 0` before each call.
 * Balls that timed out without hitting are appended to `expired` if given; together
 * with `outHits[i].projectile` those are free to recycle once the hits are handled.
 */
export function stepProjectiles(
  balls: Projectile[],
  world: CollisionWorld,
  targets: readonly HitCapsule[],
  dt: number,
  outHits: ProjectileHit[],
  expired?: Projectile[],
): number {
  let n = 0;
  let w = 0;
  for (let i = 0; i < balls.length; i++) {
    const p = balls[i]!;
    const hit = stepProjectile(p, world, targets, dt, outHits[n]);
    if (hit) {
      outHits[n++] = hit;
      continue;
    }
    if (p.age >= p.lifetime) {
      expired?.push(p);
      continue;
    }
    balls[w++] = p;
  }
  balls.length = w;
  return n;
}
