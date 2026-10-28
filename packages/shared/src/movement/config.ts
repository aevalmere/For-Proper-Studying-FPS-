// Movement tunables. Ported from SUCC (MIT, see THIRD_PARTY_NOTICES.md): the
// `goldsrc` preset is addons/SUCC/resources/goldsrc.tres converted from metres back
// to Quake units with SUCC's own factor (SUCCConfig.SOURCE_MULT = 39.37 u/m), plus the
// Half-Life pm_shared.c constants SUCC leaves out (duck time, edge friction, the
// 0.7 floor normal, the 0.5 air-duck lift).
//
// Every field is a top-level number or boolean with a MOVEMENT_CONFIG_META entry, so
// the client's dev panel can build a slider for it. Distances are units, speeds u/s,
// times seconds.

export interface MovementConfig {
  // ground
  /** sv_maxspeed: top running speed (u/s). Scaled by MovementModifiers.speedScale. */
  maxSpeed: number;
  /** sv_accelerate: ground acceleration coefficient */
  accelerate: number;
  /** sv_friction: ground friction coefficient */
  friction: number;
  /** sv_stopspeed: below this speed friction acts as if you were moving this fast */
  stopSpeed: number;
  /** sv_edgefriction: friction multiplier when the ground ahead drops away (1 = off) */
  edgeFriction: number;
  /** fraction of max speed while holding WALK (CS cl_movespeedkey) */
  walkSpeedScale: number;

  // air
  /** sv_airaccelerate: air acceleration coefficient */
  airAccelerate: number;
  /** cap on the wish speed air acceleration works toward (30 in every id/Valve engine) */
  airSpeedCap: number;
  /**
   * CPM-style air control (Quake 3 CPMA pm_aircontrol): holding only forward or back
   * in the air turns the horizontal velocity toward where you look, without changing
   * speed, so a bhopper steers with the mouse. 0 = off; strafe keys always use plain
   * air acceleration instead.
   */
  airControl: number;
  /** sv_maxvelocity: per-axis velocity clamp (0 = off) */
  maxVelocity: number;

  // jump
  /** sv_gravity (u/s^2) */
  gravity: number;
  /** apex height of a standing jump; the impulse is sqrt(2 * gravity * jumpHeight) */
  jumpHeight: number;
  /** hold jump to hop on every landing instead of re-pressing */
  autoBhop: boolean;
  /** a jump pressed this long before landing still fires on the landing tick (0 = off) */
  jumpBufferTime: number;
  /** bhop cap: on jump, horizontal speed above maxSpeed * this is cropped (0 = uncapped) */
  bhopCapFactor: number;
  /** cropped speed as a fraction of the cap: 1 = clamp to the cap, HL 0.65, CS 1.6 0.8 */
  bhopCapCrop: number;

  // crouch
  /** max speed multiplier while fully ducked (HL PLAYER_DUCKING_MULTIPLIER) */
  duckSpeedScale: number;
  /** seconds a grounded duck takes before the hull shrinks (HL TIME_TO_DUCK) */
  duckTime: number;
  /** how far the feet tuck up on an air duck, as a fraction of the hull height difference: 0.5 GoldSrc, 1 Source/SUCC */
  airDuckLift: number;

  // hull and view
  hullWidth: number;
  standHeight: number;
  duckHeight: number;
  /** eye height above the feet */
  standEyeHeight: number;
  duckEyeHeight: number;
  /** speed the eye catches up after unducking or an air duck (u/s, 0 = snap) */
  eyeSmoothSpeed: number;

  // steps and slopes
  /** tallest ledge you walk up (and down) without jumping */
  stepSize: number;
  /** speed the view catches up after a stair step (u/s, 0 = no smoothing) */
  stepSmoothSpeed: number;
  /** ground is any surface whose normal.y is at least this (0.7 = slopes up to ~45.6 degrees) */
  minGroundNormal: number;
}

