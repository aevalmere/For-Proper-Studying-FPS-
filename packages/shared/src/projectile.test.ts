import { describe, expect, it } from 'vitest';
import { TICK_DT } from './constants.ts';
import { type Vec3, vec3 } from './math.ts';
import { buildCollisionWorld } from './world/collision.ts';
import { MOVEMENT_PRESETS, type MovementConfig } from './movement/config.ts';
import { createPlayerState } from './movement/pmove.ts';
import {
  ballisticPosition,
  createHitCapsule,
  playerHitCapsule,
  segmentVsBox,
  spawnProjectile,
  stepProjectile,
  stepProjectiles,
  sweptSphereVsCapsule,
  type HitCapsule,
  type Projectile,
  type ProjectileHit,
} from './projectile.ts';
import { WEAPONS, type WeaponStats } from './weapons.ts';

const empty = buildCollisionWorld({ brushes: [] });

function ball(over: Partial<WeaponStats>, origin: Vec3, dir: Vec3, owner = 0): Projectile {
  return spawnProjectile(1, owner, 'splatter', { ...WEAPONS.splatter.stats, ...over }, origin, dir);
}

/** Step until the ball hits or expires; returns the hit (or null) and the ticks taken. */
function fly(p: Projectile, world = empty, targets: HitCapsule[] = [], maxTicks = 1000): { hit: ProjectileHit | null; ticks: number } {
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
  const dummy = (id: number, pos: Vec3): HitCapsule => createHitCapsule(id, pos, 16, 72);

  it('hits a dummy capsule and reports which one', () => {
    const p = ball({ ballGravity: 0, ballRadius: 0 }, vec3(0, 40, 0), vec3(0, 0, -1));
    const targets = [dummy(7, vec3(200, 0, -700)), dummy(8, vec3(0, 0, -700))];
    const { hit } = fly(p, empty, targets);
    expect(hit?.kind).toBe('target');
    expect(hit!.target).toBe(8);
    expect(hit!.normal).toEqual(vec3(0, 0, 1));
    expect(hit!.point.z).toBeCloseTo(-700 + 16, 6);
    expect(hit!.zone).toBe('body');
  });

  it('reports the contact point on the capsule surface, with the ball center one radius out', () => {
    const p = ball({ ballGravity: 0, ballRadius: 3 }, vec3(0, 40, 0), vec3(0, 0, -1));
    const { hit } = fly(p, empty, [dummy(2, vec3(0, 0, -400))]);
    expect(hit!.point.z).toBeCloseTo(-400 + 16, 9);
    expect(p.pos.z).toBeCloseTo(-400 + 16 + 3, 9);
  });

  it('adds hitRadiusBonus against targets only', () => {
    const shot = (bonus: number) => ball({ ballGravity: 0, ballRadius: 1, hitRadiusBonus: bonus }, vec3(18, 40, 0), vec3(0, 0, -1));
    expect(fly(shot(0), empty, [dummy(1, vec3(0, 0, -300))]).hit).toBeNull();
    expect(fly(shot(1.5), empty, [dummy(1, vec3(0, 0, -300))]).hit?.target).toBe(1);
    // the world still sees only the ball's center
    const wall = buildCollisionWorld({
      brushes: [{ shape: { kind: 'box', min: vec3(20, 0, -400), max: vec3(40, 200, -100) }, color: 0 }],
    });
    expect(fly(shot(5), wall).hit).toBeNull();
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

  it('sweeps against a moving target, not its end-of-tick spot', () => {
    // one tick: the ball flies 100 u down -z; the target slides 40 u along x
    const p = (startZ: number) => ball({ ballGravity: 0, ballSpeed: 6400, ballRadius: 2 }, vec3(0, 36, startZ), vec3(0, 0, -1));
    const moving = (fromX: number, toX: number) => {
      const c = dummy(4, vec3(toX, 0, 50));
      c.prevPos.x = fromX;
      return c;
    };
    // ends the tick dead centre, but was still ~18.5 u away when the ball crossed: miss
    expect(stepProjectile(p(100), empty, [moving(-40, 0)], TICK_DT)).toBeNull();
    // ends the tick 40 u away, but was in the path when the ball crossed: hit
    const hit = stepProjectile(p(60), empty, [moving(0, 40)], TICK_DT);
    expect(hit?.target).toBe(4);
    // a teleport is not swept
    expect(stepProjectile(p(60), empty, [moving(-4000, 40)], TICK_DT)).toBeNull();
  });

  it("ignores the shooter's own hitbox", () => {
    const p = ball({ ballGravity: 0 }, vec3(0, 64, 0), vec3(0, 0, -1), 5);
    const { hit } = fly(p, empty, [dummy(5, vec3(0, 0, 0)), dummy(6, vec3(0, 0, -400))]);
    expect(hit!.target).toBe(6);
  });
});

describe('sweptSphereVsCapsule', () => {
  const n = vec3();
  const cap = createHitCapsule(1, vec3(0, 0, 0), 16, 72);
  const R = 2;

  /** A 800 u pass at height `y`, `offset` u sideways of the axis, coming in from `angleDeg` around it. */
  function pass(angleDeg: number, offset: number, y: number): { start: Vec3; end: Vec3 } {
    const a = (angleDeg * Math.PI) / 180;
    // incoming direction (toward the axis) and its sideways perpendicular, both horizontal
    const dir = vec3(-Math.sin(a), 0, -Math.cos(a));
    const side = vec3(Math.cos(a), 0, -Math.sin(a));
    const start = vec3(-dir.x * 400 + side.x * offset, y, -dir.z * 400 + side.z * offset);
    return { start, end: vec3(start.x + dir.x * 800, y, start.z + dir.z * 800) };
  }

  function approach(angleDeg: number, offset: number, y: number, target: HitCapsule = cap): number {
    const { start, end } = pass(angleDeg, offset, y);
    return sweptSphereVsCapsule(start, end, R, target, n);
  }

  it('counts a hit at exactly capsule radius + ball radius and misses just beyond', () => {
    expect(approach(0, 18, 36)).toBeGreaterThan(0);
    expect(approach(0, 18.01, 36)).toBe(-1);
    expect(approach(0, -18, 36)).toBeGreaterThan(0);
    expect(approach(0, -18.01, 36)).toBe(-1);
    // over the head (a hemisphere of radius 16 centred 56 u up) and under the feet
    expect(approach(0, 0, 72 + R)).toBeGreaterThan(0);
    expect(approach(0, 0, 72 + R + 0.01)).toBe(-1);
    expect(approach(0, 0, -R)).toBeGreaterThan(0);
    expect(approach(0, 0, -R - 0.01)).toBe(-1);
  });

  it('is the same volume seen from 0° and 45°, unlike the old AABB', () => {
    for (let offset = -19; offset <= 19; offset += 0.25) {
      for (const y of [-1, 10, 36, 60, 70, 73.5]) {
        const head = approach(0, offset, y);
        const diag = approach(45, offset, y);
        expect(diag >= 0).toBe(head >= 0);
        // fractions of an 800 u pass: 1e-6 is under a thousandth of a unit
        if (head >= 0) expect(diag).toBeCloseTo(head, 6);
      }
    }
    // a ±16 u box grown by the ball radius reaches 18·√2 ≈ 25.5 u out along its diagonal
    const { start, end } = pass(45, 22, 36);
    expect(segmentVsBox(start, end, vec3(-16 - R, -R, -16 - R), vec3(16 + R, 72 + R, 16 + R), n)).toBeGreaterThanOrEqual(0);
    expect(approach(45, 22, 36)).toBe(-1);
  });

  it('reports the entry fraction and an outward normal', () => {
    expect(sweptSphereVsCapsule(vec3(0, 36, 100), vec3(0, 36, 0), R, cap, n)).toBeCloseTo((100 - 18) / 100, 12);
    expect(n).toEqual(vec3(0, 0, 1));
    // straight down onto the head
    expect(sweptSphereVsCapsule(vec3(0, 200, 0), vec3(0, 0, 0), R, cap, n)).toBeCloseTo((200 - 74) / 200, 12);
    expect(n.y).toBeCloseTo(1, 12);
  });

  it('a fast ball does not tunnel through', () => {
    // 20000 u/s covers ~312 u per tick, so both ends of the step are well clear of the capsule
    const p = ball({ ballGravity: 0, ballSpeed: 20000, ballRadius: R }, vec3(0, 36, 150), vec3(0, 0, -1));
    const hit = stepProjectile(p, empty, [cap], TICK_DT);
    expect(hit?.kind).toBe('target');
    expect(hit!.point.z).toBeCloseTo(16, 6);
  });

  it('misses when moving away or stopping short, and touches at the end of the step', () => {
    expect(sweptSphereVsCapsule(vec3(0, 36, 30), vec3(0, 36, 100), R, cap, n)).toBe(-1);
    expect(sweptSphereVsCapsule(vec3(0, 36, 100), vec3(0, 36, 19), R, cap, n)).toBe(-1);
    expect(sweptSphereVsCapsule(vec3(0, 36, 100), vec3(0, 36, 18), R, cap, n)).toBeCloseTo(1, 12);
  });

  it('hits at 0 when the ball starts overlapping', () => {
    expect(sweptSphereVsCapsule(vec3(5, 36, 0), vec3(5, 36, -100), R, cap, n)).toBe(0);
    expect(n).toEqual(vec3(1, 0, 0));
  });

  it('a ducked player is a shorter target', () => {
    const cfg = Object.values(MOVEMENT_PRESETS)[0] as MovementConfig;
    const s = createPlayerState(vec3(0, 0, 0));
    const standing = playerHitCapsule(createHitCapsule(1, vec3(), 0, 0), s, cfg);
    s.ducked = true;
    const ducked = playerHitCapsule(createHitCapsule(1, vec3(), 0, 0), s, cfg);
    expect(standing.radius).toBe(cfg.hullWidth / 2);
    expect(standing.height).toBe(cfg.standHeight);
    expect(ducked.height).toBe(cfg.duckHeight);
    const y = (cfg.duckHeight + cfg.standHeight) / 2;
    expect(approach(0, 0, y, standing)).toBeGreaterThan(0);
    expect(approach(0, 0, y, ducked)).toBe(-1);
    expect(approach(0, 0, cfg.duckHeight + R, ducked)).toBeGreaterThan(0);
  });
});

describe('recycling', () => {
  it('spawnProjectile reuses a spent ball in place', () => {
    const a = ball({}, vec3(1, 2, 3), vec3(0, 0, -1));
    a.age = 1.5;
    const b = spawnProjectile(9, 4, 'lobber', WEAPONS.lobber.stats, vec3(5, 6, 7), vec3(1, 0, 0), a);
    expect(b).toBe(a);
    expect(b).toEqual(spawnProjectile(9, 4, 'lobber', WEAPONS.lobber.stats, vec3(5, 6, 7), vec3(1, 0, 0)));
  });

  it('stepProjectiles reuses hit objects, returns the count, and reports expired balls', () => {
    const wall = buildCollisionWorld({
      brushes: [{ shape: { kind: 'box', min: vec3(-50, 0, -60), max: vec3(50, 200, -50) }, color: 0 }],
    });
    const hits: ProjectileHit[] = [];
    const expired: Projectile[] = [];
    const volley = () => [
      ball({ ballGravity: 0 }, vec3(0, 40, 0), vec3(0, 0, -1)),
      ball({ ballGravity: 0, ballLifetime: TICK_DT }, vec3(0, 40, 0), vec3(0, 0, 1)),
    ];
    const balls = volley();
    expect(stepProjectiles(balls, wall, [], TICK_DT, hits, expired)).toBe(1);
    const first = hits[0]!;
    expect(first.kind).toBe('world');
    expect(expired).toHaveLength(1);
    expect(balls).toHaveLength(0);
    balls.push(...volley());
    expect(stepProjectiles(balls, wall, [], TICK_DT, hits, expired)).toBe(1);
    expect(hits[0]).toBe(first);
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
