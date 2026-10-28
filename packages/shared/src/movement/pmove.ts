// Quake / Half-Life player movement. Acceleration, friction, air control, jump and
// duck are ported from SUCC (MIT, see THIRD_PARTY_NOTICES.md); collision response is
// rebuilt on traceBox after the published Quake / Half-Life SDK pmove (PM_FlyMove,
// PM_WalkMove, PM_ClipVelocity, PM_CategorizePosition, PM_Duck) instead of Godot's
// move_and_slide.
//
// Axes: Quake is Z-up and this sim is Y-up, so every Quake `[2]` is `.y` here.
// `pos` is the feet (centre-bottom of the hull). Quake's origin is mid-hull, so the
// duck code moves the feet where Quake moves the centre.
//
// One tick, in pm_shared.c PM_PlayerMove order:
//   unstick, categorize, duck, half gravity, jump, friction, clamp,
//   walk or air move, categorize, clamp, half gravity, view smoothing.

import { type Vec3, vec3, clone, copy, set, add, scale, madd, dot, length, yawForward, yawRight } from '../math.ts';
import { Buttons, type UserCmd } from '../input.ts';
import type { CollisionWorld, TraceResult } from '../world/types.ts';
import { emptyTrace, testBox, traceBox } from '../world/collision.ts';
import type { MovementConfig } from './config.ts';

export interface PlayerState {
  /** origin: center-bottom of the hull (feet) */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  /** normal of the ground under the feet; (0, 1, 0) while airborne */
  groundNormal: Vec3;
  /** using the ducked hull (HL FL_DUCKING); speed is scaled by duckSpeedScale */
  ducked: boolean;
  /** grounded duck in progress (HL bInDuck): eye lowering, hull still standing */
  inDuck: boolean;
  /** seconds into the current grounded duck */
  duckTimer: number;
  /** view-only eye lag after unducking or an air duck; decays to 0 */
  eyeOffset: number;
  /** view-only eye lag after a stair step; decays to 0 */
  stepOffset: number;
  /** seconds left on a buffered jump press (MovementConfig.jumpBufferTime) */
  jumpBuffer: number;
  /** true for the tick a jump started */
  jumped: boolean;
  /** downward speed on the tick the player landed, else 0 */
  landSpeed: number;
  /** buttons from the previous tick, for edge-triggered jump */
  oldButtons: number;
}

/** Per-player multipliers from power-ups or the question panel. */
export interface MovementModifiers {
  /** multiplies max speed (and the bhop cap, which is a multiple of it) */
  speedScale: number;
}

export const DEFAULT_MODIFIERS: Readonly<MovementModifiers> = { speedScale: 1 };

export function createPlayerState(pos: Vec3): PlayerState {
  return {
    pos: clone(pos),
    vel: vec3(),
    onGround: false,
    groundNormal: vec3(0, 1, 0),
    ducked: false,
    inDuck: false,
    duckTimer: 0,
    eyeOffset: 0,
    stepOffset: 0,
    jumpBuffer: 0,
    jumped: false,
    landSpeed: 0,
    oldButtons: 0,
  };
}

export function clonePlayerState(s: PlayerState): PlayerState {
  return { ...s, pos: clone(s.pos), vel: clone(s.vel), groundNormal: clone(s.groundNormal) };
}

export function getHull(s: PlayerState, cfg: MovementConfig): { mins: Vec3; maxs: Vec3 } {
  const hw = cfg.hullWidth * 0.5;
  return { mins: vec3(-hw, 0, -hw), maxs: vec3(hw, hullHeight(cfg, s.ducked), hw) };
}

/** Eye height above the feet before view smoothing (follows the HL duck spline). */
export function getBaseEyeHeight(s: PlayerState, cfg: MovementConfig): number {
  if (s.ducked) return cfg.duckEyeHeight;
  if (s.inDuck && cfg.duckTime > 0) {
    // PM_SplineFraction: smoothstep over the duck time
    const t = Math.min(1, s.duckTimer / cfg.duckTime);
    const f = t * t * (3 - 2 * t);
    return cfg.standEyeHeight + (cfg.duckEyeHeight - cfg.standEyeHeight) * f;
  }
  return cfg.standEyeHeight;
}