export type MovementPresetName = 'valorant' | 'goldsrc' | 'classroom';

/** Half-Life / CS 1.6 feel. Values from SUCC goldsrc.tres (metres * 39.37). */
const GOLDSRC: MovementConfig = {
  maxSpeed: 320, // max_speed 8.128016 m/s
  accelerate: 10, // acceleration 10
  friction: 4, // friction 4
  stopSpeed: 100, // stop_speed 2.540005 m/s
  edgeFriction: 2, // HL sv_edgefriction default (not in SUCC)
  walkSpeedScale: 0.52, // CS cl_movespeedkey (SUCC has sprint, not walk)

  airAccelerate: 10, // air_acceleration 10
  airSpeedCap: 30, // max_air_speed 0.762002 m/s
  airControl: 0, // not a GoldSrc mechanic
  maxVelocity: 2000, // max_velocity 50.800102 m/s, enforce_max_velocity true

  gravity: 800, // gravity 20.320041 m/s^2
  jumpHeight: 45, // jump_height 1.143002 m -> impulse 268.33
  autoBhop: false, // HL needs a fresh press per hop
  jumpBufferTime: 0,
  bhopCapFactor: 0, // uncapped; HL DM would be 1.7 / 0.65, CS 1.6 1.2 / 0.8
  bhopCapCrop: 0.65,

  duckSpeedScale: 0.333, // crouch_speed_modifier 0.333
  duckTime: 0.4, // HL TIME_TO_DUCK (SUCC eases the camera over 34 u at 85 u/s = 0.4 s)
  airDuckLift: 0.5, // HL shrinks the hull about its centre in the air

  hullWidth: 32, // width 0.812802 m
  standHeight: 72, // stand_height 1.828804 m
  duckHeight: 36, // crouch_height 0.914402 m
  standEyeHeight: 64, // standing_view_offset 1.625603 m
  duckEyeHeight: 30, // crouch_view_offset 0.762002 m
  eyeSmoothSpeed: 170, // uncrouch_smoothing_speed 4.318005 m/s

  stepSize: 18, // step_height 0.457201 m
  stepSmoothSpeed: 150, // HL view.cpp stair smoothing rate (SUCC: Source's 150 u/s)
  minGroundNormal: 0.7, // HL/Quake floor test
};

/**
 * Slower and more forgiving: lower top speed, a bit more grip, a short jump buffer,
 * and bhop speed clamped (not punished) at 1.2x max speed on each jump. Jump height,
 * gravity, step size, hulls and air-duck lift match goldsrc so map geometry (ledges a
 * crouch-jump reaches, stairs) behaves the same in both presets.
 */
const CLASSROOM: MovementConfig = {
  ...GOLDSRC,
  maxSpeed: 260,
  friction: 5,
  jumpBufferTime: 0.1,
  bhopCapFactor: 1.2,
  bhopCapCrop: 1,
};

/**
 * Valorant-style feel on the same engine: you are either running or stopped.
 * Friction fights acceleration every ground tick, so with these numbers a standing
 * start reaches run speed in 3 ticks (0.05 s), a released key stops you in 6
 * (0.1 s: proportional friction down to stopSpeed, then a 2000 u/s^2 floor), and the
 * opposite key stops you in 2. No edge friction. Jumping clamps horizontal speed to
 * run speed, so bhop chains hold speed but never gain it, and holding W in the air
 * steers the hop toward the view (airControl: up to ~200 deg/s at run speed). Run
 * speed is Valorant's ~6.75 m/s in Quake units; walk and crouch are about half of
 * it. Jump height, gravity, hulls and step size stay on the goldsrc numbers so the
 * arena's ledges and stairs behave the same.
 *
 * Keep accelerate * (maxSpeed * walkSpeedScale * duckSpeedScale) comfortably above
 * friction * stopSpeed: below that, friction's fixed floor outruns acceleration and a
 * crouch-walking player cannot speed up at all (here 2414 vs 2000).
 */
