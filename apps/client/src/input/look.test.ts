import { describe, expect, it } from 'vitest';
import { DEG2RAD } from '@splat/shared';
import { applyMouseLook, PITCH_LIMIT } from './look.ts';
import { horizontalFov, verticalFovFromCs } from '../render/fov.ts';
import { planSteps, stepAlpha } from '../game/fixedStep.ts';
import { defaultQuality, defaultSettings, mergeSettings } from '../settings.ts';

describe('applyMouseLook', () => {
  it('turns sensitivity * 0.022 degrees per count, like CS', () => {
    const v = { yaw: 0, pitch: 0 };
    // sens 2: 360 degrees = 360 / (2 * 0.022) counts
    applyMouseLook(v, 360 / (2 * 0.022) / 4, 0, 2);
    expect(v.yaw).toBeCloseTo(-90 * DEG2RAD, 9);
  });

  it('mouse right turns right (negative yaw), mouse down looks down', () => {
    const v = { yaw: 0, pitch: 0 };
    applyMouseLook(v, 10, 10, 1);
    expect(v.yaw).toBeLessThan(0);
    expect(v.pitch).toBeLessThan(0);
    const inv = { yaw: 0, pitch: 0 };
    applyMouseLook(inv, 0, 10, 1, true);
    expect(inv.pitch).toBeGreaterThan(0);
  });

  it('clamps pitch to 89 degrees and wraps yaw', () => {
    const v = { yaw: 0, pitch: 0 };
    applyMouseLook(v, 0, -1e6, 1);
    expect(v.pitch).toBe(PITCH_LIMIT);
    applyMouseLook(v, -1e5, 0, 3);
    expect(v.yaw).toBeLessThanOrEqual(Math.PI);
    expect(v.yaw).toBeGreaterThan(-Math.PI);
  });
});

describe('fov', () => {
  it('converts CS 4:3 horizontal FOV to vertical', () => {
    expect(verticalFovFromCs(90)).toBeCloseTo(73.74, 2);
    expect(horizontalFov(verticalFovFromCs(90), 4 / 3)).toBeCloseTo(90, 6);
    // 16:9 sees about 106 degrees, as in CS:GO
    expect(horizontalFov(verticalFovFromCs(90), 16 / 9)).toBeCloseTo(106.26, 1);
  });
});

describe('planSteps', () => {
  const dt = 1 / 64;
  it('runs whole ticks and leaves the remainder as alpha', () => {
    const s = { acc: 0 };
    expect(planSteps(s, 1 / 60, dt)).toBe(1);
    expect(stepAlpha(s, dt)).toBeCloseTo((1 / 60 - dt) / dt, 6);
    let total = 1;
    for (let i = 0; i < 59; i++) total += planSteps(s, 1 / 60, dt);
    expect(total).toBe(64);
  });

  it('caps catch-up after a long stall', () => {
    const s = { acc: 0 };
    expect(planSteps(s, 5, dt)).toBe(8);
    expect(stepAlpha(s, dt)).toBeLessThan(1);
    expect(planSteps(s, 1 / 60, dt)).toBeLessThanOrEqual(2);
  });
});

describe('settings', () => {
  it('defaults to low quality on weak devices', () => {
    expect(defaultQuality({ hardwareConcurrency: 4 })).toBe('low');
    expect(defaultQuality({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: 'Mozilla/5.0 (X11; CrOS x86_64)' })).toBe('low');
    expect(defaultQuality({ hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Windows' })).toBe('high');
  });

  it('merges saved values, ignoring wrong types and unknown enum values', () => {
    const d = defaultSettings('low');
    const s = mergeSettings(d, { sensitivity: 2.5, fov: 'wide', quality: 'ultra', wheel: 'weapon', junk: 1 });
    expect(s.sensitivity).toBe(2.5);
    expect(s.fov).toBe(d.fov);
    expect(s.quality).toBe('low');
    expect(s.wheel).toBe('weapon');
    expect('junk' in s).toBe(false);
  });
});
