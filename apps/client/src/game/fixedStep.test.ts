import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@splat/shared';
import { MAX_FRAME_DT, MAX_STEPS_PER_FRAME, planSteps, stepAlpha, type FixedStep } from './fixedStep.ts';

/**
 * The camera shows the state between the previous and the current tick, so the
 * moment on screen is (ticks - 1 + alpha) * dt. For motion to be judder-free that
 * moment has to advance by exactly the frame time every frame, whatever the beat
 * between the display rate and the 64 Hz tick.
 */
function run(hz: number, seconds: number, jitterMs = 0) {
  const s: FixedStep = { acc: 0 };
  let ticks = 0;
  const shown: number[] = [];
  const frameDts: number[] = [];
  const steps: number[] = [];
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) {
    // alternating early/late frames, like jittery rAF timestamps
    const dt = 1 / hz + (i % 2 ? -jitterMs : jitterMs) / 1000;
    const n = planSteps(s, dt, TICK_DT);
    ticks += n;
    steps.push(n);
    frameDts.push(dt);
    shown.push((ticks - 1 + stepAlpha(s, TICK_DT)) * TICK_DT);
  }
  return { shown, frameDts, steps, ticks };
}

describe('fixed step + interpolation', () => {
  for (const hz of [60, 120, 144, 240, 30]) {
    it(`advances the shown sim time by exactly the frame time at ${hz} Hz`, () => {
      const { shown, frameDts } = run(hz, 5);
      for (let i = 1; i < shown.length; i++) {
        expect(shown[i]! - shown[i - 1]!).toBeCloseTo(frameDts[i]!, 9);
      }
    });
  }

  it('runs 64 ticks per second of frames on average at 60 Hz (some frames run 2)', () => {
    const { steps, ticks } = run(60, 10);
    expect(ticks).toBeGreaterThanOrEqual(639);
    expect(ticks).toBeLessThanOrEqual(640);
    expect(Math.max(...steps)).toBe(2);
    expect(Math.min(...steps.slice(1))).toBe(1);
  });

  it('runs 0 or 1 tick per frame at 144 Hz, never 2', () => {
    const { steps } = run(144, 5);
    expect(Math.max(...steps)).toBe(1);
    expect(steps.filter((n) => n === 0).length).toBeGreaterThan(0);
  });

  it('follows jittery frame timestamps without drifting', () => {
    const { shown, frameDts } = run(60, 5, 1.5);
    let wall = 0;
    for (let i = 1; i < shown.length; i++) {
      wall += frameDts[i]!;
      expect(shown[i]! - shown[0]!).toBeCloseTo(wall, 9);
    }
  });

  it('keeps alpha in [0, 1)', () => {
    const s: FixedStep = { acc: 0 };
    for (let i = 0; i < 2000; i++) {
      planSteps(s, 1 / 144 + (i % 7) * 0.0003, TICK_DT);
      const a = stepAlpha(s, TICK_DT);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('caps a long frame (tab switch, breakpoint) instead of fast-forwarding', () => {
    const s: FixedStep = { acc: 0 };
    expect(planSteps(s, 5, TICK_DT)).toBe(MAX_STEPS_PER_FRAME);
    expect(s.acc).toBeLessThan(TICK_DT);
    // a quarter second clamps to MAX_FRAME_DT worth of ticks, then the step cap
    const s2: FixedStep = { acc: 0 };
    expect(planSteps(s2, MAX_FRAME_DT, TICK_DT)).toBe(Math.min(MAX_STEPS_PER_FRAME, Math.floor(MAX_FRAME_DT / TICK_DT)));
  });

  it('ignores negative and zero frame times', () => {
    const s: FixedStep = { acc: 0 };
    expect(planSteps(s, -1, TICK_DT)).toBe(0);
    expect(planSteps(s, 0, TICK_DT)).toBe(0);
    expect(s.acc).toBe(0);
  });

  it('runs exactly one tick for a frame of exactly one tick', () => {
    const s: FixedStep = { acc: 0 };
    for (let i = 0; i < 640; i++) expect(planSteps(s, TICK_DT, TICK_DT)).toBe(1);
  });
});
