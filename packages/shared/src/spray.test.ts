import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants.ts';
import { DEG2RAD, type Vec3, dot, vec3, viewForward } from './math.ts';
import { createRng, type Rng } from './rng.ts';
import { aimDirection, computeSpreadDeg, fireShot, patternOffset, type MoveSample } from './spray.ts';
import { cloneWeaponDefs, createWeaponState, triggerWeapon, type WeaponDef } from './weapons.ts';

const MAX = 320;
const standing = (): MoveSample => ({ vel: vec3(), onGround: true, ducked: false, maxSpeed: MAX });
const moving = (speed: number, over: Partial<MoveSample> = {}): MoveSample => ({
  vel: vec3(speed, 0, 0),
  onGround: true,
  ducked: false,
  maxSpeed: MAX,
  ...over,
});

const aim = { yaw: 0.3, pitch: -0.2 };

/** Hold/release the trigger per `fire(tick)` and return the spray index each shot used. */
function sprayIndices(def: WeaponDef, ticks: number, fire: (t: number) => boolean): number[] {
  const ws = createWeaponState(def.stats);
  const rng = createRng(7);
  const dirs: Vec3[] = [];
  const used: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const n = triggerWeapon(ws, def.stats, fire(t), TICK_DT, true);
    for (let k = 0; k < n; k++) used.push(fireShot(ws, def, aim, standing(), rng, dirs).sprayIndex);
  }
  return used;
}

function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
}

