// Paintball markers: definitions, trigger/fire-rate logic, and the per-tick shooter
// step that the client runs for prediction and the server will run authoritatively.
//
// Angles in tunables and patterns are authored in degrees (fields end in `Deg`, or
// say so in their doc) because they are easier to tune by hand; everything the sim
// computes from them is radians, per the view-angle convention in math.ts.

import type { Vec3 } from './math.ts';
import type { TunableMeta } from './index.ts';
import type { Rng } from './rng.ts';
import { type MoveSample, type ShotInfo, type SprayPoint, computeSpreadDeg, fireShot } from './spray.ts';
import { type Projectile, spawnProjectile } from './projectile.ts';

export type WeaponId = 'splatter' | 'lobber' | 'spritzer';

/** Slot order: `UserCmd.weapon` indexes this (keys 1/2/3). */
export const LOADOUT: readonly WeaponId[] = ['splatter', 'lobber', 'spritzer'];

/** Tunable stats. Number/boolean fields only, so the dev panel can build controls. */
export interface WeaponStats {
  /** hold to fire; false = semi-auto (one shot per press) */
  automatic: boolean;
  /** shots per minute */
  rpm: number;
  /**
   * a press this close (ms) before the marker is ready again is kept and fires the
   * moment it is, even if the button was already let go; earlier presses are dropped
   */
  triggerBufferMs: number;
  /** balls per hopper; also the spray pattern length */
  hopperSize: number;
  /** balls per shot (Spritzer fires a burst) */
  pellets: number;
  /** muzzle speed, u/s */
  ballSpeed: number;
  /** downward acceleration on the ball, u/s² */
  ballGravity: number;
  /** linear velocity damping, 1/s (0 = none); shortens effective range */
  ballDrag: number;
  /** ball radius, u: the drawn size and the radius used against target hitboxes */
  ballRadius: number;
  /** extra radius against targets only, u; 0 = a hit needs the drawn ball to touch */
  hitRadiusBonus: number;
  /** seconds before an unhit ball pops in the air */
  ballLifetime: number;
  /** paint meter fill per ball (meter is 0..100) */
  paintPerHit: number;
  /** splat decal radius, u */
  splatRadius: number;
  /** multiplier on the spray pattern offsets */
  patternScale: number;
  /** pattern restarts after this long without firing, ms */
  sprayResetMs: number;
  /** random spread of the first shot of a burst while standing still, deg */
  firstShotSpreadDeg: number;
  /** random spread of later shots while standing still, deg */
  standSpreadDeg: number;
  /** horizontal speed, as a fraction of max speed, below which moving adds no spread */
  moveSpreadThreshold: number;
  /** spread added at full max speed, deg */
  moveSpreadDeg: number;
  /** shape of the movement penalty: 1 = linear, >1 = gentle at walk, harsh at run */
  moveSpreadCurve: number;
  /** spread added while airborne, deg */
  airSpreadDeg: number;
  /** total spread multiplier while crouched on the ground */
  crouchSpreadScale: number;
  /** per-ball cone around the shot direction, deg (bursts only) */
  pelletSpreadDeg: number;
  /**
   * bursts only: 0 = pellets in a fixed ring (one in the middle) that shows the cone
   * clearly in the splats, 1 = each pellet anywhere in the cone; in between blends
   */
  pelletJitter: number;
  /** fraction of the pattern offset applied to the camera as view punch */
  viewPunchScale: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** CSS hex color of this marker's paint */
  paintColor: string;
  /**
   * Cumulative aim offsets in degrees, one per shot of a burst (index 0 is the first
   * shot and should be {0,0}). +pitch is up, +yaw is left. Past the end, the last
   * entry repeats.
   */
  pattern: readonly SprayPoint[];
  stats: WeaponStats;
}

/**
 * The stats that shape the movement penalty on spread (`computeSpreadDeg`). Listed so
 * the client can refresh these from code while keeping a player's saved ballistics.
 */
export const MOVEMENT_SPREAD_KEYS = ['moveSpreadThreshold', 'moveSpreadDeg', 'moveSpreadCurve', 'airSpreadDeg'] as const satisfies readonly (keyof WeaponStats)[];

const sp = (pitch: number, yaw: number): SprayPoint => ({ pitch, yaw });

