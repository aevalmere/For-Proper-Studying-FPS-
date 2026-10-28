// Where a shot goes: the marker's fixed spray pattern plus random spread that grows
// with movement. Pure and deterministic: randomness comes from the Rng passed in.
//
// shot direction = view angles + pattern[index] × patternScale + random spread
//
// The pattern is added to the view angles (like CS punch angles); random spread is
// applied as a tangent-plane offset around that direction so it stays round at any
// pitch.
//
// Bursts (Spritzer) put one pellet in the middle and the rest evenly around a ring
// near the edge of the pellet cone, spun randomly per shot, then blended toward
// fully random spots by `pelletJitter`. A ring of splats shows how wide the cone is;
// an all-random cone sometimes clumps and hides it.

import { type Vec3, DEG2RAD, lengthXZ, set, vec3 } from './math.ts';
import { type Rng, nextFloat } from './rng.ts';
import type { WeaponDef, WeaponId, WeaponState, WeaponStats } from './weapons.ts';

/** One pattern entry, degrees. +pitch is up, +yaw is left. */
export interface SprayPoint {
  pitch: number;
  yaw: number;
}

/** View or offset angles in radians. */
export interface AimAngles {
  yaw: number;
  pitch: number;
}

/** What spread needs to know about the shooter's movement. */
export interface MoveSample {
  vel: Vec3;
  onGround: boolean;
  ducked: boolean;
  /** movement config's max ground speed, u/s */
  maxSpeed: number;
}

export interface ShotInfo {
  weapon: WeaponId;
  /** pattern index this shot used */
  sprayIndex: number;
  /** random spread radius used, deg */
  spreadDeg: number;
  /** pattern offset applied, radians (after patternScale) */
  patternPitch: number;
  patternYaw: number;
  /** directions written to outDirs[0..pellets) */
  pellets: number;
}

/** Keep the pattern-offset aim off the poles, where yaw degenerates. */
const PITCH_LIMIT = 89 * DEG2RAD;
/** Burst ring radius as a fraction of the pellet cone. */
const PELLET_RING = 0.8;
const TAU = Math.PI * 2;

/** Pattern offset (radians, scaled) for a shot index; indices past the end repeat the last entry. */
export function patternOffset(def: WeaponDef, index: number, out: AimAngles = { yaw: 0, pitch: 0 }): AimAngles {
  const pat = def.pattern;
  if (pat.length === 0) {
    out.pitch = 0;
    out.yaw = 0;
    return out;
  }
  const p = pat[Math.max(0, Math.min(pat.length - 1, index))]!;
  const s = def.stats.patternScale * DEG2RAD;
  out.pitch = p.pitch * s;
  out.yaw = p.yaw * s;
  return out;
}

/**
 * Random spread radius in degrees for the shot at `sprayIndex`.
 * Standing still, the first shot of a burst uses `firstShotSpreadDeg` (0 by default:
 * pinpoint), later shots `standSpreadDeg`. Horizontal speed above the threshold adds
 * a penalty that reaches `moveSpreadDeg` at max speed (and keeps growing up to 2x
 * that when going faster); being airborne adds `airSpreadDeg`; crouching on the
 * ground scales the total by `crouchSpreadScale`.
 */
export function computeSpreadDeg(stats: WeaponStats, sprayIndex: number, move: MoveSample): number {
  let spread = sprayIndex === 0 ? stats.firstShotSpreadDeg : stats.standSpreadDeg;

  const frac = lengthXZ(move.vel) / Math.max(1, move.maxSpeed);
  const t = stats.moveSpreadThreshold;
  if (frac > t) {
    const excess = Math.min(2, (frac - t) / Math.max(1e-6, 1 - t));
    spread += stats.moveSpreadDeg * Math.pow(excess, stats.moveSpreadCurve);
  }

  if (!move.onGround) spread += stats.airSpreadDeg;
  else if (move.ducked) spread *= stats.crouchSpreadScale;
  return spread;
}

