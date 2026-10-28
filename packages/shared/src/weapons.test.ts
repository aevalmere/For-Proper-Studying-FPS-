import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants.ts';
import { DEG2RAD, type Vec3, dot, length, madd, sub, vec3, viewForward } from './math.ts';
import { createRng } from './rng.ts';
import { buildCollisionWorld } from './world/collision.ts';
import { MOVEMENT_PRESETS, type MovementConfig } from './movement/config.ts';
import { createPlayerState, getEyePosition } from './movement/pmove.ts';
import { stepProjectiles, type Projectile, type ProjectileHit } from './projectile.ts';
import { aimDirection, type MoveSample, type ShotInfo } from './spray.ts';
import {
  LOADOUT,
  PAINT_FULL,
  WEAPONS,
  aimConeDeg,
  applyPaint,
  cloneWeaponDefs,
  createShooterState,
  createWeaponState,
  nextShotSpreadDeg,
  refillHopper,
  stepShooter,
  triggerWeapon,
  type ShooterInput,
  type WeaponStats,
} from './weapons.ts';

function stats(over: Partial<WeaponStats> = {}): WeaponStats {
  return { ...WEAPONS.splatter.stats, ...over };
}

/** Run `ticks` ticks with the trigger pattern from `fire(tick)`; returns the ticks that fired. */
function run(s: WeaponStats, ticks: number, fire: (tick: number) => boolean, infiniteAmmo = true, ws = createWeaponState(s)): number[] {
  const fired: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const n = triggerWeapon(ws, s, fire(t), TICK_DT, infiniteAmmo);
    for (let k = 0; k < n; k++) fired.push(t);
  }
  return fired;
}

describe('fire rate', () => {
  it('600 RPM fires exactly 10 shots in 64 ticks, carrying the remainder', () => {
    const fired = run(stats({ rpm: 600 }), 64, () => true);
    expect(fired).toHaveLength(10);
    // 0.1 s = 6.4 ticks, so shots land on ceil(n * 6.4)
    expect(fired).toEqual([0, 7, 13, 20, 26, 32, 39, 45, 52, 58]);
  });

  it('1200 RPM fires 20 shots in 64 ticks and 600 per minute sustained', () => {
    expect(run(stats({ rpm: 1200 }), 64, () => true)).toHaveLength(20);
    expect(run(stats({ rpm: 600 }), 64 * 60, () => true)).toHaveLength(600);
  });

  it('fires immediately on a fresh press after a pause', () => {
    const s = stats({ rpm: 600 });
    const fired = run(s, 40, (t) => t < 1 || t >= 30);
    expect(fired).toEqual([0, 30, 37]);
  });
});

describe('semi-auto', () => {
  const semi = stats({ automatic: false, rpm: 120 });

  it('fires once per press while held', () => {
    expect(run(semi, 200, () => true)).toEqual([0]);
  });

  it('needs a release and re-press for the next shot', () => {
    // press at 0, release at 10, press again at 40 (cooldown 0.5 s = 32 ticks elapsed)
    const fired = run(semi, 100, (t) => t < 10 || (t >= 40 && t < 50) || t >= 80);
    expect(fired).toEqual([0, 40, 80]);
  });

  it('ignores a press during the cooldown', () => {
    const fired = run(semi, 60, (t) => t === 0 || t === 5);
    expect(fired).toEqual([0]);
  });

  it('keeps a click that lands just before the marker is ready, even after release', () => {
    // 0.5 s interval: at tick 28 the marker is 62.5 ms from ready, inside the 120 ms buffer
    expect(semi.triggerBufferMs).toBe(120);
    expect(run(semi, 60, (t) => t === 0 || t === 28)).toEqual([0, 32]);
    // 140 ms early is outside the buffer: dropped
    expect(run(semi, 60, (t) => t === 0 || t === 23)).toEqual([0]);
    expect(run({ ...semi, triggerBufferMs: 0 }, 60, (t) => t === 0 || t === 28)).toEqual([0]);
  });

  it('spends a buffered click on a dry hopper instead of firing it after a refill', () => {
    const s = stats({ automatic: false, rpm: 120, hopperSize: 1 });
    const ws = createWeaponState(s);
    expect(run(s, 40, (t) => t === 0 || t === 28, false, ws)).toEqual([0]);
    expect(ws.queued).toBe(false);
    refillHopper(ws, s);
    expect(run(s, 10, () => false, false, ws)).toEqual([]);
  });
});