/** Smoothed eye position (duck transition plus stair and air-duck view lag). */
export function getEyePosition(s: PlayerState, cfg: MovementConfig, out: Vec3 = vec3()): Vec3 {
  return set(out, s.pos.x, s.pos.y + getBaseEyeHeight(s, cfg) + s.eyeOffset + s.stepOffset, s.pos.z);
}

// pm_shared.c constants
/** PM_ClipVelocity zeroes velocity components smaller than this. */
const STOP_EPSILON = 0.1;
/** PM_CategorizePosition: rising faster than this is never standing on ground. */
const RISING_SPEED = 180;
/** PM_CategorizePosition probes this far below the feet. */
const GROUND_PROBE = 2;
/** PM_Friction edge probe reach below the hull's half height. */
const EDGE_PROBE_DEPTH = 34;
const MAX_CLIP_PLANES = 5;
const MAX_BUMPS = 4;
// not from HL
/** SUCC MIN_FLAT_STEP_NORMAL_Y: only steps onto flat ground get stair view smoothing. */
const FLAT_NORMAL_Y = 0.99;
/** Height changes below this are settling, not steps. */
const STEP_SMOOTH_MIN = 0.5;
/** How far unstick searches for free space. */
const UNSTICK_RANGE = 32;

// Scratch (the sim is single-threaded; nothing here survives a call).
const tr: TraceResult = emptyTrace();
const hullMins = vec3();
const hullMaxs = vec3();
const probeMins = vec3();
const probeMaxs = vec3();
const fwd = vec3();
const rgt = vec3();
const wishdir = vec3();
const end = vec3();
const tmp = vec3();
const original = vec3();
const startPos = vec3();
const startVel = vec3();
const primal = vec3();
const downPos = vec3();
const downVel = vec3();
const crease = vec3();
const planes: Vec3[] = Array.from({ length: MAX_CLIP_PLANES }, () => vec3());

/** Advance one tick. Mutates `s`. */
export function stepPlayer(
  s: PlayerState,
  cmd: UserCmd,
  cfg: MovementConfig,
  world: CollisionWorld,
  dt: number,
  mods: MovementModifiers = DEFAULT_MODIFIERS,
): void {
  if (!(dt > 0)) return;
  const buttons = cmd.buttons | 0;
  s.jumped = false;
  s.landSpeed = 0;

  unstick(s, cfg, world);
  categorize(s, cfg, world, true);
  const startedOnGround = s.onGround;
  const fallSpeed = startedOnGround ? 0 : -s.vel.y;

  duck(s, buttons, cfg, world, dt);

  // Wish direction from the view yaw; magnitude clamps to 1 so diagonals aren't faster.
  yawForward(fwd, cmd.yaw);
  yawRight(rgt, cmd.yaw);
  const fm = clampUnit(cmd.forward);
  const sm = clampUnit(cmd.side);
  let wx = fwd.x * fm + rgt.x * sm;
  let wz = fwd.z * fm + rgt.z * sm;
  const mag = Math.sqrt(wx * wx + wz * wz);
  let wishspeed = 0;
  if (mag > 1e-6) {
    wx /= mag;
    wz /= mag;
    wishspeed = Math.min(mag, 1) * wishMaxSpeed(s, buttons, cfg, mods);
  } else {
    wx = 0;
    wz = 0;
  }
  set(wishdir, wx, 0, wz);

  // Gravity in two halves around the move (PM_AddCorrectGravity / PM_FixupGravityVelocity)
  // so the move uses the mid-tick velocity: jump arcs are exact at any tick rate.
  const halfGravity = cfg.gravity * 0.5 * dt;
  s.vel.y -= halfGravity;

  jump(s, buttons, cfg, mods, dt, halfGravity);

  // Friction runs after the jump check, so a jump on the landing tick keeps all its speed.
  if (s.onGround) {
    s.vel.y = 0;
    friction(s, cfg, world, dt);
  }
  checkVelocity(s, cfg);

  const walked = s.onGround;
  const startY = s.pos.y;
  if (walked) walkMove(s, cfg, world, dt, wishspeed);
  else airMove(s, cfg, world, dt, wishspeed);

  if (s.jumped) {
    s.onGround = false;
    set(s.groundNormal, 0, 1, 0);
  } else {
    // After a ground move the vertical velocity is just ramp-following, so skip the
    // rising-speed test: running up a ramp at any speed stays grounded.
    categorize(s, cfg, world, !walked);
  }
  if (!startedOnGround && s.onGround) s.landSpeed = Math.max(0, fallSpeed);

  checkVelocity(s, cfg);
  s.vel.y -= halfGravity;
  if (s.onGround) s.vel.y = 0;

  smoothView(s, cfg, dt, walked && s.onGround ? s.pos.y - startY : 0);
  s.oldButtons = buttons;
}

