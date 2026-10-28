import { describe, expect, it } from 'vitest';
import { type Vec3, vec3, lengthXZ } from '../math.ts';
import { Buttons, emptyCmd, type UserCmd } from '../input.ts';
import { TICK_DT } from '../constants.ts';
import { buildCollisionWorld } from '../world/collision.ts';
import type { BrushShape, CollisionWorld, RampDir } from '../world/types.ts';
import { MOVEMENT_CONFIG_META, MOVEMENT_PRESETS, type MovementConfig } from './config.ts';
import {
  type MovementModifiers,
  type PlayerState,
  DEFAULT_MODIFIERS,
  clonePlayerState,
  createPlayerState,
  getEyePosition,
  getHull,
  stepPlayer,
} from './pmove.ts';

const GOLDSRC = MOVEMENT_PRESETS.goldsrc;
const CLASSROOM = MOVEMENT_PRESETS.classroom;
const EPS = 0.03125;
const { JUMP, CROUCH, WALK } = Buttons;

const box = (min: Vec3, max: Vec3): BrushShape => ({ kind: 'box', min, max });
const ramp = (min: Vec3, max: Vec3, up: RampDir): BrushShape => ({ kind: 'ramp', min, max, up });
const FLOOR = box(vec3(-4096, -16, -4096), vec3(4096, 0, 4096));

function world(...shapes: BrushShape[]): CollisionWorld {
  return buildCollisionWorld({ brushes: shapes.map((shape) => ({ shape, color: 0 })) });
}

function cmd(over: Partial<UserCmd> = {}): UserCmd {
  return { ...emptyCmd(), ...over };
}

/** A player standing on the y=0 floor. */
function standing(x = 0, z = 0, vel = vec3()): PlayerState {
  const s = createPlayerState(vec3(x, EPS, z));
  s.vel = vel;
  s.onGround = true;
  return s;
}

type CmdSource = UserCmd | ((tick: number, s: PlayerState) => UserCmd);

function run(
  s: PlayerState,
  w: CollisionWorld,
  cfg: MovementConfig,
  ticks: number,
  source: CmdSource,
  each?: (s: PlayerState, tick: number) => void,
  mods: MovementModifiers = DEFAULT_MODIFIERS,
): PlayerState {
  for (let i = 0; i < ticks; i++) {
    const c = typeof source === 'function' ? source(i, s) : source;
    stepPlayer(s, c, cfg, w, TICK_DT, mods);
    each?.(s, i);
  }
  return s;
}

/** Yaw that looks along a horizontal velocity (yaw 0 looks down -Z, +yaw turns left). */
function velocityYaw(v: Vec3): number {
  return Math.atan2(-v.x, -v.z);
}

describe('movement config', () => {
  it('has a slider range for every field of every preset', () => {
    for (const preset of Object.values(MOVEMENT_PRESETS)) {
      expect(Object.keys(preset).sort()).toEqual(Object.keys(MOVEMENT_CONFIG_META).sort());
      for (const [key, value] of Object.entries(preset)) {
        const meta = MOVEMENT_CONFIG_META[key as keyof MovementConfig];
        expect(['number', 'boolean']).toContain(typeof value);
        if (typeof value === 'number') {
          expect(value, key).toBeGreaterThanOrEqual(meta.min);
          expect(value, key).toBeLessThanOrEqual(meta.max);
        }
      }
    }
  });

  it('goldsrc converts SUCC goldsrc.tres to Quake units', () => {
    expect(GOLDSRC.maxSpeed).toBe(320);
    expect(GOLDSRC.gravity).toBe(800);
    expect(Math.sqrt(2 * GOLDSRC.gravity * GOLDSRC.jumpHeight)).toBeCloseTo(268.33, 2);
    expect(GOLDSRC.airSpeedCap).toBe(30);
    expect(GOLDSRC.stepSize).toBe(18);
  });
});