describe('ammo', () => {
  it('stops at an empty hopper when ammo is finite, and refills', () => {
    const s = stats({ rpm: 600, hopperSize: 5 });
    const ws = createWeaponState(s);
    expect(run(s, 200, () => true, false, ws)).toHaveLength(5);
    expect(ws.ammo).toBe(0);
    refillHopper(ws, s);
    expect(ws.ammo).toBe(5);
  });

  it('does not bank fire time while dry', () => {
    const s = stats({ rpm: 600, hopperSize: 1 });
    const ws = createWeaponState(s);
    run(s, 100, () => true, false, ws);
    ws.ammo = 10;
    // a long dry hold must not release a burst on the first tick after refilling
    const fired = run(s, 1, () => true, false, ws);
    expect(fired).toHaveLength(1);
  });

  it('infinite ammo leaves the hopper count alone', () => {
    const s = stats({ hopperSize: 3 });
    const ws = createWeaponState(s);
    expect(run(s, 640, () => true, true, ws)).toHaveLength(100);
    expect(ws.ammo).toBe(3);
  });
});

describe('paint meter', () => {
  it('fills to full and reports the splat once', () => {
    const t = { paint: 0, splatted: false };
    expect(applyPaint(t, 60)).toBe(false);
    expect(applyPaint(t, 60)).toBe(true);
    expect(t.paint).toBe(PAINT_FULL);
    expect(applyPaint(t, 60)).toBe(false);
  });
});

describe('stepShooter', () => {
  const move: MoveSample = { vel: vec3(), onGround: true, ducked: false, maxSpeed: 320 };
  const input = (fire: boolean, weapon: number): ShooterInput => ({ fire, weapon, yaw: 0, pitch: 0, eye: vec3(0, 64, 0), move });

  it('spawns one ball per pellet from the eye', () => {
    const defs = cloneWeaponDefs();
    const s = createShooterState(defs);
    const balls: Projectile[] = [];
    const shots: ShotInfo[] = [];
    const slot = LOADOUT.indexOf('spritzer');
    stepShooter(s, defs, input(false, slot), createRng(1), TICK_DT, { infiniteAmmo: true, owner: 0 }, balls, shots);
    stepShooter(s, defs, input(true, slot), createRng(1), TICK_DT, { infiniteAmmo: true, owner: 0 }, balls, shots);
    expect(shots).toHaveLength(1);
    expect(balls).toHaveLength(defs.spritzer.stats.pellets);
    for (const b of balls) {
      expect(b.weapon).toBe('spritzer');
      expect(b.pos).toEqual(vec3(0, 64, 0));
    }
    expect(new Set(balls.map((b) => b.id)).size).toBe(balls.length);
  });

  it('does not fire a semi-auto marker when the trigger is held through a switch', () => {
    const defs = cloneWeaponDefs();
    const s = createShooterState(defs);
    const balls: Projectile[] = [];
    const rng = createRng(1);
    const opts = { infiniteAmmo: true, owner: 0 };
    stepShooter(s, defs, input(true, 0), rng, TICK_DT, opts, balls);
    expect(balls).toHaveLength(1);
    stepShooter(s, defs, input(true, LOADOUT.indexOf('lobber')), rng, TICK_DT, opts, balls);
    stepShooter(s, defs, input(true, LOADOUT.indexOf('lobber')), rng, TICK_DT, opts, balls);
    expect(balls).toHaveLength(1);
  });

  it('drops a click queued on a marker that is put away', () => {
    const defs = cloneWeaponDefs();
    const s = createShooterState(defs);
    const lobber = LOADOUT.indexOf('lobber');
    const balls: Projectile[] = [];
    const rng = createRng(1);
    const opts = { infiniteAmmo: true, owner: 0 };
    const interval = Math.ceil(60 / defs.lobber.stats.rpm / TICK_DT);
    for (let t = 0; t < interval * 3; t++) {
      // fire, click again 3 ticks before ready, switch away that tick, come back later
      const weapon = t > interval - 3 && t < interval * 2 ? 0 : lobber;
      stepShooter(s, defs, input(t === 0 || t === interval - 3, weapon), rng, TICK_DT, opts, balls);
    }
    expect(balls).toHaveLength(1);
  });

  it('recycles spent balls from the pool', () => {
    const defs = cloneWeaponDefs();
    const s = createShooterState(defs);
    const spent: Projectile[] = [];
    stepShooter(s, defs, input(true, 0), createRng(1), TICK_DT, { infiniteAmmo: true, owner: 0 }, spent);
    const pool = [spent[0]!];
    const balls: Projectile[] = [];
    for (let t = 0; t < 10; t++) stepShooter(s, defs, input(true, 0), createRng(1), TICK_DT, { infiniteAmmo: true, owner: 0 }, balls, undefined, pool);
    expect(balls[0]).toBe(spent[0]);
    expect(pool).toHaveLength(0);
    expect(balls[0]!.id).toBe(2);
  });

  it('spray patterns are one entry per hopper ball and start on aim', () => {
    for (const id of LOADOUT) {
      const d = WEAPONS[id];
      expect(d.pattern).toHaveLength(d.stats.hopperSize);
      expect(d.pattern[0]).toEqual({ pitch: 0, yaw: 0 });
    }
  });
});