// ---------------------------------------------------------------- helpers

function clampUnit(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v || 0;
}

function approach(v: number, target: number, step: number): number {
  if (v > target) return Math.max(target, v - step);
  if (v < target) return Math.min(target, v + step);
  return v;
}

function hullHeight(cfg: MovementConfig, ducked: boolean): number {
  return ducked ? cfg.duckHeight : cfg.standHeight;
}

function setHull(cfg: MovementConfig, ducked: boolean): void {
  const hw = cfg.hullWidth * 0.5;
  set(hullMins, -hw, 0, -hw);
  set(hullMaxs, hw, hullHeight(cfg, ducked), hw);
}

function trace(world: CollisionWorld, start: Vec3, to: Vec3): TraceResult {
  return traceBox(world, start, to, hullMins, hullMaxs, tr);
}

function wishMaxSpeed(s: PlayerState, buttons: number, cfg: MovementConfig, mods: MovementModifiers): number {
  let max = cfg.maxSpeed * mods.speedScale;
  if (s.ducked) max *= cfg.duckSpeedScale;
  if (buttons & Buttons.WALK) max *= cfg.walkSpeedScale;
  return Math.max(0, max);
}

/** How far the feet tuck up when ducking in the air (HL: half the hull difference). */
function airDuckLift(cfg: MovementConfig): number {
  const f = Math.min(1, Math.max(0, cfg.airDuckLift));
  return f * Math.max(0, cfg.standHeight - cfg.duckHeight);
}

function eyeY(s: PlayerState, cfg: MovementConfig): number {
  return s.pos.y + getBaseEyeHeight(s, cfg) + s.eyeOffset;
}

// ---------------------------------------------------------------- position

/** PM_CheckStuck, simplified: if the hull starts in solid, find the nearest free spot. */
function unstick(s: PlayerState, cfg: MovementConfig, world: CollisionWorld): void {
  setHull(cfg, s.ducked);
  if (!testBox(world, s.pos, hullMins, hullMaxs)) return;
  for (let d = 1; d <= UNSTICK_RANGE; d++) {
    if (tryOffset(s, world, 0, d, 0)) return;
  }
  for (let d = 1; d <= UNSTICK_RANGE; d++) {
    if (tryOffset(s, world, d, 0, 0) || tryOffset(s, world, -d, 0, 0)) return;
    if (tryOffset(s, world, 0, 0, d) || tryOffset(s, world, 0, 0, -d)) return;
  }
  if (!s.ducked) {
    setHull(cfg, true);
    if (!testBox(world, s.pos, hullMins, hullMaxs)) {
      s.ducked = true;
      s.inDuck = false;
    }
  }
}

function tryOffset(s: PlayerState, world: CollisionWorld, dx: number, dy: number, dz: number): boolean {
  set(tmp, s.pos.x + dx, s.pos.y + dy, s.pos.z + dz);
  if (testBox(world, tmp, hullMins, hullMaxs)) return false;
  copy(s.pos, tmp);
  return true;
}