describe('ground movement', () => {
  const w = world(FLOOR);

  it('accelerates to max speed and never beyond', () => {
    let peak = 0;
    const s = run(standing(), w, GOLDSRC, 128, cmd({ forward: 1 }), (p) => {
      peak = Math.max(peak, lengthXZ(p.vel));
    });
    expect(lengthXZ(s.vel)).toBeCloseTo(320, 6);
    expect(peak).toBeLessThanOrEqual(320 + 1e-9);
    expect(s.onGround).toBe(true);
  });

  it('does not go faster diagonally', () => {
    const s = run(standing(), w, GOLDSRC, 128, cmd({ forward: 1, side: 1 }));
    expect(lengthXZ(s.vel)).toBeCloseTo(320, 6);
  });

  it('walks at walkSpeedScale and applies speedScale', () => {
    const walk = run(standing(), w, GOLDSRC, 128, cmd({ forward: 1, buttons: WALK }));
    expect(lengthXZ(walk.vel)).toBeCloseTo(320 * 0.52, 6);
    const slow = run(standing(), w, GOLDSRC, 128, cmd({ forward: 1 }), undefined, { speedScale: 0.5 });
    expect(lengthXZ(slow.vel)).toBeCloseTo(160, 6);
  });

  it('friction brings a runner to a full stop', () => {
    let stopTick = -1;
    run(standing(0, 0, vec3(0, 0, -320)), w, GOLDSRC, 64, cmd(), (p, i) => {
      if (stopTick < 0 && lengthXZ(p.vel) === 0) stopTick = i;
    });
    // HL numbers: ~0.29 s of proportional friction down to stopspeed, then ~0.25 s linear
    expect(stopTick).toBeGreaterThan(30);
    expect(stopTick).toBeLessThan(40);
  });

  it('counter-strafing stops much faster than releasing the key', () => {
    const ticksToStop = (side: number): number => {
      const s = standing(0, 0, vec3(320, 0, 0)); // moving right at yaw 0
      for (let i = 1; i <= 128; i++) {
        stepPlayer(s, cmd({ side }), GOLDSRC, w, TICK_DT);
        if (s.vel.x < 10) return i;
      }
      return Infinity;
    };
    const release = ticksToStop(0);
    const counter = ticksToStop(-1);
    expect(counter).toBeLessThanOrEqual(6);
    expect(release).toBeGreaterThanOrEqual(25);
    expect(counter * 4).toBeLessThan(release);
  });
});