describe('aim', () => {
  const cfg = Object.values(MOVEMENT_PRESETS)[0] as MovementConfig;
  const still: MoveSample = { vel: vec3(), onGround: true, ducked: false, maxSpeed: cfg.maxSpeed };
  const box = (min: Vec3, max: Vec3) => ({ shape: { kind: 'box' as const, min, max }, color: 0 });

  /** Fire one Splatter ball from a player standing at `feet` and fly it until it lands. */
  function shoot(world: ReturnType<typeof buildCollisionWorld>, feet: Vec3, yaw: number, pitch: number) {
    const eye = getEyePosition(createPlayerState(feet), cfg);
    const defs = cloneWeaponDefs();
    const s = createShooterState(defs);
    const balls: Projectile[] = [];
    const hits: ProjectileHit[] = [];
    const shooterInput: ShooterInput = { fire: true, weapon: 0, yaw, pitch, eye, move: still };
    stepShooter(s, defs, shooterInput, createRng(1), TICK_DT, { infiniteAmmo: true, owner: 1 }, balls);
    for (let t = 0; t < 64 && balls.length > 0; t++) {
      if (stepProjectiles(balls, world, [], TICK_DT, hits) > 0) break;
    }
    const hit = hits[0]!;
    // Distance from the hit point to the crosshair ray (eye along the view direction)
    // after taking out the ball's gravity drop over that distance. Ticks trace chords
    // of the arc, so allow the chord's sag (g·dt²/8 ≈ 0.01 u at 64 Hz).
    const f = viewForward(vec3(), yaw, pitch);
    const rel = sub(vec3(), hit.point, eye);
    const along = dot(rel, f);
    const flight = along / defs.splatter.stats.ballSpeed;
    rel.y += 0.5 * defs.splatter.stats.ballGravity * flight * flight;
    const offRay = length(madd(vec3(), rel, f, -dot(rel, f)));
    return { hit, offRay, along };
  }

  it('a point-blank shot at a wall lands on the crosshair ray', () => {
    // the hull's front face is 16 u ahead of the feet; the wall is 4 u past it
    const world = buildCollisionWorld({ brushes: [box(vec3(-200, 0, -60), vec3(200, 200, -20))] });
    for (const [yaw, pitch] of [[0, 0], [0.4, -0.3], [-0.6, 0.5], [0.9, 0.2]] as const) {
      const { hit, offRay, along } = shoot(world, vec3(0, 0, 0), yaw, pitch);
      expect(hit.kind).toBe('world');
      // traces stop a clip epsilon short of the surface
      expect(hit.point.z).toBeCloseTo(-20, 1);
      expect(along).toBeGreaterThan(19);
      expect(offRay).toBeLessThan(0.02);
    }
  });

  it('a shot while hugging a wall flies past it, or hits it exactly on the ray', () => {
    // side wall face 0.03 u right of the hull; far wall 200 u ahead
    const world = buildCollisionWorld({
      brushes: [box(vec3(16.03, 0, -400), vec3(40, 200, 400)), box(vec3(-200, 0, -260), vec3(16.03, 200, -200))],
    });
    const along = shoot(world, vec3(0, 0, 0), 0, 0);
    expect(along.hit.brush).toBe(1);
    expect(along.offRay).toBeLessThan(0.02);
    // turned slightly into the side wall: a grazing hit, still on the ray
    const into = shoot(world, vec3(0, 0, 0), -0.2, 0);
    expect(into.hit.brush).toBe(0);
    expect(into.hit.point.x).toBeCloseTo(16.03, 1);
    expect(into.offRay).toBeLessThan(0.02);
  });
});