/**
 * PM_CategorizePosition: on ground if the hull, moved 2 units down, hits a surface
 * with normal.y >= minGroundNormal; snaps down onto it.
 */
function categorize(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, checkRising: boolean): void {
  if (checkRising && s.vel.y > RISING_SPEED) {
    s.onGround = false;
    set(s.groundNormal, 0, 1, 0);
    return;
  }
  setHull(cfg, s.ducked);
  set(end, s.pos.x, s.pos.y - GROUND_PROBE, s.pos.z);
  const t = trace(world, s.pos, end);
  if (t.fraction < 1 && !t.allSolid && t.normal.y >= cfg.minGroundNormal) {
    s.onGround = true;
    copy(s.groundNormal, t.normal);
    if (!t.startSolid) copy(s.pos, t.endPos);
  } else {
    s.onGround = false;
    set(s.groundNormal, 0, 1, 0);
  }
}

// ---------------------------------------------------------------- duck

/**
 * PM_Duck. On the ground the eye eases down over duckTime and the hull shrinks at
 * the end (the feet stay put). In the air the duck finishes at once and the feet tuck
 * up by airDuckLift of the hull difference, which is what makes crouch-jumps reach
 * higher ledges. Both are collision-safe: the ducked hull sits inside the standing one.
 * Standing up needs room for the standing hull (below the feet when airborne).
 */
function duck(s: PlayerState, buttons: number, cfg: MovementConfig, world: CollisionWorld, dt: number): void {
  if (buttons & Buttons.CROUCH) {
    if (!s.ducked && !s.inDuck) {
      s.inDuck = true;
      s.duckTimer = 0;
    }
    if (s.inDuck) {
      if (s.onGround) s.duckTimer += dt;
      if (!s.onGround || s.duckTimer >= cfg.duckTime) finishDuck(s, cfg);
    }
  } else if (s.ducked || s.inDuck) {
    unduck(s, cfg, world);
  }
}

function finishDuck(s: PlayerState, cfg: MovementConfig): void {
  const before = eyeY(s, cfg);
  s.inDuck = false;
  s.duckTimer = 0;
  s.ducked = true;
  if (!s.onGround) s.pos.y += airDuckLift(cfg);
  // keep the eye where it was; eyeOffset eases it to the new height
  s.eyeOffset += before - eyeY(s, cfg);
}

function unduck(s: PlayerState, cfg: MovementConfig, world: CollisionWorld): void {
  const before = eyeY(s, cfg);
  if (s.ducked) {
    copy(tmp, s.pos);
    if (!s.onGround) tmp.y -= airDuckLift(cfg);
    setHull(cfg, false);
    if (testBox(world, tmp, hullMins, hullMaxs)) return; // no room: stay ducked, retry next tick
    copy(s.pos, tmp);
  }
  s.ducked = false;
  s.inDuck = false;
  s.duckTimer = 0;
  s.eyeOffset += before - eyeY(s, cfg);
}

// ---------------------------------------------------------------- jump

function jump(
  s: PlayerState,
  buttons: number,
  cfg: MovementConfig,
  mods: MovementModifiers,
  dt: number,
  halfGravity: number,
): void {
  const held = (buttons & Buttons.JUMP) !== 0;
  const pressed = held && (s.oldButtons & Buttons.JUMP) === 0;
  if (s.jumpBuffer > 0) s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);

  if (!s.onGround) {
    if (pressed && cfg.jumpBufferTime > 0) s.jumpBuffer = cfg.jumpBufferTime;
    return;
  }
  // HL: holding jump does nothing until it's released and pressed again ("don't pogo stick")
  if (!(pressed || (held && cfg.autoBhop) || s.jumpBuffer > 0)) return;

  // PM_PreventMegaBunnyJumping, on horizontal speed. bhopCapCrop 1 clamps to the cap;
  // HL's 0.65 (CS 1.6: 0.8) punishes going over it.
  if (cfg.bhopCapFactor > 0) {
    const cap = cfg.bhopCapFactor * cfg.maxSpeed * mods.speedScale;
    const spd = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
    if (cap > 0 && spd > cap) {
      const f = (cap / spd) * cfg.bhopCapCrop;
      s.vel.x *= f;
      s.vel.z *= f;
    }
  }

  // SUCC: the impulse comes from the jump height (goldsrc: sqrt(2 * 800 * 45) = 268.33,
  // HL's hardcoded value), minus the half-tick of gravity PM_Jump applies.
  s.vel.y = Math.sqrt(2 * Math.max(0, cfg.gravity) * Math.max(0, cfg.jumpHeight)) - halfGravity;
  s.onGround = false;
  set(s.groundNormal, 0, 1, 0);
  s.jumped = true;
  s.jumpBuffer = 0;
}