describe('air movement and jumping', () => {
  it('air strafing with a matching yaw turn gains horizontal speed', () => {
    const empty = world();
    const strafe = (turn: boolean): number => {
      const s = createPlayerState(vec3(0, 0, 0));
      s.vel = vec3(0, 0, -300);
      run(s, empty, GOLDSRC, 64, (_, p) => cmd({ side: 1, yaw: turn ? velocityYaw(p.vel) : 0 }));
      return lengthXZ(s.vel);
    };
    // sqrt(300^2 + 64 * 30^2) = 384: the full 30 u/s allowance every tick
    expect(strafe(true)).toBeGreaterThan(380);
    // holding the key without turning tops out at the 30 u/s cap along it
    expect(strafe(false)).toBeLessThan(305);
  });

  it('jumps ~45 units, once per press', () => {
    const w = world(FLOOR);
    let peak = 0;
    let jumps = 0;
    run(standing(), w, GOLDSRC, 128, cmd({ buttons: JUMP }), (p) => {
      peak = Math.max(peak, p.pos.y);
      if (p.jumped) jumps++;
    });
    expect(peak).toBeGreaterThan(44.5);
    expect(peak).toBeLessThan(45.1);
    expect(jumps).toBe(1);
  });

  it('autoBhop hops on every landing while jump is held', () => {
    const w = world(FLOOR);
    let jumps = 0;
    run(standing(), w, { ...GOLDSRC, autoBhop: true }, 192, cmd({ buttons: JUMP }), (p) => {
      if (p.jumped) jumps++;
    });
    expect(jumps).toBeGreaterThanOrEqual(4);
  });

  const hop = (cfg: MovementConfig, lateTicks = 0): { speed: number; jumps: number } => {
    const w = world(FLOOR);
    let groundTicks = 0;
    let jumps = 0;
    const s = run(
      standing(0, 0, vec3(0, 0, -500)),
      w,
      cfg,
      192,
      (_, p) => {
        groundTicks = p.onGround ? groundTicks + 1 : 0;
        return cmd({ buttons: groundTicks === 1 + lateTicks ? JUMP : 0 });
      },
      (p) => {
        if (p.jumped) jumps++;
      },
    );
    return { speed: lengthXZ(s.vel), jumps };
  };

  it('bhop with a jump on each landing tick holds speed on goldsrc', () => {
    const { speed, jumps } = hop(GOLDSRC);
    expect(jumps).toBeGreaterThanOrEqual(4);
    expect(speed).toBeCloseTo(500, 6);
  });

  it('jumping a tick late pays one tick of friction per hop', () => {
    const { speed, jumps } = hop(GOLDSRC, 1);
    expect(jumps).toBeGreaterThanOrEqual(4);
    expect(speed).toBeLessThan(450);
  });

  it('bhop speed is capped on classroom', () => {
    const { speed, jumps } = hop(CLASSROOM);
    expect(jumps).toBeGreaterThanOrEqual(4);
    expect(speed).toBeCloseTo(CLASSROOM.bhopCapFactor * CLASSROOM.maxSpeed, 6);
  });

  it('a buffered press just before landing still jumps (classroom)', () => {
    const w = world(FLOOR);
    const s = createPlayerState(vec3(0, 20, 0));
    // falling from 20 units lands after ~14 ticks; press (and release) at tick 10
    let jumped = false;
    run(s, w, CLASSROOM, 40, (i) => cmd({ buttons: i === 10 ? JUMP : 0 }), (p) => {
      if (p.jumped) jumped = true;
    });
    expect(jumped).toBe(true);
    let strict = false;
    run(createPlayerState(vec3(0, 20, 0)), w, GOLDSRC, 40, (i) => cmd({ buttons: i === 10 ? JUMP : 0 }), (p) => {
      if (p.jumped) strict = true;
    });
    expect(strict).toBe(false);
  });
});

