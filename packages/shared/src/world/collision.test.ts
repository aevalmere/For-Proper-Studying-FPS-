import { describe, expect, it } from 'vitest';
import { vec3 } from '../math.ts';
import { buildCollisionWorld, traceBox, traceRay, SURFACE_CLIP_EPSILON } from './collision.ts';

const world = buildCollisionWorld({
  brushes: [
    { shape: { kind: 'box', min: vec3(-512, -16, -512), max: vec3(512, 0, 512) }, color: 0 },
    { shape: { kind: 'box', min: vec3(100, 0, -50), max: vec3(150, 100, 50) }, color: 0 },
    // climbs from y=0 at z=0 to y=100 at z=-100 (45 degrees)
    { shape: { kind: 'ramp', min: vec3(-300, 0, -100), max: vec3(-200, 100, 0), up: '-z' }, color: 0 },
  ],
});

const mins = vec3(-16, 0, -16);
const maxs = vec3(16, 72, 16);

describe('traceRay', () => {
  it('passes through empty space', () => {
    const tr = traceRay(world, vec3(0, 50, 0), vec3(0, 50, -400));
    expect(tr.fraction).toBe(1);
    expect(tr.endPos).toEqual(vec3(0, 50, -400));
  });

  it('stops on the floor with an upward normal', () => {
    const tr = traceRay(world, vec3(0, 100, 0), vec3(0, -100, 0));
    expect(tr.fraction).toBeCloseTo(0.5, 2);
    expect(tr.normal).toEqual(vec3(0, 1, 0));
    expect(tr.endPos.y).toBeGreaterThan(0);
  });

  it('hits the ramp slope with a 45 degree normal', () => {
    const tr = traceRay(world, vec3(-250, 200, -50), vec3(-250, -50, -50));
    expect(tr.endPos.y).toBeCloseTo(50, 0);
    expect(tr.normal.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(tr.normal.z).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe('traceBox', () => {
  it('stops the hull short of a wall by its half-width', () => {
    const tr = traceBox(world, vec3(0, 1, 0), vec3(200, 1, 0), mins, maxs);
    expect(tr.endPos.x).toBeCloseTo(100 - 16 - SURFACE_CLIP_EPSILON, 1);
    expect(tr.normal).toEqual(vec3(-1, 0, 0));
  });

  it('reports startSolid when beginning inside a brush', () => {
    const tr = traceBox(world, vec3(125, 10, 0), vec3(125, 10, 10), mins, maxs);
    expect(tr.startSolid).toBe(true);
    expect(tr.allSolid).toBe(true);
  });

  it('lands the hull on the floor', () => {
    const tr = traceBox(world, vec3(0, 10, 0), vec3(0, -10, 0), mins, maxs);
    expect(tr.endPos.y).toBeCloseTo(SURFACE_CLIP_EPSILON, 2);
    expect(tr.normal).toEqual(vec3(0, 1, 0));
  });
});