// ---------------------------------------------------------------- friction / accel

/** PM_Friction on horizontal speed (SUCC: a 3D length would brake harder after falls). */
function friction(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, dt: number): void {
  const vx = s.vel.x;
  const vz = s.vel.z;
  const speed = Math.sqrt(vx * vx + vz * vz);
  if (speed < 0.1) return;

  let fric = cfg.friction;
  if (cfg.edgeFriction !== 1 && overEdge(s, cfg, world, vx / speed, vz / speed)) fric *= cfg.edgeFriction;

  // below stopSpeed, bleed a fixed amount so slow drift stops instead of tapering
  const control = speed < cfg.stopSpeed ? cfg.stopSpeed : speed;
  let newspeed = speed - control * fric * dt;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;
  s.vel.x *= newspeed;
  s.vel.z *= newspeed;
}

/**
 * HL sv_edgefriction probe: a hull-footprint box half a hull width ahead, covering
 * from half the hull height above the feet to 34 units below the hull bottom HL uses.
 * Empty means the ground drops away ahead.
 */
function overEdge(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, dx: number, dz: number): boolean {
  const hw = cfg.hullWidth * 0.5;
  const half = hullHeight(cfg, s.ducked) * 0.5;
  set(probeMins, -hw, 0, -hw);
  set(probeMaxs, hw, half, hw);
  set(tmp, s.pos.x + dx * hw, s.pos.y, s.pos.z + dz * hw);
  set(end, tmp.x, tmp.y - (EDGE_PROBE_DEPTH + half), tmp.z);
  const t = traceBox(world, tmp, end, probeMins, probeMaxs, tr);
  return !t.startSolid && t.fraction === 1;
}

/** PM_Accelerate */
function accelerate(s: PlayerState, dir: Vec3, wishspeed: number, accel: number, dt: number): void {
  const current = dot(s.vel, dir);
  const addspeed = wishspeed - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * dt * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;
  madd(s.vel, s.vel, dir, accelspeed);
}

/**
 * PM_AirAccelerate: like PM_Accelerate but the target speed along the wish direction
 * is capped (30), while the rate still uses the full wish speed. Turning so the wish
 * direction stays nearly perpendicular to the velocity keeps adding speed: air
 * strafing and bunnyhopping.
 */
function airAccelerate(
  s: PlayerState,
  dir: Vec3,
  wishspeed: number,
  accel: number,
  cap: number,
  dt: number,
): void {
  const wishspd = wishspeed > cap ? cap : wishspeed;
  const current = dot(s.vel, dir);
  const addspeed = wishspd - current;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * dt;
  if (accelspeed > addspeed) accelspeed = addspeed;
  madd(s.vel, s.vel, dir, accelspeed);
}

/** PM_CheckVelocity: drop NaNs and clamp each axis to maxVelocity. */
function checkVelocity(s: PlayerState, cfg: MovementConfig): void {
  const m = cfg.maxVelocity;
  const v = s.vel;
  if (!Number.isFinite(v.x)) v.x = 0;
  if (!Number.isFinite(v.y)) v.y = 0;
  if (!Number.isFinite(v.z)) v.z = 0;
  if (m > 0) {
    v.x = v.x > m ? m : v.x < -m ? -m : v.x;
    v.y = v.y > m ? m : v.y < -m ? -m : v.y;
    v.z = v.z > m ? m : v.z < -m ? -m : v.z;
  }
}