describe('spray pattern', () => {
  it('advances one index per shot', () => {
    const def = cloneWeaponDefs().splatter;
    expect(sprayIndices(def, 64, () => true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps the index across a gap shorter than sprayResetMs and resets after a longer one', () => {
    const def = cloneWeaponDefs().splatter;
    // 600 RPM: shots on ticks 0, 7, 13, 20, 26. 450 ms = 28.8 ticks, so the
    // reset lands 29 ticks after the tick-26 shot.
    const burst = (t: number) => t < 27;
    expect(sprayIndices(def, 56, (t) => burst(t) || t === 54)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sprayIndices(def, 56, (t) => burst(t) || t === 55)).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it('follows sprayResetMs when tuned', () => {
    const def = cloneWeaponDefs().splatter;
    def.stats.sprayResetMs = 150; // 9.6 ticks
    // the auto interval (6.4 ticks) is under the reset, so a held burst still climbs
    expect(sprayIndices(def, 30, () => true)).toEqual([0, 1, 2, 3, 4]);
    // shot at 0, then a press at 10 (> 9.6 ticks later) starts over
    expect(sprayIndices(def, 12, (t) => t === 0 || t === 10)).toEqual([0, 0]);
  });

  it('stops advancing at the last pattern entry', () => {
    const def = cloneWeaponDefs().splatter;
    const used = sprayIndices(def, 64 * 5, () => true);
    expect(used.at(-1)).toBe(def.pattern.length - 1);
  });

  it('applies the pattern offset on top of the view angles', () => {
    const def = cloneWeaponDefs().splatter;
    def.stats.standSpreadDeg = 0;
    const ws = createWeaponState(def.stats);
    ws.sprayIndex = 12;
    const dirs: Vec3[] = [];
    fireShot(ws, def, aim, standing(), createRng(1), dirs);
    const p = def.pattern[12]!;
    const expected = viewForward(vec3(), aim.yaw + p.yaw * DEG2RAD, aim.pitch + p.pitch * DEG2RAD);
    expect(dirs[0]!.x).toBeCloseTo(expected.x, 12);
    expect(dirs[0]!.y).toBeCloseTo(expected.y, 12);
    expect(dirs[0]!.z).toBeCloseTo(expected.z, 12);
    expect(ws.sprayIndex).toBe(13);
  });

  it('scales the pattern with patternScale', () => {
    const def = cloneWeaponDefs().splatter;
    const a = patternOffset(def, 9);
    def.stats.patternScale = 2;
    const b = patternOffset(def, 9);
    expect(b.pitch).toBeCloseTo(a.pitch * 2, 12);
    expect(b.yaw).toBeCloseTo(a.yaw * 2, 12);
  });
});

describe('spread', () => {
  const stats = cloneWeaponDefs().splatter.stats;

  it('first shot standing still is exactly on aim', () => {
    for (const def of Object.values(cloneWeaponDefs())) {
      if (def.stats.pellets > 1) continue;
      const ws = createWeaponState(def.stats);
      const dirs: Vec3[] = [];
      const info = fireShot(ws, def, aim, standing(), createRng(99), dirs);
      expect(info.spreadDeg).toBe(0);
      expect(dirs[0]).toEqual(viewForward(vec3(), aim.yaw, aim.pitch));
    }
  });

  it('counter-strafed (below the threshold) is as accurate as standing', () => {
    const slow = MAX * stats.moveSpreadThreshold * 0.9;
    expect(computeSpreadDeg(stats, 0, moving(slow))).toBe(0);
    expect(computeSpreadDeg(stats, 3, moving(slow))).toBe(stats.standSpreadDeg);
  });

  it('grows with horizontal speed', () => {
    const walk = computeSpreadDeg(stats, 0, moving(MAX * 0.5));
    const run = computeSpreadDeg(stats, 0, moving(MAX));
    const bhop = computeSpreadDeg(stats, 0, moving(MAX * 1.4));
    expect(walk).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(walk);
    expect(run).toBeCloseTo(stats.moveSpreadDeg, 9);
    expect(bhop).toBeGreaterThan(run);
    // vertical speed alone doesn't count
    expect(computeSpreadDeg(stats, 0, { ...standing(), vel: vec3(0, -300, 0) })).toBe(0);
  });

  it('grows when airborne and shrinks when crouched', () => {
    const ground = computeSpreadDeg(stats, 0, moving(MAX));
    const air = computeSpreadDeg(stats, 0, moving(MAX, { onGround: false }));
    const crouch = computeSpreadDeg(stats, 0, moving(MAX, { ducked: true }));
    expect(air).toBeCloseTo(ground + stats.airSpreadDeg, 9);
    expect(computeSpreadDeg(stats, 0, { ...standing(), onGround: false })).toBe(stats.airSpreadDeg);
    expect(crouch).toBeCloseTo(ground * stats.crouchSpreadScale, 9);
  });

  it('keeps every shot inside the spread cone, and moving shots miss the crosshair', () => {
    const def = cloneWeaponDefs().splatter;
    const forward = viewForward(vec3(), aim.yaw, aim.pitch);
    const rng = createRng(5);
    const dirs: Vec3[] = [];
    let maxAngle = 0;
    for (let i = 0; i < 200; i++) {
      const ws = createWeaponState(def.stats);
      const info = fireShot(ws, def, aim, moving(MAX), rng, dirs);
      const a = angleBetween(dirs[0]!, forward);
      expect(a).toBeLessThanOrEqual(info.spreadDeg * DEG2RAD + 1e-9);
      maxAngle = Math.max(maxAngle, a);
    }
    expect(maxAngle).toBeGreaterThan(stats.moveSpreadDeg * DEG2RAD * 0.5);
  });

  it('keeps Spritzer pellets inside their cone', () => {
    const def = cloneWeaponDefs().spritzer;
    const ws = createWeaponState(def.stats);
    const dirs: Vec3[] = [];
    const info = fireShot(ws, def, aim, standing(), createRng(3), dirs);
    expect(info.pellets).toBe(def.stats.pellets);
    const forward = viewForward(vec3(), aim.yaw, aim.pitch);
    const angles = dirs.slice(0, info.pellets).map((d) => angleBetween(d, forward));
    for (const a of angles) expect(a).toBeLessThanOrEqual(def.stats.pelletSpreadDeg * DEG2RAD + 1e-9);
    expect(Math.max(...angles)).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  function spray(rng: Rng): Vec3[] {
    const defs = cloneWeaponDefs();
    const out: Vec3[] = [];
    for (const def of [defs.splatter, defs.spritzer]) {
      const ws = createWeaponState(def.stats);
      const dirs: Vec3[] = [];
      for (let i = 0; i < 20; i++) {
        const info = fireShot(ws, def, aim, moving(MAX * 0.8, { onGround: i % 3 !== 0 }), rng, dirs);
        for (let p = 0; p < info.pellets; p++) out.push({ ...dirs[p]! });
      }
    }
    return out;
  }

  it('same seed gives identical shot directions', () => {
    expect(spray(createRng(1234))).toEqual(spray(createRng(1234)));
  });

  it('a different seed gives different directions', () => {
    expect(spray(createRng(1234))).not.toEqual(spray(createRng(4321)));
  });
});

describe('aimDirection', () => {
  it('returns unit vectors and matches viewForward with no offset', () => {
    const d = aimDirection(vec3(), 1.1, 0.4, 0.05, -0.03);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
    expect(aimDirection(vec3(), 1.1, 0.4)).toEqual(viewForward(vec3(), 1.1, 0.4));
  });

  it('offsets right and up relative to the view', () => {
    // looking down -Z: right is +X, up is +Y
    const d = aimDirection(vec3(), 0, 0, 0.1, 0.2);
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBeGreaterThan(0);
    expect(d.z).toBeLessThan(0);
  });
});