describe('steps and slopes', () => {
  const runInto = (stepHeight: number): PlayerState => {
    const w = world(FLOOR, box(vec3(-128, 0, -1000), vec3(128, stepHeight, -100)));
    return run(standing(0, 0, vec3(0, 0, -320)), w, GOLDSRC, 64, cmd({ forward: 1 }));
  };

  it('steps up onto a 16-unit step without losing speed', () => {
    const s = runInto(16);
    expect(s.pos.y).toBeCloseTo(16 + EPS, 2);
    expect(s.pos.z).toBeLessThan(-300);
    expect(lengthXZ(s.vel)).toBeCloseTo(320, 6);
    expect(s.onGround).toBe(true);
  });

  it('is stopped by a 24-unit wall', () => {
    const s = runInto(24);
    expect(s.pos.y).toBeLessThan(1);
    expect(s.pos.z).toBeGreaterThan(-100 + 16 - 0.1);
  });

  it('stays grounded walking up and down stairs', () => {
    const steps: BrushShape[] = [];
    for (let k = 0; k < 6; k++) {
      const far = k === 5 ? -2000 : -100 - 32 * (k + 1);
      steps.push(box(vec3(-128, 0, far), vec3(128, 16 * (k + 1), -100 - 32 * k)));
    }
    const w = world(FLOOR, ...steps);
    let airborne = 0;
    const s = run(standing(0, 0, vec3(0, 0, -320)), w, GOLDSRC, 96, cmd({ forward: 1 }), (p) => {
      if (!p.onGround) airborne++;
    });
    expect(s.pos.y).toBeCloseTo(96 + EPS, 2);
    expect(airborne).toBe(0);
    run(s, w, GOLDSRC, 128, cmd({ forward: 1, yaw: Math.PI }), (p) => {
      if (!p.onGround) airborne++;
    });
    expect(s.pos.y).toBeCloseTo(EPS, 2);
    expect(s.pos.z).toBeGreaterThan(-100);
    expect(airborne).toBe(0);
  });

  it('walks up and down a 30 degree ramp staying grounded at full speed', () => {
    const len = 300;
    const h = len * Math.tan(Math.PI / 6);
    const w = world(FLOOR, ramp(vec3(-128, 0, -100 - len), vec3(128, h, -100), '-z'));
    let airborne = 0;
    const s = run(standing(0, 0, vec3(0, 0, -320)), w, GOLDSRC, 64, cmd({ forward: 1 }), (p) => {
      if (!p.onGround) airborne++;
    });
    expect(airborne).toBe(0);
    expect(s.pos.y).toBeGreaterThan(100);
    expect(lengthXZ(s.vel)).toBeCloseTo(320, 6);
    run(s, w, GOLDSRC, 96, cmd({ forward: 1, yaw: Math.PI }), (p) => {
      if (!p.onGround) airborne++;
    });
    expect(airborne).toBe(0);
    expect(s.pos.y).toBeCloseTo(EPS, 2);
  });

  it('slides off a ramp too steep to stand on', () => {
    // 60 degrees: normal.y = 0.5 < 0.7
    const w = world(FLOOR, ramp(vec3(-128, 0, -200), vec3(128, 100 * Math.tan(Math.PI / 3), -100), '-z'));
    const s = createPlayerState(vec3(0, 120, -150));
    let groundedOnSlope = 0;
    run(s, w, GOLDSRC, 128, cmd(), (p) => {
      if (p.onGround && p.pos.y > 1) groundedOnSlope++;
    });
    expect(groundedOnSlope).toBe(0);
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(EPS, 2);
    expect(s.pos.z).toBeGreaterThan(-100);
  });
});

describe('crouch', () => {
  it('ducks after duckTime into a 36-unit hull and moves at duck speed', () => {
    const w = world(FLOOR);
    let duckedAt = -1;
    const s = run(standing(), w, GOLDSRC, 128, cmd({ forward: 1, buttons: CROUCH }), (p, i) => {
      if (duckedAt < 0 && p.ducked) duckedAt = i;
    });
    expect(duckedAt).toBeGreaterThanOrEqual(24);
    expect(duckedAt).toBeLessThanOrEqual(26);
    expect(getHull(s, GOLDSRC).maxs.y).toBe(36);
    expect(lengthXZ(s.vel)).toBeCloseTo(320 * 0.333, 6);
    expect(getEyePosition(s, GOLDSRC).y - s.pos.y).toBeCloseTo(30, 6);
  });

  it('crouch-jump clears a ledge a standing jump cannot', () => {
    const w = world(FLOOR, box(vec3(-128, 0, -300), vec3(128, 54, -100)));
    const attempt = (crouch: boolean): PlayerState =>
      run(standing(0, -100 + 16 + 0.5), w, GOLDSRC, 96, (i) =>
        cmd({ forward: 1, buttons: (i === 0 ? JUMP : 0) | (crouch && i > 0 ? CROUCH : 0) }),
      );
    const stand = attempt(false);
    expect(stand.pos.y).toBeLessThan(1);
    const crouch = attempt(true);
    expect(crouch.pos.y).toBeCloseTo(54 + EPS, 2);
    expect(crouch.pos.z).toBeLessThan(-100);
    expect(crouch.ducked).toBe(true);
  });

  it("can't stand up under a low ceiling, stands once clear", () => {
    const w = world(FLOOR, box(vec3(-128, 50, -128), vec3(128, 64, 128)));
    const s = standing();
    s.ducked = true;
    run(s, w, GOLDSRC, 32, cmd());
    expect(s.ducked).toBe(true);
    expect(getHull(s, GOLDSRC).maxs.y).toBe(36);
    run(s, w, GOLDSRC, 192, cmd({ forward: 1 }));
    expect(s.pos.z).toBeLessThan(-128 - 16);
    expect(s.ducked).toBe(false);
  });

  it('keeps the eye steady through an air duck', () => {
    const w = world();
    const a = createPlayerState(vec3(0, 500, 0));
    const b = clonePlayerState(a);
    stepPlayer(a, cmd(), GOLDSRC, w, TICK_DT);
    stepPlayer(b, cmd({ buttons: CROUCH }), GOLDSRC, w, TICK_DT);
    expect(b.ducked).toBe(true);
    expect(b.pos.y - a.pos.y).toBeCloseTo(18, 6); // GoldSrc: feet tuck up half of 72 - 36
    const drift = getEyePosition(b, GOLDSRC).y - getEyePosition(a, GOLDSRC).y;
    expect(Math.abs(drift)).toBeLessThanOrEqual(GOLDSRC.eyeSmoothSpeed * TICK_DT + 1e-9);
  });
});