describe('aim cone prediction', () => {
  const MAX = 320;
  const moves: MoveSample[] = [
    { vel: vec3(), onGround: true, ducked: false, maxSpeed: MAX },
    { vel: vec3(250, 0, 40), onGround: true, ducked: false, maxSpeed: MAX },
    { vel: vec3(100, 50, 0), onGround: false, ducked: false, maxSpeed: MAX },
    { vel: vec3(60, 0, 0), onGround: true, ducked: true, maxSpeed: MAX },
  ];

  it('nextShotSpreadDeg is the spread the next shot actually gets', () => {
    for (const slot of [0, 1, 2]) {
      const defs = cloneWeaponDefs();
      const s = createShooterState(defs);
      // start on this marker: a press held through a switch doesn't fire
      s.active = slot;
      const stats = defs[LOADOUT[slot]!].stats;
      const rng = createRng(11);
      const balls: Projectile[] = [];
      const shots: ShotInfo[] = [];
      let compared = 0;
      // bursts, short gaps (under the spray reset), long gaps (over it), and taps
      const fire = (t: number) => t < 40 || (t >= 55 && t < 70) || t === 120 || t === 150 || (t >= 200 && t < 260);
      for (let t = 0; t < 300; t++) {
        const move = moves[Math.floor(t / 7) % moves.length]!;
        const ws = s.weapons[slot]!;
        const predicted = nextShotSpreadDeg(ws, stats, move, TICK_DT);
        const cone = aimConeDeg(ws, stats, move, TICK_DT);
        shots.length = 0;
        stepShooter(s, defs, { fire: fire(t), weapon: slot, yaw: 0.3, pitch: -0.1, eye: vec3(), move }, rng, TICK_DT, { infiniteAmmo: true, owner: 0 }, balls, shots);
        for (const shot of shots) {
          expect(shot.spreadDeg).toBe(predicted);
          compared++;
          // every ball of the shot is inside the cone around the shot's aim
          const center = aimDirection(vec3(), 0.3 + shot.patternYaw, -0.1 + shot.patternPitch);
          for (const b of balls.slice(-shot.pellets)) {
            const dir = vec3(b.vel.x, b.vel.y, b.vel.z);
            const a = Math.acos(Math.min(1, dot(dir, center) / length(dir)));
            // acos loses precision next to 1: allow a microradian
            expect(a).toBeLessThanOrEqual(cone * DEG2RAD + 1e-6);
          }
        }
      }
      // semi-autos fire once per press: 4 presses
      expect(compared).toBeGreaterThanOrEqual(4);
    }
  });

  it('includes the pellet cone for bursts only', () => {
    const ws = createWeaponState(WEAPONS.spritzer.stats);
    const move = moves[0]!;
    expect(nextShotSpreadDeg(ws, WEAPONS.spritzer.stats, move, TICK_DT)).toBe(0);
    expect(aimConeDeg(ws, WEAPONS.spritzer.stats, move, TICK_DT)).toBe(WEAPONS.spritzer.stats.pelletSpreadDeg);
    expect(aimConeDeg(createWeaponState(WEAPONS.splatter.stats), WEAPONS.splatter.stats, move, TICK_DT)).toBe(0);
  });
});