// Movement penalties are Valorant-style: walking (~0.5 x max speed) costs a few
// percent of the run penalty, running costs all of it, and a hop adds more on top.
// With a threshold of 0.3 and a square curve, 0.5 x max speed is (0.2/0.7)^2 = 8%.

// Splatter: climbs for the first ~10 shots, drifts left until ~shot 20, then swings
// back right past center. Learn it by pulling down, then right, then left.
const SPLATTER_PATTERN: SprayPoint[] = [
  sp(0, 0), sp(0.45, 0), sp(1.0, 0.05), sp(1.6, -0.04), sp(2.2, 0.06),
  sp(2.75, -0.02), sp(3.25, 0.08), sp(3.7, 0.05), sp(4.1, 0.12), sp(4.4, 0.15),
  sp(4.5, 0.35), sp(4.58, 0.6), sp(4.64, 0.85), sp(4.7, 1.1), sp(4.75, 1.32),
  sp(4.8, 1.52), sp(4.83, 1.68), sp(4.86, 1.8), sp(4.9, 1.86), sp(4.92, 1.88),
  sp(4.95, 1.7), sp(4.98, 1.4), sp(5.0, 1.05), sp(5.0, 0.7), sp(5.02, 0.35),
  sp(5.05, 0), sp(5.05, -0.3), sp(5.06, -0.55), sp(5.08, -0.75), sp(5.1, -0.9),
];

// Lobber: hard climb on quick follow-ups. The fire interval (429 ms at 140 RPM) is
// just under the 450 ms spray reset, so firing at the max rate climbs, while waiting
// a moment longer than the interval stays on shot 0.
const LOBBER_PATTERN: SprayPoint[] = [
  sp(0, 0), sp(1.8, 0.2), sp(3.2, -0.15), sp(4.2, 0.3), sp(4.9, -0.2), sp(5.4, 0.25), sp(5.7, -0.1), sp(5.9, 0.15),
];

// Spritzer: pump-style kick; its interval is longer than the reset, so in practice
// this only drives the camera kick.
const SPRITZER_PATTERN: SprayPoint[] = [sp(0, 0), sp(2.5, -0.3), sp(4.2, 0.25), sp(5.3, -0.2), sp(6.0, 0.3), sp(6.4, -0.1)];

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  splatter: {
    id: 'splatter',
    name: 'Splatter',
    paintColor: '#ff3fa4',
    pattern: SPLATTER_PATTERN,
    stats: {
      automatic: true,
      rpm: 600,
      triggerBufferMs: 120,
      hopperSize: 30,
      pellets: 1,
      ballSpeed: 3600,
      ballGravity: 600,
      ballDrag: 0,
      ballRadius: 2.25,
      hitRadiusBonus: 0,
      ballLifetime: 0.6,
      paintPerHit: 20,
      splatRadius: 9,
      patternScale: 1,
      sprayResetMs: 450,
      firstShotSpreadDeg: 0,
      standSpreadDeg: 0.35,
      moveSpreadThreshold: 0.3,
      moveSpreadDeg: 7,
      moveSpreadCurve: 2,
      airSpreadDeg: 10,
      crouchSpreadScale: 0.6,
      pelletSpreadDeg: 0,
      pelletJitter: 0.3,
      viewPunchScale: 0.45,
    },
  },
  lobber: {
    id: 'lobber',
    name: 'Lobber',
    paintColor: '#ff9a1f',
    pattern: LOBBER_PATTERN,
    stats: {
      automatic: false,
      rpm: 140,
      triggerBufferMs: 120,
      hopperSize: 8,
      pellets: 1,
      ballSpeed: 2000,
      ballGravity: 900,
      ballDrag: 0,
      ballRadius: 3.75,
      hitRadiusBonus: 0,
      ballLifetime: 3,
      paintPerHit: 50,
      splatRadius: 20,
      patternScale: 1,
      sprayResetMs: 450,
      firstShotSpreadDeg: 0,
      standSpreadDeg: 0.2,
      moveSpreadThreshold: 0.3,
      moveSpreadDeg: 8,
      moveSpreadCurve: 2,
      airSpreadDeg: 12,
      crouchSpreadScale: 0.6,
      pelletSpreadDeg: 0,
      pelletJitter: 0.3,
      viewPunchScale: 0.45,
    },
  },
  spritzer: {
    id: 'spritzer',
    name: 'Spritzer',
    paintColor: '#7cf03c',
    pattern: SPRITZER_PATTERN,
    stats: {
      automatic: false,
      rpm: 70,
      triggerBufferMs: 120,
      hopperSize: 6,
      pellets: 20,
      ballSpeed: 2600,
      ballGravity: 1900,
      ballDrag: 3,
      ballRadius: 1.5,
      hitRadiusBonus: 0,
      ballLifetime: 1.4,
      paintPerHit: 10,
      splatRadius: 5,
      patternScale: 1,
      sprayResetMs: 450,
      firstShotSpreadDeg: 0,
      standSpreadDeg: 0.5,
      moveSpreadThreshold: 0.3,
      moveSpreadDeg: 4.5,
      moveSpreadCurve: 2,
      airSpreadDeg: 6,
      crouchSpreadScale: 0.6,
      pelletSpreadDeg: 5,
      pelletJitter: 0.3,
      viewPunchScale: 0.4,
    },
  },
};