describe('collision', () => {
  it('does not tunnel through a thin wall at very high speed', () => {
    const w = world(FLOOR, box(vec3(-512, 0, -102), vec3(512, 400, -100)));
    const cfg = { ...GOLDSRC, maxVelocity: 0 };
    const ground = run(standing(0, 0, vec3(0, 0, -20000)), w, cfg, 8, cmd({ forward: 1 }));
    expect(ground.pos.z).toBeGreaterThan(-100 + 16 - 0.1);
    const air = createPlayerState(vec3(0, 100, 0));
    air.vel = vec3(3000, 0, -50000);
    run(air, w, cfg, 8, cmd());
    expect(air.pos.z).toBeGreaterThan(-100 + 16 - 0.1);
  });

  it('pops a player spawned inside the floor back on top', () => {
    const w = world(FLOOR);
    const s = createPlayerState(vec3(0, -4, 0));
    run(s, w, GOLDSRC, 4, cmd());
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(EPS, 2);
  });
});

describe('determinism', () => {
  it('replays the same commands to bit-identical state', () => {
    const steps: BrushShape[] = [];
    for (let k = 0; k < 4; k++) steps.push(box(vec3(200, 0, -100 - 32 * (k + 1)), vec3(400, 16 * (k + 1), -100 - 32 * k)));
    const w = world(
      FLOOR,
      ...steps,
      ramp(vec3(-400, 0, -400), vec3(-200, 120, -100), '-z'),
      box(vec3(-100, 0, -600), vec3(100, 54, -500)),
      box(vec3(-1000, 0, 300), vec3(1000, 200, 320)),
    );
    const cmds: UserCmd[] = [];
    let seed = 12345;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let yaw = 0;
    for (let i = 0; i < 1500; i++) {
      yaw += (rand() - 0.5) * 0.2;
      const r = rand();
      cmds.push(
        cmd({
          seq: i,
          forward: Math.floor(rand() * 3) - 1,
          side: Math.floor(rand() * 3) - 1,
          yaw,
          buttons: (r < 0.2 ? JUMP : 0) | (r > 0.85 ? CROUCH : 0) | (r > 0.5 && r < 0.55 ? WALK : 0),
        }),
      );
    }
    const replay = (cfg: MovementConfig): PlayerState[] => {
      const s = standing();
      const snaps: PlayerState[] = [];
      cmds.forEach((c, i) => {
        stepPlayer(s, c, cfg, w, TICK_DT);
        if (i % 50 === 0) snaps.push(clonePlayerState(s));
      });
      snaps.push(s);
      return snaps;
    };
    for (const cfg of [GOLDSRC, CLASSROOM]) {
      const a = replay(cfg);
      const b = replay(cfg);
      expect(a).toStrictEqual(b);
      for (const snap of a) {
        expect(Number.isFinite(snap.pos.x + snap.pos.y + snap.pos.z)).toBe(true);
      }
    }
  });
});
