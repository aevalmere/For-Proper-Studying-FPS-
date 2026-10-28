import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants.ts';
import { type Vec3, vec3 } from './math.ts';
import { buildCollisionWorld } from './world/collision.ts';
import {
  ballisticPosition,
  segmentVsBox,
  spawnProjectile,
  stepProjectile,
  stepProjectiles,
  type HitBox,
  type Projectile,
  type ProjectileHit,
} from './projectile.ts';
import { WEAPONS, type WeaponStats } from './weapons.ts';

const empty = buildCollisionWorld({ brushes: [] });

function ball(over: Partial<WeaponStats>, origin: Vec3, dir: Vec3, owner = 0): Projectile {
  return spawnProjectile(1, owner, 'splatter', { ...WEAPONS.splatter.stats, ...over }, origin, dir);
}

/** Step until the ball hits or expires; returns the hit (or null) and the ticks taken. */
function fly(p: Projectile, world = empty, targets: HitBox[] = [], maxTicks = 1000): { hit: ProjectileHit | null; ticks: number } {
  for (let t = 1; t <= maxTicks; t++) {
    const hit = stepProjectile(p, world, targets, TICK_DT);
    if (hit) return { hit, ticks: t };
    if (p.age >= p.lifetime) return { hit: null, ticks: t };
  }
  return { hit: null, ticks: maxTicks };
}

describe('ballistics', () => {
  it('drop matches the analytic arc', () => {
    const g = 800;
    const speed = 2000;
    const p = ball({ ballGravity: g, ballSpeed: speed, ballDrag: 0, ballLifetime: 10 }, vec3(0, 100, 0), vec3(0, 0, -1));
    for (let t = 0; t < 64; t++) stepProjectile(p, empty, [], TICK_DT);
    const T = 64 * TICK_DT;
    expect(p.pos.z).toBeCloseTo(-speed * T, 6);
    expect(p.pos.y).toBeCloseTo(100 - 0.5 * g * T * T, 6);
    expect(p.vel.y).toBeCloseTo(-g * T, 6);
  });

  it('follows a launched arc back down to its starting height', () => {
    const g = 900;
    const v = 1000;
    const dir = vec3(0, Math.SQRT1_2, -Math.SQRT1_2);
    const p = ball({ ballGravity: g, ballSpeed: v, ballLifetime: 10 }, vec3(), dir);
    // flight time to return to y=0 is 2·vy/g; range is vx·t
    const vy = v * Math.SQRT1_2;
    const tFlight = (2 * vy) / g;
    const ticks = Math.round(tFlight / TICK_DT);
    for (let t = 0; t < ticks; t++) stepProjectile(p, empty, [], TICK_DT);
    const expected = ballisticPosition(vec3(), vec3(), { x: 0, y: vy, z: -vy }, g, 0, ticks * TICK_DT);
    expect(p.pos.y).toBeCloseTo(expected.y, 6);
    expect(p.pos.z).toBeCloseTo(expected.z, 6);
    expect(Math.abs(p.pos.y)).toBeLessThan(vy * TICK_DT);
  });

  it('drag shortens range and matches its closed form', () => {
    const fast = ball({ ballDrag: 0, ballGravity: 0, ballSpeed: 2600, ballLifetime: 10 }, vec3(), vec3(1, 0, 0));
    const dragged = ball({ ballDrag: 3, ballGravity: 0, ballSpeed: 2600, ballLifetime: 10 }, vec3(), vec3(1, 0, 0));
    for (let t = 0; t < 64; t++) {
      stepProjectile(fast, empty, [], TICK_DT);
      stepProjectile(dragged, empty, [], TICK_DT);
    }
    // x(t) = v0·(1 - e^(-k t)) / k
    expect(dragged.pos.x).toBeCloseTo((2600 * (1 - Math.exp(-3))) / 3, 6);
    expect(dragged.pos.x).toBeLessThan(fast.pos.x * 0.5);
  });

  it('expires after its lifetime', () => {
    const p = ball({ ballLifetime: 0.25 }, vec3(), vec3(0, 0, -1));
    const { hit, ticks } = fly(p);
    expect(hit).toBeNull();
    expect(ticks).toBe(16);
  });

  it('removes hit and expired balls from the live list', () => {
    const balls = [ball({ ballLifetime: 0.1 }, vec3(), vec3(0, 0, -1)), ball({ ballLifetime: 5 }, vec3(), vec3(0, 0, -1))];
    const hits: ProjectileHit[] = [];
    for (let t = 0; t < 10; t++) stepProjectiles(balls, empty, [], TICK_DT, hits);
    expect(balls).toHaveLength(1);
    expect(balls[0]!.lifetime).toBe(5);
    expect(hits).toHaveLength(0);
  });
});