export const WEAPON_META: Partial<Record<keyof WeaponStats, TunableMeta>> = {
  rpm: { min: 30, max: 1200, step: 5, label: 'fire rate (RPM)' },
  triggerBufferMs: { min: 0, max: 400, step: 5, label: 'click buffer (ms)' },
  hopperSize: { min: 1, max: 100, step: 1, label: 'hopper size' },
  pellets: { min: 1, max: 20, step: 1, label: 'balls per shot' },
  ballSpeed: { min: 300, max: 8000, step: 10, label: 'ball speed (u/s)' },
  ballGravity: { min: 0, max: 2000, step: 10, label: 'ball gravity (u/s²)' },
  ballDrag: { min: 0, max: 10, step: 0.05, label: 'ball drag (1/s)' },
  ballRadius: { min: 0.25, max: 8, step: 0.05, label: 'ball radius (u)' },
  hitRadiusBonus: { min: 0, max: 8, step: 0.05, label: 'hit radius bonus (u)' },
  ballLifetime: { min: 0.05, max: 5, step: 0.01, label: 'ball lifetime (s)' },
  paintPerHit: { min: 1, max: 100, step: 1, label: 'paint per hit' },
  splatRadius: { min: 1, max: 64, step: 0.5, label: 'splat radius (u)' },
  patternScale: { min: 0, max: 3, step: 0.01, label: 'pattern scale' },
  sprayResetMs: { min: 50, max: 2000, step: 10, label: 'spray reset (ms)' },
  firstShotSpreadDeg: { min: 0, max: 5, step: 0.01, label: 'first shot spread (°)' },
  standSpreadDeg: { min: 0, max: 5, step: 0.01, label: 'standing spread (°)' },
  moveSpreadThreshold: { min: 0, max: 0.9, step: 0.01, label: 'move threshold (× max speed)' },
  moveSpreadDeg: { min: 0, max: 20, step: 0.1, label: 'move spread at max speed (°)' },
  moveSpreadCurve: { min: 0.25, max: 4, step: 0.05, label: 'move spread curve' },
  airSpreadDeg: { min: 0, max: 30, step: 0.1, label: 'airborne spread (°)' },
  crouchSpreadScale: { min: 0, max: 1, step: 0.01, label: 'crouch spread ×' },
  pelletSpreadDeg: { min: 0, max: 20, step: 0.1, label: 'pellet cone (°)' },
  pelletJitter: { min: 0, max: 1, step: 0.01, label: 'pellet jitter (0 ring, 1 random)' },
  viewPunchScale: { min: 0, max: 1.5, step: 0.01, label: 'view punch ×' },
};

/** Weapon id for a loadout slot; out-of-range slots clamp. */
export function weaponAtSlot(slot: number): WeaponId {
  const i = Math.max(0, Math.min(LOADOUT.length - 1, Math.trunc(slot) || 0));
  return LOADOUT[i]!;
}