// ---------------------------------------------------------------- moves

/** PM_WalkMove */
function walkMove(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, dt: number, wishspeed: number): void {
  s.vel.y = 0;
  accelerate(s, wishdir, wishspeed, cfg.accelerate, dt);
  s.vel.y = 0;
  const spd = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
  if (spd < 1) {
    set(s.vel, 0, 0, 0);
    return;
  }
  setHull(cfg, s.ducked);
  stepSlideMove(s, cfg, world, dt);
  stayOnGround(s, cfg, world);
}

/** PM_AirMove */
function airMove(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, dt: number, wishspeed: number): void {
  airAccelerate(s, wishdir, wishspeed, cfg.airAccelerate, cfg.airSpeedCap, dt);
  setHull(cfg, s.ducked);
  slideMove(s, world, dt);
}

/**
 * The second half of PM_WalkMove (PM_StepSlideMove): if the straight move is blocked,
 * try it twice, once as a plain slide and once lifted by stepSize then pressed back
 * down, and keep whichever went farther horizontally. Steps and stairs cost no speed,
 * and walkable ramps are climbed at full horizontal speed.
 */
function stepSlideMove(s: PlayerState, cfg: MovementConfig, world: CollisionWorld, dt: number): void {
  set(end, s.pos.x + s.vel.x * dt, s.pos.y, s.pos.z + s.vel.z * dt);
  let t = trace(world, s.pos, end);
  if (t.fraction === 1) {
    copy(s.pos, t.endPos);
    return;
  }

  copy(startPos, s.pos);
  copy(startVel, s.vel);

  // plain slide
  slideMove(s, world, dt);
  copy(downPos, s.pos);
  copy(downVel, s.vel);

  // lifted slide
  copy(s.pos, startPos);
  copy(s.vel, startVel);
  set(end, s.pos.x, s.pos.y + cfg.stepSize, s.pos.z);
  t = trace(world, s.pos, end);
  if (!t.startSolid && !t.allSolid) copy(s.pos, t.endPos);
  slideMove(s, world, dt);

  // press back down; it has to land on walkable ground
  set(end, s.pos.x, s.pos.y - cfg.stepSize, s.pos.z);
  t = trace(world, s.pos, end);
  if (t.normal.y < cfg.minGroundNormal) {
    copy(s.pos, downPos);
    copy(s.vel, downVel);
    return;
  }
  if (!t.startSolid && !t.allSolid) copy(s.pos, t.endPos);

  const ddx = downPos.x - startPos.x;
  const ddz = downPos.z - startPos.z;
  const udx = s.pos.x - startPos.x;
  const udz = s.pos.z - startPos.z;
  if (ddx * ddx + ddz * ddz > udx * udx + udz * udz) {
    copy(s.pos, downPos);
    copy(s.vel, downVel);
  } else {
    s.vel.y = downVel.y;
  }
}

/**
 * Source's StayOnGround (SUCC _step_down): after a ground move, drop onto walkable
 * ground up to stepSize below, so walking down stairs and ramps stays grounded.
 */
function stayOnGround(s: PlayerState, cfg: MovementConfig, world: CollisionWorld): void {
  set(end, s.pos.x, s.pos.y - cfg.stepSize, s.pos.z);
  const t = trace(world, s.pos, end);
  if (t.fraction > 0 && t.fraction < 1 && !t.startSolid && t.normal.y >= cfg.minGroundNormal) {
    s.pos.y = t.endPos.y;
  }
}

/**
 * PM_FlyMove (Quake PM_SlideMove): move along the velocity for dt, clipping against
 * up to MAX_CLIP_PLANES surfaces and sliding along creases between two of them.
 */