/**
 * Unit direction for view angles (yaw, pitch) nudged by tangent-plane offsets:
 * `tanRight` along the view's right vector, `tanUp` along its up vector.
 */
export function aimDirection(out: Vec3, yaw: number, pitch: number, tanRight = 0, tanUp = 0): Vec3 {
  const p = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  // forward = viewForward(yaw, p); right = yawRight(yaw); up = right × forward
  const fx = -sy * cp;
  const fy = sp;
  const fz = -cy * cp;
  if (tanRight === 0 && tanUp === 0) return set(out, fx, fy, fz);
  const rx = cy;
  const rz = -sy;
  const ux = sy * sp;
  const uy = cp;
  const uz = cy * sp;
  const x = fx + rx * tanRight + ux * tanUp;
  const y = fy + uy * tanUp;
  const z = fz + rz * tanRight + uz * tanUp;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  return set(out, x * inv, y * inv, z * inv);
}

const disc = { x: 0, y: 0 };

/**
 * Random point in a disc of `radius`. `uniform` spreads points evenly over the area;
 * otherwise they bunch toward the center (CS-style inaccuracy). Always consumes two
 * Rng values so client and server stay in lockstep.
 */
function randomInDisc(rng: Rng, radius: number, uniform: boolean): typeof disc {
  const a = nextFloat(rng) * Math.PI * 2;
  const u = nextFloat(rng);
  const r = radius * (uniform ? Math.sqrt(u) : u);
  disc.x = r * Math.cos(a);
  disc.y = r * Math.sin(a);
  return disc;
}

const offset: AimAngles = { yaw: 0, pitch: 0 };

/**
 * Compute the directions for the shot at the weapon's current spray index, then
 * advance the index. Writes `stats.pellets` unit vectors into `outDirs` (growing it as
 * needed) and returns what was used, for HUD readouts and view punch.
 */
export function fireShot(
  ws: WeaponState,
  def: WeaponDef,
  aim: AimAngles,
  move: MoveSample,
  rng: Rng,
  outDirs: Vec3[],
): ShotInfo {
  const stats = def.stats;
  const index = ws.sprayIndex;
  const spreadDeg = computeSpreadDeg(stats, index, move);
  patternOffset(def, index, offset);

  const yaw = aim.yaw + offset.yaw;
  const pitch = aim.pitch + offset.pitch;

  randomInDisc(rng, spreadDeg * DEG2RAD, false);
  const shotRight = Math.tan(disc.x);
  const shotUp = Math.tan(disc.y);

  const pellets = Math.max(1, Math.trunc(stats.pellets));
  const cone = stats.pelletSpreadDeg * DEG2RAD;
  const jitter = Math.max(0, Math.min(1, stats.pelletJitter));
  // ring spin; drawn for every burst so the Rng sequence doesn't depend on tuning
  const spin = pellets > 1 ? nextFloat(rng) * TAU : 0;
  for (let i = 0; i < pellets; i++) {
    let right = shotRight;
    let up = shotUp;
    if (pellets > 1) {
      // fixed spot (middle, or evenly on the ring), blended toward a random one;
      // both lie inside the cone, so the blend does too
      const a = spin + ((i - 1) / (pellets - 1)) * TAU;
      const fx = i === 0 ? 0 : Math.cos(a) * cone * PELLET_RING;
      const fy = i === 0 ? 0 : Math.sin(a) * cone * PELLET_RING;
      randomInDisc(rng, cone, true);
      right += Math.tan(fx + (disc.x - fx) * jitter);
      up += Math.tan(fy + (disc.y - fy) * jitter);
    }
    outDirs[i] ??= vec3();
    aimDirection(outDirs[i]!, yaw, pitch, right, up);
  }

  ws.sprayIndex = Math.min(index + 1, Math.max(0, def.pattern.length - 1));
  return {
    weapon: def.id,
    sprayIndex: index,
    spreadDeg,
    patternPitch: offset.pitch,
    patternYaw: offset.yaw,
    pellets,
  };
}