describe('world hits', () => {
  const walls = buildCollisionWorld({
    brushes: [
      // thick wall facing +Z at z = -500
      { shape: { kind: 'box', min: vec3(-200, 0, -600), max: vec3(200, 200, -500) }, color: 0 },
      // 1 u thin wall facing -X at x = 300
      { shape: { kind: 'box', min: vec3(300, 0, -200), max: vec3(301, 200, 200) }, color: 0 },
    ],
  });

  it('stops at a wall and reports its normal', () => {
    const p = ball({ ballGravity: 0 }, vec3(0, 100, 0), vec3(0, 0, -1));
    const { hit } = fly(p, walls);
    expect(hit?.kind).toBe('world');
    expect(hit!.normal).toEqual(vec3(0, 0, 1));
    expect(hit!.point.z).toBeCloseTo(-500, 1);
    expect(hit!.point.z).toBeGreaterThanOrEqual(-500);
    expect(hit!.brush).toBe(0);
    expect(p.pos).toEqual(hit!.point);
  });

  it('does not tunnel through a thin wall at high speed', () => {
    // 20000 u/s covers ~312 u per tick, far more than the wall's 1 u
    const p = ball({ ballGravity: 0, ballSpeed: 20000 }, vec3(0, 100, 0), vec3(1, 0, 0));
    const { hit, ticks } = fly(p, walls);
    expect(ticks).toBe(1);
    expect(hit?.kind).toBe('world');
    expect(hit!.normal).toEqual(vec3(-1, 0, 0));
    expect(hit!.point.x).toBeCloseTo(300, 1);
  });

  it('splats in place when spawned inside a brush', () => {
    const p = ball({ ballGravity: 0 }, vec3(0, 100, -550), vec3(0, 0, -1));
    const hit = stepProjectile(p, walls, [], TICK_DT);
    expect(hit?.kind).toBe('world');
    expect(hit!.point).toEqual(vec3(0, 100, -550));
    // faces back toward the shooter
    expect(hit!.normal.z).toBeCloseTo(1, 12);
    expect(Math.hypot(hit!.normal.x, hit!.normal.y)).toBeCloseTo(0, 12);
  });
});

describe('target hits', () => {
  const dummy = (id: number, pos: Vec3): HitBox => ({ id, pos, mins: vec3(-16, 0, -16), maxs: vec3(16, 72, 16) });

  it('hits a dummy AABB and reports which one', () => {
    const p = ball({ ballGravity: 0, ballRadius: 0 }, vec3(0, 40, 0), vec3(0, 0, -1));
    const targets = [dummy(7, vec3(200, 0, -700)), dummy(8, vec3(0, 0, -700))];
    const { hit } = fly(p, empty, targets);
    expect(hit?.kind).toBe('target');
    expect(hit!.target).toBe(8);
    expect(hit!.normal).toEqual(vec3(0, 0, 1));
    expect(hit!.point.z).toBeCloseTo(-700 + 16, 6);
  });

  it('pads the hitbox by the ball radius', () => {
    const graze = (radius: number) => {
      const p = ball({ ballGravity: 0, ballRadius: radius }, vec3(17.5, 40, 0), vec3(0, 0, -1));
      return fly(p, empty, [dummy(1, vec3(0, 0, -300))]).hit;
    };
    expect(graze(0)).toBeNull();
    expect(graze(2)?.target).toBe(1);
  });

  it('hits whichever of wall and target comes first', () => {
    const world = buildCollisionWorld({
      brushes: [{ shape: { kind: 'box', min: vec3(-100, 0, -410), max: vec3(100, 200, -400) }, color: 0 }],
    });
    const shoot = (dummyZ: number) => fly(ball({ ballGravity: 0 }, vec3(0, 40, 0), vec3(0, 0, -1)), world, [dummy(3, vec3(0, 0, dummyZ))]).hit;
    expect(shoot(-300)?.kind).toBe('target');
    expect(shoot(-600)?.kind).toBe('world');
  });

  it("ignores the shooter's own hitbox", () => {
    const p = ball({ ballGravity: 0 }, vec3(0, 64, 0), vec3(0, 0, -1), 5);
    const { hit } = fly(p, empty, [dummy(5, vec3(0, 0, 0)), dummy(6, vec3(0, 0, -400))]);
    expect(hit!.target).toBe(6);
  });
});

describe('segmentVsBox', () => {
  const n = vec3();
  it('misses a box beside the segment', () => {
    expect(segmentVsBox(vec3(0, 0, 0), vec3(0, 0, -10), vec3(1, -1, -6), vec3(2, 1, -4), n)).toBe(-1);
  });
  it('misses a box beyond the segment end', () => {
    expect(segmentVsBox(vec3(0, 0, 0), vec3(0, 0, -3), vec3(-1, -1, -6), vec3(1, 1, -4), n)).toBe(-1);
  });
  it('reports the entry fraction and face', () => {
    expect(segmentVsBox(vec3(0, 10, 0), vec3(0, -10, 0), vec3(-1, -1, -1), vec3(1, 1, 1), n)).toBeCloseTo(0.45, 12);
    expect(n).toEqual(vec3(0, 1, 0));
  });
});