function slideMove(s: PlayerState, world: CollisionWorld, dt: number): void {
  const v = s.vel;
  let numPlanes = 0;
  copy(original, v);
  copy(primal, v);
  let timeLeft = dt;
  let allFraction = 0;

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    if (v.x === 0 && v.y === 0 && v.z === 0) break;
    madd(end, s.pos, v, timeLeft);
    const t = trace(world, s.pos, end);
    allFraction += t.fraction;
    if (t.allSolid) {
      set(v, 0, 0, 0);
      return;
    }
    if (t.fraction > 0) {
      copy(s.pos, t.endPos);
      copy(original, v);
      numPlanes = 0;
    }
    if (t.fraction === 1) break;

    timeLeft -= timeLeft * t.fraction;
    if (numPlanes >= MAX_CLIP_PLANES) {
      set(v, 0, 0, 0);
      break;
    }

    // Re-hitting a plane we're already sliding on (a zero-length move): nudge off it
    // instead of treating it as a second plane (Quake 3 PM_SlideMove).
    let dup = false;
    for (let i = 0; i < numPlanes; i++) {
      if (dot(t.normal, planes[i]!) > 0.99) {
        dup = true;
        break;
      }
    }
    if (dup) {
      add(v, v, t.normal);
      continue;
    }
    copy(planes[numPlanes]!, t.normal);
    numPlanes++;

    // find a clip that doesn't push into any other plane
    let i = 0;
    for (; i < numPlanes; i++) {
      clipVelocity(original, planes[i]!, v);
      let j = 0;
      for (; j < numPlanes; j++) {
        if (j !== i && dot(v, planes[j]!) < 0) break;
      }
      if (j === numPlanes) break;
    }
    if (i === numPlanes) {
      // go along the crease (normalized, as in Quake 3)
      if (numPlanes !== 2) {
        set(v, 0, 0, 0);
        break;
      }
      cross(crease, planes[0]!, planes[1]!);
      const len = length(crease);
      if (len < 1e-6) {
        set(v, 0, 0, 0);
        break;
      }
      scale(crease, crease, 1 / len);
      scale(v, crease, dot(crease, v));
    }
    // turned back against the original direction: stop dead to avoid jitter in corners
    if (dot(v, primal) <= 0) {
      set(v, 0, 0, 0);
      break;
    }
  }
  if (allFraction === 0) set(v, 0, 0, 0);
}

/** PM_ClipVelocity with overbounce 1: remove the part of `inp` going into the plane. */
function clipVelocity(inp: Vec3, n: Vec3, out: Vec3): void {
  const backoff = dot(inp, n);
  out.x = inp.x - n.x * backoff;
  out.y = inp.y - n.y * backoff;
  out.z = inp.z - n.z * backoff;
  if (out.x > -STOP_EPSILON && out.x < STOP_EPSILON) out.x = 0;
  if (out.y > -STOP_EPSILON && out.y < STOP_EPSILON) out.y = 0;
  if (out.z > -STOP_EPSILON && out.z < STOP_EPSILON) out.z = 0;
}

function cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  return set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

// ---------------------------------------------------------------- view

/**
 * View-only smoothing (it never feeds back into movement). Stair steps onto flat
 * ground are absorbed into stepOffset and eased out at stepSmoothSpeed (HL view.cpp
 * uses 150 u/s, capped at one step); duck height changes ease out of eyeOffset.
 */
function smoothView(s: PlayerState, cfg: MovementConfig, dt: number, rise: number): void {
  if (cfg.stepSmoothSpeed > 0) {
    if (Math.abs(rise) > STEP_SMOOTH_MIN && s.groundNormal.y >= FLAT_NORMAL_Y) {
      const lim = Math.max(0, cfg.stepSize);
      s.stepOffset = Math.min(lim, Math.max(-lim, s.stepOffset - rise));
    }
    s.stepOffset = approach(s.stepOffset, 0, cfg.stepSmoothSpeed * dt);
  } else {
    s.stepOffset = 0;
  }
  if (cfg.eyeSmoothSpeed > 0) {
    const lim = Math.max(0, cfg.standHeight);
    s.eyeOffset = approach(Math.min(lim, Math.max(-lim, s.eyeOffset)), 0, cfg.eyeSmoothSpeed * dt);
  } else {
    s.eyeOffset = 0;
  }
}
