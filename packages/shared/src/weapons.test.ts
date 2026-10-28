import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants.ts';
import { vec3 } from './math.ts';
import { createRng } from './rng.ts';
import type { Projectile } from './projectile.ts';
import type { MoveSample, ShotInfo } from './spray.ts';
import {
  LOADOUT,
  PAINT_FULL,
  WEAPONS,
  applyPaint,
  cloneWeaponDefs,
  createShooterState,
  createWeaponState,
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

  it('spray patterns are one entry per hopper ball and start on aim', () => {
    for (const id of LOADOUT) {
      const d = WEAPONS[id];
      expect(d.pattern).toHaveLength(d.stats.hopperSize);
      expect(d.pattern[0]).toEqual({ pitch: 0, yaw: 0 });
    }
  });
});