const VALORANT: MovementConfig = {
  ...GOLDSRC,
  maxSpeed: 266,
  accelerate: 30,
  friction: 20,
  stopSpeed: 100,
  edgeFriction: 1,
  walkSpeedScale: 0.55,

  airControl: 80,

  jumpBufferTime: 0.1,
  bhopCapFactor: 1,
  bhopCapCrop: 1,

  duckSpeedScale: 0.55,
  duckTime: 0.25,
};

/** The first preset is the default the client starts on. */
export const MOVEMENT_PRESETS: Record<MovementPresetName, MovementConfig> = {
  valorant: VALORANT,
  goldsrc: GOLDSRC,
  classroom: CLASSROOM,
};

export interface TunableMeta {
  min: number;
  max: number;
  step: number;
  label?: string;
}

/** Slider ranges for every MovementConfig field. Booleans ignore min/max/step. */
export const MOVEMENT_CONFIG_META: Record<keyof MovementConfig, TunableMeta> = {
  maxSpeed: { min: 50, max: 1000, step: 1, label: 'max speed (u/s)' },
  accelerate: { min: 0, max: 100, step: 0.1, label: 'ground accelerate' },
  friction: { min: 0, max: 40, step: 0.1, label: 'friction' },
  stopSpeed: { min: 0, max: 400, step: 1, label: 'stop speed (u/s)' },
  edgeFriction: { min: 1, max: 10, step: 0.1, label: 'edge friction (x, 1 = off)' },
  walkSpeedScale: { min: 0.1, max: 1, step: 0.01, label: 'walk speed (x max)' },

  airAccelerate: { min: 0, max: 1000, step: 0.1, label: 'air accelerate' },
  airSpeedCap: { min: 0, max: 1000, step: 1, label: 'air wish speed cap (u/s)' },
  airControl: { min: 0, max: 300, step: 1, label: 'air control (W steers, 0 = off)' },
  maxVelocity: { min: 0, max: 10000, step: 10, label: 'max velocity per axis (0 = off)' },

  gravity: { min: 0, max: 3000, step: 1, label: 'gravity (u/s²)' },
  jumpHeight: { min: 0, max: 200, step: 0.5, label: 'jump height (u)' },
  autoBhop: { min: 0, max: 1, step: 1, label: 'auto bhop (hold jump)' },
  jumpBufferTime: { min: 0, max: 0.5, step: 0.01, label: 'jump buffer (s)' },
  bhopCapFactor: { min: 0, max: 5, step: 0.05, label: 'bhop cap (x max speed, 0 = off)' },
  bhopCapCrop: { min: 0.1, max: 1, step: 0.01, label: 'bhop crop (x cap)' },

  duckSpeedScale: { min: 0.1, max: 1, step: 0.001, label: 'duck speed (x max)' },
  duckTime: { min: 0, max: 1, step: 0.01, label: 'duck time (s)' },
  airDuckLift: { min: 0, max: 1, step: 0.05, label: 'air duck leg lift (x hull diff)' },

  hullWidth: { min: 8, max: 64, step: 1, label: 'hull width' },
  standHeight: { min: 36, max: 128, step: 1, label: 'stand height' },
  duckHeight: { min: 16, max: 96, step: 1, label: 'duck height' },
  standEyeHeight: { min: 16, max: 120, step: 1, label: 'stand eye height' },
  duckEyeHeight: { min: 8, max: 90, step: 1, label: 'duck eye height' },
  eyeSmoothSpeed: { min: 0, max: 1000, step: 1, label: 'eye smoothing (u/s, 0 = snap)' },

  stepSize: { min: 0, max: 64, step: 1, label: 'step size' },
  stepSmoothSpeed: { min: 0, max: 1000, step: 1, label: 'stair view smoothing (u/s, 0 = off)' },
  minGroundNormal: { min: 0, max: 1, step: 0.01, label: 'walkable normal y (0.7 ≈ 45.6°)' },
};
