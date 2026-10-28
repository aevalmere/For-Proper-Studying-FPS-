import { describe, expect, it } from 'vitest';
import { type Vec3, vec3, RAD2DEG, yawForward } from '../math.ts';
import { buildCollisionWorld, traceBox, traceRay } from '../world/collision.ts';
import { ARENA, ARENA_DECOR, ARENA_HEIGHTS } from './arena.ts';

const world = buildCollisionWorld(ARENA);
const MINS = vec3(-16, 0, -16);
const MAXS = vec3(16, 72, 16);

function standsOnFloor(p: Vec3): { solid: boolean; groundY: number } {
  const start = vec3(p.x, p.y + 1, p.z);
  const solid = traceBox(world, start, start, MINS, MAXS).startSolid;
  const down = traceBox(world, start, vec3(p.x, p.y - 64, p.z), MINS, MAXS);
  return { solid, groundY: down.endPos.y };
}

function slopeDeg(b: (typeof ARENA.brushes)[number]): number {
  const s = b.shape;
  if (s.kind !== 'ramp') return 0;
  const axis = s.up[1] as 'x' | 'z';
  return Math.atan2(s.max.y - s.min.y, s.max[axis] - s.min[axis]) * RAD2DEG;
}

describe('arena brushes', () => {
  it('are well formed', () => {
    for (const b of [...ARENA.brushes, ...ARENA_DECOR.markings]) {
      expect(b.shape.max.x).toBeGreaterThan(b.shape.min.x);
      expect(b.shape.max.y).toBeGreaterThan(b.shape.min.y);
      expect(b.shape.max.z).toBeGreaterThan(b.shape.min.z);
    }
  });

  it('has walkable ramps between 25 and 30 degrees and one too steep to walk', () => {
    const angles = ARENA.brushes.filter((b) => b.shape.kind === 'ramp').map(slopeDeg);
    expect(angles.filter((a) => a >= 25 && a <= 30).length).toBeGreaterThanOrEqual(3);
    // Quake treats a surface as ground when normal.y >= 0.7 (about 45.6 degrees)
    expect(angles.some((a) => Math.cos(a / RAD2DEG) < 0.7)).toBe(true);
  });

  it('has 16-unit steps and the jump / crouch-jump ledges', () => {
    const tops = new Set(ARENA.brushes.map((b) => b.shape.max.y));
    for (let k = 1; k <= 6; k++) expect(tops.has(16 * k)).toBe(true);
    expect(tops.has(ARENA_HEIGHTS.jumpLedge)).toBe(true);
    expect(tops.has(ARENA_HEIGHTS.crouchJumpLedge)).toBe(true);
    // normal jump apex ~45, crouch-jump ~63, step 18
    expect(ARENA_HEIGHTS.jumpLedge).toBeGreaterThan(18);
    expect(ARENA_HEIGHTS.jumpLedge).toBeLessThan(45);
    expect(ARENA_HEIGHTS.crouchJumpLedge).toBeGreaterThan(45);
    expect(ARENA_HEIGHTS.crouchJumpLedge).toBeLessThan(63);
  });

  it('is enclosed by walls taller than anything climbable', () => {
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const tr = traceRay(world, vec3(0, 300, 0), vec3(dx! * 4000, 300, dz! * 4000));
      expect(tr.fraction).toBeLessThan(1);
    }
  });
});

describe('arena spawns and points of interest', () => {
  it('spawns two teams on the floor, clear of solids, facing into the map', () => {
    for (const team of [0, 1]) expect(ARENA.spawns.filter((s) => s.team === team).length).toBeGreaterThanOrEqual(4);
    const f = vec3();
    for (const s of ARENA.spawns) {
      const r = standsOnFloor(s.pos);
      expect(r.solid).toBe(false);
      expect(r.groundY).toBeCloseTo(0, 0);
      yawForward(f, s.yaw);
      // facing toward x=0
      expect(f.x * -Math.sign(s.pos.x)).toBeGreaterThan(0.99);
    }
  });

  it('places teleports clear of solids', () => {
    for (const t of ARENA_DECOR.teleports) {
      const r = standsOnFloor(t.pos);
      expect(r.solid, t.name).toBe(false);
      expect(r.groundY, t.name).toBeCloseTo(t.pos.y, 0);
    }
  });

  it('has 6-10 target dummies, 128+ apart, on open floor', () => {
    const d = ARENA.dummySpawns;
    expect(d.length).toBeGreaterThanOrEqual(6);
    expect(d.length).toBeLessThanOrEqual(10);
    for (let i = 0; i < d.length; i++) {
      expect(standsOnFloor(d[i]!).solid).toBe(false);
      for (let j = i + 1; j < d.length; j++) {
        expect(Math.hypot(d[i]!.x - d[j]!.x, d[i]!.z - d[j]!.z)).toBeGreaterThanOrEqual(128);
      }
    }
  });

  it('has a clear sightline along the length of the map', () => {
    for (const y of [36, 64]) {
      const tr = traceRay(world, vec3(-1500, y, -896), vec3(1500, y, -896));
      expect(tr.fraction).toBe(1);
    }
  });
});

describe('study booths', () => {
  it('has one enclosed booth per team with a single doorway', () => {
    expect(ARENA.zones.map((z) => z.team).sort()).toEqual([0, 1]);
    for (const zone of ARENA.zones) {
      expect(zone.kind).toBe('studyBooth');
      const c = vec3((zone.min.x + zone.max.x) / 2, 0, (zone.min.z + zone.max.z) / 2);
      expect(standsOnFloor(c).solid).toBe(false);
      // roof overhead
      expect(traceRay(world, vec3(c.x, 40, c.z), vec3(c.x, 400, c.z)).fraction).toBeLessThan(1);
      // count open directions at chest height from the middle of the booth
      let open = 0;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const tr = traceRay(world, vec3(c.x, 48, c.z), vec3(c.x + Math.cos(a) * 400, 48, c.z + Math.sin(a) * 400));
        if (tr.fraction === 1 || Math.hypot(tr.endPos.x - c.x, tr.endPos.z - c.z) > 150) open++;
      }
      expect(open).toBeGreaterThanOrEqual(1);
      expect(open).toBeLessThanOrEqual(3);
    }
  });
});