/** Deep copy of the definitions, for a live set the dev panel can mutate. */
export function cloneWeaponDefs(src: Record<WeaponId, WeaponDef> = WEAPONS): Record<WeaponId, WeaponDef> {
  const out = {} as Record<WeaponId, WeaponDef>;
  for (const id of Object.keys(src) as WeaponId[]) {
    const d = src[id];
    out[id] = { ...d, pattern: d.pattern.map((p) => ({ ...p })), stats: { ...d.stats } };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paint meter

export const PAINT_FULL = 100;

export interface Paintable {
  /** 0..PAINT_FULL */
  paint: number;
  splatted: boolean;
}

/** Add paint; returns true if this hit filled the meter. Splatted targets ignore paint. */
export function applyPaint(t: Paintable, amount: number): boolean {
  if (t.splatted) return false;
  t.paint = Math.min(PAINT_FULL, t.paint + amount);
  if (t.paint >= PAINT_FULL) {
    t.splatted = true;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trigger and fire rate

export interface WeaponState {
  /** balls left in the hopper */
  ammo: number;
  /** pattern index of the next shot; 0 = first shot of a burst */
  sprayIndex: number;
  /** seconds until the next shot may fire; carries the remainder while firing */
  cooldown: number;
  /** seconds since the last shot (capped), drives the spray reset */
  sinceShot: number;
  /** trigger state last tick, for semi-auto edge detection */
  triggerWasDown: boolean;
  /** a press arrived within triggerBufferMs of the marker being ready; fires when it is */
  queued: boolean;
  /** shots fired over the weapon's lifetime */
  shots: number;
}

/** Cap for `sinceShot` so the value stays finite (JSON has no Infinity). */
const SINCE_SHOT_CAP = 1000;
/** Absorbs float error so e.g. 600 RPM at 64 Hz fires exactly on ticks 0, 7, 13, ... */
const COOLDOWN_EPS = 1e-9;
/** Guard against absurd RPMs firing unbounded shots in one tick. */
export const MAX_SHOTS_PER_TICK = 4;

export function createWeaponState(stats: WeaponStats): WeaponState {
  return {
    ammo: stats.hopperSize,
    sprayIndex: 0,
    cooldown: 0,
    sinceShot: SINCE_SHOT_CAP,
    triggerWasDown: false,
    queued: false,
    shots: 0,
  };
}

export function refillHopper(ws: WeaponState, stats: WeaponStats): void {
  ws.ammo = stats.hopperSize;
}

/**
 * Advance the trigger one tick and return how many shots fire this tick (usually 0
 * or 1). Handles fire rate, semi-auto edge detection, the click buffer, ammo, and
 * the spray reset timer. Pattern index advancing per shot is done by `fireShot`.
 */
export function triggerWeapon(ws: WeaponState, stats: WeaponStats, fireDown: boolean, dt: number, infiniteAmmo: boolean): number {
  const press = fireDown && !ws.triggerWasDown;
  ws.triggerWasDown = fireDown;

  ws.sinceShot = Math.min(ws.sinceShot + dt, SINCE_SHOT_CAP);
  if (ws.sinceShot >= stats.sprayResetMs / 1000) ws.sprayIndex = 0;

  // A click just before the marker is ready is kept instead of eaten, so tapping a
  // semi-auto at its max rate fires every time. Clicks earlier than that are dropped.
  if (press && ws.cooldown > COOLDOWN_EPS && ws.cooldown <= stats.triggerBufferMs / 1000 + COOLDOWN_EPS) ws.queued = true;

  const interval = 60 / Math.max(1, stats.rpm);
  const wants = (fireDown && (stats.automatic || press)) || ws.queued;
  let shots = 0;
  if (wants) {
    while (ws.cooldown <= COOLDOWN_EPS && shots < MAX_SHOTS_PER_TICK && (infiniteAmmo || ws.ammo > 0)) {
      shots++;
      ws.cooldown += interval;
      if (!infiniteAmmo) ws.ammo--;
      if (!stats.automatic) break;
    }
  }
  // fired, or ready but dry: either way the queued click is spent
  if (shots > 0 || ws.cooldown <= COOLDOWN_EPS) ws.queued = false;

  ws.cooldown -= dt;
  // Carry the remainder only while actually firing; otherwise a held semi trigger or
  // an empty hopper would bank time and release a burst later.
  const firing = wants && (infiniteAmmo || ws.ammo > 0 || shots > 0);
  if (!firing && ws.cooldown < 0) ws.cooldown = 0;

  if (shots > 0) {
    ws.sinceShot = 0;
    ws.shots += shots;
  }
  return shots;
}

/**
 * Pattern index a shot fired on the next tick would use: the current index, or 0 if
 * the spray reset lands first. Same arithmetic as `triggerWeapon`.
 */
export function nextSprayIndex(ws: WeaponState, stats: WeaponStats, dt: number): number {
  return Math.min(ws.sinceShot + dt, SINCE_SHOT_CAP) >= stats.sprayResetMs / 1000 ? 0 : ws.sprayIndex;
}

/**
 * Random spread (deg) of a shot fired on the next tick with this movement. Equals
 * that shot's `ShotInfo.spreadDeg` if the movement doesn't change in between.
 */
export function nextShotSpreadDeg(ws: WeaponState, stats: WeaponStats, move: MoveSample, dt: number): number {
  return computeSpreadDeg(stats, nextSprayIndex(ws, stats, dt), move);
}

/**
 * Half-angle (deg) of the cone every ball of the next shot lands in, around that
 * shot's aim (view angles plus pattern offset): the shot spread, plus the pellet
 * cone for bursts. This is what a dynamic crosshair should show.
 */
export function aimConeDeg(ws: WeaponState, stats: WeaponStats, move: MoveSample, dt: number): number {
  const burst = Math.trunc(stats.pellets) > 1 ? stats.pelletSpreadDeg : 0;
  return nextShotSpreadDeg(ws, stats, move, dt) + burst;
}

// ---------------------------------------------------------------------------
// Shooter: one player's loadout, stepped once per tick

export interface ShooterState {
  /** loadout slot of the held marker */
  active: number;
  /** per-slot weapon state, parallel to LOADOUT */
  weapons: WeaponState[];
  /** id for the next spawned ball */
  nextBallId: number;
}

export interface ShooterInput {
  fire: boolean;
  /** requested loadout slot (UserCmd.weapon) */
  weapon: number;
  /** view angles, radians */
  yaw: number;
  pitch: number;
  /** shot origin (eye position) */
  eye: Vec3;
  move: MoveSample;
}

export interface ShooterOptions {
  infiniteAmmo: boolean;
  /** player id stamped on spawned balls; hitboxes with the same id are skipped */
  owner: number;
}

export function createShooterState(defs: Record<WeaponId, WeaponDef> = WEAPONS): ShooterState {
  return { active: 0, weapons: LOADOUT.map((id) => createWeaponState(defs[id].stats)), nextBallId: 1 };
}

const pelletDirs: Vec3[] = [];

/**
 * Advance a shooter one tick: switch markers, run every trigger, and spawn balls for
 * the shots fired. New balls are appended to `outBalls` (not yet stepped); one
 * `ShotInfo` per shot is appended to `outShots` if given. Spent balls in `pool` are
 * recycled before new ones are allocated.
 */
export function stepShooter(
  s: ShooterState,
  defs: Record<WeaponId, WeaponDef>,
  input: ShooterInput,
  rng: Rng,
  dt: number,
  opts: ShooterOptions,
  outBalls: Projectile[],
  outShots?: ShotInfo[],
  pool?: Projectile[],
): void {
  const slot = Math.max(0, Math.min(LOADOUT.length - 1, Math.trunc(input.weapon) || 0));
  if (slot !== s.active) {
    // a click queued on the marker being put away must not fire later
    s.weapons[s.active]!.queued = false;
    s.active = slot;
    // A trigger held through the switch must not fire a semi-auto marker.
    s.weapons[slot]!.triggerWasDown = input.fire;
  }

  for (let i = 0; i < LOADOUT.length; i++) {
    const def = defs[LOADOUT[i]!];
    const ws = s.weapons[i]!;
    const shots = triggerWeapon(ws, def.stats, i === s.active && input.fire, dt, opts.infiniteAmmo);
    for (let k = 0; k < shots; k++) {
      const info = fireShot(ws, def, input, input.move, rng, pelletDirs);
      for (let p = 0; p < info.pellets; p++) {
        outBalls.push(spawnProjectile(s.nextBallId++, opts.owner, def.id, def.stats, input.eye, pelletDirs[p]!, pool?.pop()));
      }
      outShots?.push(info);
    }
  }
}
