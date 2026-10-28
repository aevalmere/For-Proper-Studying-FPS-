import { describe, expect, it } from 'vitest';
import { ARENA_DECOR, Buttons, LOADOUT, TICK_RATE, emptyCmd } from '@splat/shared';
import { NOMINAL_SECONDS, SEGMENTS, schedule, segmentAt } from './scenario.ts';

describe('bench scenario', () => {
  it('scales recorded segments to the requested length; warmup stays fixed', () => {
    const plan = schedule(SEGMENTS, 12, TICK_RATE);
    const recorded = plan.filter((s) => !s.seg.warmup).reduce((n, s) => n + s.ticks, 0);
    expect(recorded / TICK_RATE).toBeCloseTo(12, 0);
    const warm = plan.find((s) => s.seg.warmup)!;
    expect(warm.ticks).toBe(Math.round(warm.seg.seconds * TICK_RATE));
    const nominal = schedule(SEGMENTS, 0, TICK_RATE).filter((s) => !s.seg.warmup).reduce((n, s) => n + s.ticks, 0);
    expect(nominal / TICK_RATE).toBeCloseTo(NOMINAL_SECONDS, 0);
  });

  it('segments tile the timeline with no gaps', () => {
    const plan = schedule(SEGMENTS, 0, TICK_RATE);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.startTick).toBe(plan[i - 1]!.startTick + plan[i - 1]!.ticks);
    const end = plan[plan.length - 1]!.startTick + plan[plan.length - 1]!.ticks;
    expect(segmentAt(plan, 0)!.index).toBe(0);
    expect(segmentAt(plan, end - 1)).not.toBeNull();
    expect(segmentAt(plan, end)).toBeNull();
  });

  it('uses valid teleports, inputs and markers, and fires every marker', () => {
    const cmd = emptyCmd();
    const view = { yaw: 0, pitch: 0 };
    const weaponsFired = new Set<number>();
    for (const seg of SEGMENTS) {
      expect(seg.teleport).toBeGreaterThanOrEqual(0);
      expect(seg.teleport).toBeLessThan(ARENA_DECOR.teleports.length);
      for (let t = 0; t < seg.seconds; t += 1 / TICK_RATE) {
        seg.cmd(t, cmd);
        seg.view(t, 0, view);
        expect(Math.abs(cmd.forward)).toBeLessThanOrEqual(1);
        expect(Math.abs(cmd.side)).toBeLessThanOrEqual(1);
        expect(cmd.weapon).toBeGreaterThanOrEqual(0);
        expect(cmd.weapon).toBeLessThan(LOADOUT.length);
        expect(Math.abs(view.pitch)).toBeLessThan(Math.PI / 2);
        if (cmd.buttons & Buttons.FIRE) weaponsFired.add(cmd.weapon);
      }
    }
    expect(weaponsFired.size).toBe(LOADOUT.length);
  });

  it('is a pure function of time (same content on fast and slow machines)', () => {
    const a = emptyCmd();
    const b = emptyCmd();
    for (const seg of SEGMENTS) {
      seg.cmd(1.234, a);
      seg.cmd(1.234, b);
      expect(a).toEqual(b);
    }
  });
});
